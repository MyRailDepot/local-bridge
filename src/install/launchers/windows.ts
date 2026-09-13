import { join } from 'node:path';

interface MinimalChildProcess {
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: number | null) => void): void;
}

export type SpawnFn = (command: string, args: string[]) => MinimalChildProcess;

/**
 * Escapes a value for embedding inside a PowerShell *single-quoted* string literal. PowerShell
 * (unlike POSIX shells) does not use backslash for this — the single-quote escape is a doubled
 * `''`. Every value interpolated into the script below goes through this: `installDir` and
 * `desktopDir` come from the filesystem and Windows paths/usernames can legally contain an
 * apostrophe (e.g. `C:\Users\O'Brien\...`). Skipping this on even one interpolation would let an
 * embedded quote terminate the string early and run the rest of the path as PowerShell code.
 */
function psQuote(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * The PowerShell script that creates the Desktop .lnk shortcut, via the same WScript.Shell COM
 * object Windows' own Explorer uses internally — no new npm dependency, PowerShell ships with
 * every supported Windows version. `/k` (rather than `/c`) keeps the console window open once the
 * bridge starts, so closing that window is what stops it, matching every other OS here.
 */
export function buildShortcutScript(shortcutPath: string, installDir: string, iconPath: string): string {
  const target = `cd /d "${installDir}" && node_modules\\.bin\\local-bridge.cmd`;
  return [
    '$shell = New-Object -ComObject WScript.Shell',
    `$shortcut = $shell.CreateShortcut('${psQuote(shortcutPath)}')`,
    `$shortcut.TargetPath = 'cmd.exe'`,
    `$shortcut.Arguments = '/k ${psQuote(target)}'`,
    `$shortcut.IconLocation = '${psQuote(iconPath)}'`,
    `$shortcut.WorkingDirectory = '${psQuote(installDir)}'`,
    '$shortcut.Save()',
  ].join('\n');
}

/** Runs the shortcut-building PowerShell script via `powershell -NoProfile -Command <script>`. */
export function installWindowsLauncher(
  installDir: string,
  assetsDir: string,
  desktopDir: string,
  spawnImpl: SpawnFn,
): Promise<void> {
  const shortcutPath = join(desktopDir, 'MyRailDepot Bridge.lnk');
  const iconPath = join(assetsDir, 'icon.ico');
  const script = buildShortcutScript(shortcutPath, installDir, iconPath);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl('powershell', ['-NoProfile', '-Command', script]);
    child.on('error', rejectPromise);
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`powershell exited with code ${code} while creating the desktop shortcut`));
    });
  });
}
