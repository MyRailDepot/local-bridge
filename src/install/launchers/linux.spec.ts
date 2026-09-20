import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildDesktopEntry, installLinuxLauncher, resolveLinuxDesktopDir, type ExecFn } from './linux.ts';

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
      '/usr/bin/node',
    );
    assert.match(entry, /Name=MyRailDepot Bridge/);
    assert.match(entry, /Terminal=true/);
    assert.match(entry, /Icon=\/home\/nico\/\.myraildepot\/local-bridge\/icon\.png/);
    assert.match(entry, /cd '\/home\/nico\/\.myraildepot\/local-bridge'/);
    assert.match(entry, /\.\/node_modules\/\.bin\/local-bridge/);
  });

  it('runs local-bridge via the exact node binary given, not env node — a .desktop Exec line runs through a non-interactive shell that never sources .bashrc/.zshrc, so a nvm/fnm-managed node on PATH there would otherwise be invisible', () => {
    const entry = buildDesktopEntry(
      '/home/nico/.myraildepot/local-bridge',
      '/home/nico/.myraildepot/local-bridge/icon.png',
      '/home/nico/.nvm/versions/node/v22.23.2/bin/node',
    );
    assert.match(entry, /'\/home\/nico\/\.nvm\/versions\/node\/v22\.23\.2\/bin\/node' \.\/node_modules\/\.bin\/local-bridge/);
    assert.doesNotMatch(entry, /env node/);
  });

  it('escapes single quotes in the install dir path for bash', () => {
    // Realistic on Linux: usernames/paths can contain an apostrophe, e.g. "/home/o'brien/...".
    // A bash single-quoted string literal escapes an embedded `'` as `'\''` (end quote, escaped quote,
    // start quote) — an unescaped one would terminate the string early and let the rest of the path
    // run as a command.
    const entry = buildDesktopEntry(
      "/home/o'brien/.myraildepot/local-bridge",
      "/home/o'brien/.myraildepot/local-bridge/icon.png",
      '/usr/bin/node',
    );
    assert.match(entry, /cd '\/home\/o'\\''brien\/\.myraildepot\/local-bridge'/);
    assert.match(entry, /Icon=\/home\/o'brien\/\.myraildepot\/local-bridge\/icon\.png/);
  });

  it('escapes single quotes in the node binary path too', () => {
    const entry = buildDesktopEntry(
      '/home/nico/.myraildepot/local-bridge',
      '/home/nico/.myraildepot/local-bridge/icon.png',
      "/home/o'brien/.nvm/versions/node/v22.23.2/bin/node",
    );
    assert.match(entry, /'\/home\/o'\\''brien\/\.nvm\/versions\/node\/v22\.23\.2\/bin\/node'/);
  });
});

describe('resolveLinuxDesktopDir', () => {
  it('uses xdg-user-dir DESKTOP\'s answer, not a hardcoded ~/Desktop — the folder is actually renamed on disk on a localized system (e.g. ~/Bureau in French), unlike Windows where the underlying name stays "Desktop" regardless of UI language', () => {
    const execImpl: ExecFn = (command, args) => {
      assert.equal(command, 'xdg-user-dir');
      assert.deepEqual(args, ['DESKTOP']);
      return '/home/nico/Bureau\n';
    };

    assert.equal(resolveLinuxDesktopDir('/home/nico', execImpl), '/home/nico/Bureau');
  });

  it('falls back to ~/Desktop when xdg-user-dir is unavailable (minimal/server distros without xdg-user-dirs installed)', () => {
    const execImpl: ExecFn = () => { throw new Error('spawn xdg-user-dir ENOENT'); };

    assert.equal(resolveLinuxDesktopDir('/home/nico', execImpl), join('/home/nico', 'Desktop'));
  });

  it('falls back to ~/Desktop when xdg-user-dir returns nothing usable', () => {
    const execImpl: ExecFn = () => '   \n';

    assert.equal(resolveLinuxDesktopDir('/home/nico', execImpl), join('/home/nico', 'Desktop'));
  });
});

describe('installLinuxLauncher', () => {
  it('writes an executable .desktop file to the given desktop directory', () => {
    const installDir = '/fake/install/dir';
    const assetsDir = '/fake/assets/dir';
    const desktopDir = makeTempDir();

    installLinuxLauncher(installDir, assetsDir, desktopDir, '/usr/bin/node');

    const desktopFilePath = join(desktopDir, 'myraildepot-bridge.desktop');
    assert.ok(existsSync(desktopFilePath));
    assert.equal(statSync(desktopFilePath).mode & 0o777, 0o755);
    const content = readFileSync(desktopFilePath, 'utf8');
    assert.match(content, /Icon=\/fake\/assets\/dir\/icon\.png/);
    assert.match(content, /'\/usr\/bin\/node' \.\/node_modules\/\.bin\/local-bridge/);
  });
});
