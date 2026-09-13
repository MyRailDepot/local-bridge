import { describe, it, after } from 'node:test';
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
  it('only runs a background npm update, creates no launcher', async () => {
    const homeDir = makeTempDir();
    const installDir = join(homeDir, '.myraildepot', 'local-bridge');
    const npmCalls: Array<{ args: string[] }> = [];

    await selfInstallIfNeeded({
      currentPackageRoot: installDir,
      assetsDir: makeTempDir(),
      credentials: { bridgeId: 'b1', apiKey: 'k1' },
      platform: 'darwin',
      homeDir,
      npmSpawnImpl: fakeNpmSpawn(npmCalls),
    });

    assert.equal(npmCalls.length, 1);
    assert.deepEqual(npmCalls[0]!.args, ['update', '@myraildepot/local-bridge', '--prefix', installDir]);
    assert.equal(existsSync(join(homeDir, 'Applications', 'MyRailDepot Bridge.app')), false);
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
      npmSpawnImpl: fakeNpmSpawn(npmCalls),
    });

    const installDir = join(homeDir, '.myraildepot', 'local-bridge');
    assert.equal(readFileSync(join(installDir, '.env'), 'utf8'), 'BRIDGE_ID=b1\nBRIDGE_API_KEY=k1\n');
    assert.deepEqual(npmCalls[0]!.args, ['install', '@myraildepot/local-bridge', '--prefix', installDir]);
    // Must land under the *injected* homeDir, never the real developer machine's ~/Applications.
    assert.ok(existsSync(join(homeDir, 'Applications', 'MyRailDepot Bridge.app', 'Contents', 'Info.plist')));
  });
});

describe('selfInstallIfNeeded — ephemeral run (npx), platform linux', () => {
  it('creates the linux .desktop launcher in the injected home dir', async () => {
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

    assert.ok(existsSync(join(homeDir, 'Desktop', 'myraildepot-bridge.desktop')));
  });
});

describe('selfInstallIfNeeded — ephemeral run (npx), platform win32', () => {
  it('invokes the windows launcher via the injected spawn, targeting the injected desktop dir', async () => {
    const homeDir = makeTempDir();
    const assetsDir = makeTempDir();
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

    assert.equal(windowsCalls.length, 1);
    assert.equal(windowsCalls[0]!.command, 'powershell');
    assert.match(windowsCalls[0]!.args[2]!, new RegExp(join(homeDir, 'Desktop').replace(/\\/g, '\\\\')));
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

    await assert.doesNotReject(() => selfInstallIfNeeded({
      currentPackageRoot: '/some/npx/cache/path',
      assetsDir,
      credentials: { bridgeId: 'b1', apiKey: 'k1' },
      platform: 'linux',
      homeDir,
      npmSpawnImpl: failingSpawn,
    }));

    assert.equal(existsSync(join(homeDir, 'Desktop', 'myraildepot-bridge.desktop')), false);
  });
});
