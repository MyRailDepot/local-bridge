import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { buildShortcutScript, installWindowsLauncher, type SpawnFn } from './windows.ts';

describe('buildShortcutScript', () => {
  it('creates a WScript.Shell shortcut pointing at cmd.exe /k cd into the install dir, with the icon set', () => {
    const script = buildShortcutScript(
      'C:\\Users\\nico\\Desktop\\MyRailDepot Bridge.lnk',
      'C:\\Users\\nico\\.myraildepot\\local-bridge',
      'C:\\Users\\nico\\.myraildepot\\local-bridge\\icon.ico',
    );
    assert.match(script, /New-Object -ComObject WScript\.Shell/);
    assert.match(script, /CreateShortcut\('C:\\Users\\nico\\Desktop\\MyRailDepot Bridge\.lnk'\)/);
    assert.match(script, /\$shortcut\.TargetPath = 'cmd\.exe'/);
    assert.match(script, /\/k cd \/d "C:\\Users\\nico\\\.myraildepot\\local-bridge"/);
    assert.match(script, /node_modules\\\.bin\\local-bridge\.cmd/);
    assert.match(script, /\$shortcut\.IconLocation = 'C:\\Users\\nico\\\.myraildepot\\local-bridge\\icon\.ico'/);
  });

  it('doubles embedded single quotes in every interpolated path, for every PowerShell single-quoted string', () => {
    // Realistic on Windows: usernames/paths can contain an apostrophe, e.g. "C:\Users\O'Brien\...".
    // A PowerShell single-quoted string literal escapes an embedded `'` as `''` (not backslash) —
    // an unescaped one would terminate the string early and let the rest of the path run as
    // PowerShell code.
    const script = buildShortcutScript(
      "C:\\Users\\O'Brien\\Desktop\\MyRailDepot Bridge.lnk",
      "C:\\Users\\O'Brien\\.myraildepot\\local-bridge",
      "C:\\Users\\O'Brien\\.myraildepot\\local-bridge\\icon.ico",
    );
    assert.match(script, /CreateShortcut\('C:\\Users\\O''Brien\\Desktop\\MyRailDepot Bridge\.lnk'\)/);
    assert.match(script, /\$shortcut\.IconLocation = 'C:\\Users\\O''Brien\\\.myraildepot\\local-bridge\\icon\.ico'/);
    assert.match(script, /\$shortcut\.WorkingDirectory = 'C:\\Users\\O''Brien\\\.myraildepot\\local-bridge'/);
    assert.match(script, /\/k cd \/d "C:\\Users\\O''Brien\\\.myraildepot\\local-bridge" && node_modules\\\.bin\\local-bridge\.cmd/);
    // No stray unescaped `'` should remain outside of the doubled pairs above.
    const withoutDoubles = script.replace(/''/g, '');
    const singleQuoteCount = (withoutDoubles.match(/'/g) ?? []).length;
    // 2 quotes per assignment statement (CreateShortcut, TargetPath, Arguments, IconLocation,
    // WorkingDirectory) = 10, none of which should be unbalanced by a stray embedded quote.
    assert.equal(singleQuoteCount, 10);
  });
});

describe('installWindowsLauncher', () => {
  it('spawns powershell -NoProfile -Command with the built script', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const child = new EventEmitter();
    const spawnImpl: SpawnFn = (command, args) => {
      calls.push({ command, args });
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    };

    await installWindowsLauncher('C:\\install', 'C:\\assets', 'C:\\Users\\nico\\Desktop', spawnImpl);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, 'powershell');
    assert.deepEqual(calls[0]!.args.slice(0, 2), ['-NoProfile', '-Command']);
    assert.match(calls[0]!.args[2]!, /CreateShortcut/);
  });

  it('rejects when powershell exits non-zero', async () => {
    const child = new EventEmitter();
    const spawnImpl: SpawnFn = () => {
      queueMicrotask(() => child.emit('exit', 1));
      return child;
    };

    await assert.rejects(
      () => installWindowsLauncher('C:\\install', 'C:\\assets', 'C:\\Users\\nico\\Desktop', spawnImpl),
      /powershell exited with code 1/,
    );
  });
});
