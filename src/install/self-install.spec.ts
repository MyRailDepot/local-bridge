import { describe, it, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { selfInstallIfNeeded } from './self-install.ts';
import type { SpawnFn as NpmSpawnFn } from './npm-runner.ts';
import type { SpawnFn as WindowsSpawnFn } from './launchers/windows.ts';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-bridge-self-install-test-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function fakeNpmSpawn(calls: Array<{ args: string[] }>): NpmSpawnFn {
  return (_command, args) => {
    calls.push({ args });
    const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
    child.stderr = new EventEmitter();
    // npm-runner.ts listens on 'close' (not 'exit') so stderr is fully flushed before
    // resolving/rejecting — see npm-runner.spec.ts's own makeFakeChild helper. Emitting 'exit'
    // here (as an earlier draft of this brief did) would leave runNpmInstall's/
    // runNpmUpdateInBackground's promise unresolved forever.
    queueMicrotask(() => child.emit('close', 0));
    return child;
  };
}

describe('selfInstallIfNeeded — already installed (launched via the shortcut)', () => {
  it('only runs a background npm update, creates no launcher, and reports the check', async () => {
    const homeDir = makeTempDir();
    // The real npm layout: the package lives one level below the install prefix
    // (<installDir>/node_modules/@myraildepot/local-bridge), never at installDir itself — see
    // paths.spec.ts for the containment-check test this exercises indirectly.
    const installDir = join(homeDir, '.myraildepot', 'local-bridge');
    const currentPackageRoot = join(installDir, 'node_modules', '@myraildepot', 'local-bridge');
    const npmCalls: Array<{ args: string[] }> = [];
    const logCalls: string[] = [];
    mock.method(console, 'log', (...args: unknown[]) => { logCalls.push(args.join(' ')); });

    try {
      await selfInstallIfNeeded({
        currentPackageRoot,
        assetsDir: makeTempDir(),
        credentials: { bridgeId: 'b1', apiKey: 'k1' },
        platform: 'darwin',
        homeDir,
        npmSpawnImpl: fakeNpmSpawn(npmCalls),
      });

      assert.equal(npmCalls.length, 1);
      assert.deepEqual(npmCalls[0]!.args, ['update', '@myraildepot/local-bridge', '--prefix', installDir]);
      assert.equal(existsSync(join(homeDir, 'Applications', 'MyRailDepot Bridge.app')), false);
      // Regression guard for the "installed branch is dead code" bug: this test's
      // currentPackageRoot deliberately matches npm's real --prefix layout, not installDir
      // itself — with the old equality-only isInstalledCopy, this would have fallen through to
      // the ephemeral branch instead (0 npm calls of 'update', a launcher created here).
      assert.ok(logCalls.some((line) => line.includes('Checking for updates')));
    } finally {
      mock.reset();
    }
  });
});

describe('selfInstallIfNeeded — ephemeral run (npx), platform darwin', () => {
  it('creates the install dir, writes .env, installs, and creates the mac launcher in the injected home dir', async () => {
    const homeDir = makeTempDir();
    const assetsDir = makeTempDir();
    writeFileSync(join(assetsDir, 'icon.icns'), 'fake-icns');
    const npmCalls: Array<{ args: string[] }> = [];

    await selfInstallIfNeeded({
      currentPackageRoot: '/some/npx/cache/path',
      assetsDir,
      credentials: { bridgeId: 'b1', apiKey: 'k1' },
      platform: 'darwin',
      homeDir,
      // A path that doesn't exist, so resolveMacAppsDir falls back to homeDir/Applications —
      // never the real developer machine's system-wide /Applications, which this sandboxed
      // account can usually write to (see mac.spec.ts's resolveMacAppsDir tests for that logic).
      systemAppsDir: join(homeDir, 'no-such-applications-dir'),
      npmSpawnImpl: fakeNpmSpawn(npmCalls),
    });

    const installDir = join(homeDir, '.myraildepot', 'local-bridge');
    assert.equal(readFileSync(join(installDir, '.env'), 'utf8'), 'BRIDGE_ID=b1\nBRIDGE_API_KEY=k1\n');
    assert.deepEqual(npmCalls[0]!.args, ['install', '@myraildepot/local-bridge', '--prefix', installDir]);
    // Must land under the *injected* homeDir, never the real developer machine's ~/Applications.
    assert.ok(existsSync(join(homeDir, 'Applications', 'MyRailDepot Bridge.app', 'Contents', 'Info.plist')));
  });
});

describe('selfInstallIfNeeded — ephemeral run (npx), platform darwin, writable system Applications dir', () => {
  it('creates the mac launcher in the injected system Applications dir, not homeDir/Applications', async () => {
    const homeDir = makeTempDir();
    const systemAppsDir = makeTempDir();
    const assetsDir = makeTempDir();
    writeFileSync(join(assetsDir, 'icon.icns'), 'fake-icns');

    await selfInstallIfNeeded({
      currentPackageRoot: '/some/npx/cache/path',
      assetsDir,
      credentials: { bridgeId: 'b1', apiKey: 'k1' },
      platform: 'darwin',
      homeDir,
      systemAppsDir,
      npmSpawnImpl: fakeNpmSpawn([]),
    });

    assert.ok(existsSync(join(systemAppsDir, 'MyRailDepot Bridge.app', 'Contents', 'Info.plist')));
    assert.equal(existsSync(join(homeDir, 'Applications')), false);
  });
});

describe('selfInstallIfNeeded — ephemeral run (npx), platform linux', () => {
  it('creates the linux .desktop launcher in the injected home dir, with the icon persisted into installDir', async () => {
    const homeDir = makeTempDir();
    const assetsDir = makeTempDir();
    writeFileSync(join(assetsDir, 'icon.png'), 'fake-png');

    await selfInstallIfNeeded({
      currentPackageRoot: '/some/npx/cache/path',
      assetsDir,
      credentials: { bridgeId: 'b1', apiKey: 'k1' },
      platform: 'linux',
      homeDir,
      npmSpawnImpl: fakeNpmSpawn([]),
    });

    const installDir = join(homeDir, '.myraildepot', 'local-bridge');
    assert.ok(existsSync(join(homeDir, 'Desktop', 'myraildepot-bridge.desktop')));
    // Regression guard: the icon must be copied into the persistent install dir, not merely
    // referenced from the ephemeral npx-cache assetsDir it started in — otherwise the shortcut's
    // icon goes blank the moment that cache is pruned.
    assert.equal(readFileSync(join(installDir, 'assets', 'icon.png'), 'utf8'), 'fake-png');
    assert.match(
      readFileSync(join(homeDir, 'Desktop', 'myraildepot-bridge.desktop'), 'utf8'),
      new RegExp(`Icon=${join(installDir, 'assets', 'icon.png').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });
});

describe('selfInstallIfNeeded — ephemeral run (npx), platform win32', () => {
  it('invokes the windows launcher via the injected spawn, targeting the injected desktop dir, with the icon persisted into installDir', async () => {
    const homeDir = makeTempDir();
    const assetsDir = makeTempDir();
    writeFileSync(join(assetsDir, 'icon.ico'), 'fake-ico');
    const windowsCalls: Array<{ command: string; args: string[] }> = [];
    const windowsSpawnImpl: WindowsSpawnFn = (command, args) => {
      windowsCalls.push({ command, args });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    };

    await selfInstallIfNeeded({
      currentPackageRoot: 'C:\\some\\npx\\cache\\path',
      assetsDir,
      credentials: { bridgeId: 'b1', apiKey: 'k1' },
      platform: 'win32',
      homeDir,
      npmSpawnImpl: fakeNpmSpawn([]),
      windowsSpawnImpl,
    });

    const installDir = join(homeDir, '.myraildepot', 'local-bridge');
    assert.equal(windowsCalls.length, 1);
    assert.equal(windowsCalls[0]!.command, 'powershell');
    assert.match(windowsCalls[0]!.args[2]!, new RegExp(join(homeDir, 'Desktop').replace(/\\/g, '\\\\')));
    // Regression guard: same persistence requirement as the Linux case above.
    assert.equal(readFileSync(join(installDir, 'assets', 'icon.ico'), 'utf8'), 'fake-ico');
    assert.match(
      windowsCalls[0]!.args[2]!,
      new RegExp(`IconLocation = '${join(installDir, 'assets', 'icon.ico').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`),
    );
  });
});

describe('selfInstallIfNeeded — install failure', () => {
  it('logs a failure and does not throw when npm install fails', async () => {
    const homeDir = makeTempDir();
    const assetsDir = makeTempDir();
    const failingSpawn: NpmSpawnFn = () => {
      const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
      child.stderr = new EventEmitter();
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('offline'));
        child.emit('close', 1);
      });
      return child;
    };
    const errorCalls: string[] = [];
    mock.method(console, 'error', (...args: unknown[]) => { errorCalls.push(args.join(' ')); });

    try {
      await assert.doesNotReject(() => selfInstallIfNeeded({
        currentPackageRoot: '/some/npx/cache/path',
        assetsDir,
        credentials: { bridgeId: 'b1', apiKey: 'k1' },
        platform: 'linux',
        homeDir,
        npmSpawnImpl: failingSpawn,
      }));

      assert.equal(existsSync(join(homeDir, 'Desktop', 'myraildepot-bridge.desktop')), false);
      // The plan requires a failure here to be reported via printStepFailed (console.error) —
      // an empty catch block would leave the two assertions above green while silently dropping
      // this requirement.
      assert.equal(errorCalls.length, 1);
      assert.match(errorCalls[0]!, /offline/);
    } finally {
      mock.reset();
    }
  });

  it('logs a failure and does not throw when launcher creation throws', async () => {
    const homeDir = makeTempDir();
    // Deliberately do NOT write icon.icns into assetsDir: installMacLauncher's
    // copyFileSync(join(assetsDir, 'icon.icns'), ...) will throw ENOENT.
    const assetsDir = makeTempDir();
    const errorCalls: string[] = [];
    mock.method(console, 'error', (...args: unknown[]) => { errorCalls.push(args.join(' ')); });

    try {
      await assert.doesNotReject(() => selfInstallIfNeeded({
        currentPackageRoot: '/some/npx/cache/path',
        assetsDir,
        credentials: { bridgeId: 'b1', apiKey: 'k1' },
        platform: 'darwin',
        homeDir,
        // See the ephemeral darwin test above: keeps this off the real machine's /Applications.
        systemAppsDir: join(homeDir, 'no-such-applications-dir'),
        npmSpawnImpl: fakeNpmSpawn([]),
      }));

      // installMacLauncher creates the bundle's directory structure before the copyFileSync of
      // icon.icns throws, so the .app directory itself can exist — what must NOT exist is the
      // icon it never got to copy, i.e. the launcher was never fully/successfully installed.
      assert.equal(
        existsSync(join(homeDir, 'Applications', 'MyRailDepot Bridge.app', 'Contents', 'Resources', 'icon.icns')),
        false,
      );
      assert.equal(errorCalls.length, 1);
      assert.match(errorCalls[0]!, /icon\.icns/);
    } finally {
      mock.reset();
    }
  });
});
