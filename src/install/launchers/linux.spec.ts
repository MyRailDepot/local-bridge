import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDesktopEntry, installLinuxLauncher } from './linux.ts';

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-bridge-linux-launcher-test-'));
  tempDirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('buildDesktopEntry', () => {
  it('runs the bridge from the install dir in a visible terminal, with the icon set', () => {
    const entry = buildDesktopEntry(
      '/home/nico/.myraildepot/local-bridge',
      '/home/nico/.myraildepot/local-bridge/icon.png',
    );
    assert.match(entry, /Name=MyRailDepot Bridge/);
    assert.match(entry, /Terminal=true/);
    assert.match(entry, /Icon=\/home\/nico\/\.myraildepot\/local-bridge\/icon\.png/);
    assert.match(entry, /cd '\/home\/nico\/\.myraildepot\/local-bridge'/);
    assert.match(entry, /\.\/node_modules\/\.bin\/local-bridge/);
  });

  it('escapes single quotes in the install dir path for bash', () => {
    // Realistic on Linux: usernames/paths can contain an apostrophe, e.g. "/home/o'brien/...".
    // A bash single-quoted string literal escapes an embedded `'` as `'\''` (end quote, escaped quote,
    // start quote) — an unescaped one would terminate the string early and let the rest of the path
    // run as a command.
    const entry = buildDesktopEntry(
      "/home/o'brien/.myraildepot/local-bridge",
      "/home/o'brien/.myraildepot/local-bridge/icon.png",
    );
    assert.match(entry, /cd '\/home\/o'\\''brien\/\.myraildepot\/local-bridge'/);
    assert.match(entry, /Icon=\/home\/o'brien\/\.myraildepot\/local-bridge\/icon\.png/);
  });
});

describe('installLinuxLauncher', () => {
  it('writes an executable .desktop file to the given desktop directory', () => {
    const installDir = '/fake/install/dir';
    const assetsDir = '/fake/assets/dir';
    const desktopDir = makeTempDir();

    installLinuxLauncher(installDir, assetsDir, desktopDir);

    const desktopFilePath = join(desktopDir, 'myraildepot-bridge.desktop');
    assert.ok(existsSync(desktopFilePath));
    assert.equal(statSync(desktopFilePath).mode & 0o777, 0o755);
    assert.match(readFileSync(desktopFilePath, 'utf8'), /Icon=\/fake\/assets\/dir\/icon\.png/);
  });
});
