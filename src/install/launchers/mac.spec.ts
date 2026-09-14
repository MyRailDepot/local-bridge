import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildInfoPlist, buildLauncherScript, installMacLauncher, resolveMacAppsDir } from './mac.ts';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-bridge-mac-launcher-test-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('buildInfoPlist', () => {
  it('names the bundle and points at icon.icns and the launcher executable', () => {
    const plist = buildInfoPlist();
    assert.match(plist, /<key>CFBundleName<\/key>\s*<string>MyRailDepot Bridge<\/string>/);
    assert.match(plist, /<key>CFBundleIconFile<\/key>\s*<string>icon\.icns<\/string>/);
    assert.match(plist, /<key>CFBundleExecutable<\/key>\s*<string>launcher<\/string>/);
  });
});

describe('buildLauncherScript', () => {
  it('cds into the install dir and runs the bridge inside a Terminal window titled "MyRailDepot Bridge"', () => {
    const script = buildLauncherScript('/Users/nico/.myraildepot/local-bridge');
    assert.match(script, /cd '\/Users\/nico\/\.myraildepot\/local-bridge'/);
    assert.match(script, /\.\/node_modules\/\.bin\/local-bridge/);
    assert.match(script, /set custom title of front window to "MyRailDepot Bridge"/);
  });
});

describe('resolveMacAppsDir', () => {
  it('picks the system Applications dir when this process can write to it', () => {
    const systemAppsDir = makeTempDir();
    const homeDir = makeTempDir();

    assert.equal(resolveMacAppsDir(homeDir, systemAppsDir), systemAppsDir);
  });

  it('falls back to ~/Applications when the system dir is not writable', () => {
    const systemAppsDir = makeTempDir();
    chmodSync(systemAppsDir, 0o500); // read + execute only, no write
    const homeDir = makeTempDir();

    try {
      assert.equal(resolveMacAppsDir(homeDir, systemAppsDir), join(homeDir, 'Applications'));
    } finally {
      chmodSync(systemAppsDir, 0o700); // restore so the `after` hook can remove it
    }
  });
});

describe('installMacLauncher', () => {
  it('writes a complete .app bundle with Info.plist, an executable launcher, and the icon', () => {
    const installDir = '/fake/install/dir';
    const assetsDir = makeTempDir();
    writeFileSync(join(assetsDir, 'icon.icns'), 'fake-icns-bytes');
    const appsDir = makeTempDir();

    installMacLauncher(installDir, assetsDir, appsDir);

    const bundleDir = join(appsDir, 'MyRailDepot Bridge.app');
    assert.ok(existsSync(join(bundleDir, 'Contents', 'Info.plist')));
    const launcherPath = join(bundleDir, 'Contents', 'MacOS', 'launcher');
    assert.ok(existsSync(launcherPath));
    assert.equal(statSync(launcherPath).mode & 0o777, 0o755);
    assert.equal(
      readFileSync(join(bundleDir, 'Contents', 'Resources', 'icon.icns'), 'utf8'),
      'fake-icns-bytes',
    );
  });
});
