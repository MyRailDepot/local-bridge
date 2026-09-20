import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export type ExecFn = (command: string, args: string[]) => string;

const defaultExec: ExecFn = (command, args) => execFileSync(command, args, { encoding: 'utf8' });

/**
 * Resolves the user's real Desktop folder via `xdg-user-dir DESKTOP`. On a localized system
 * (French, German, ...) this is genuinely NOT `~/Desktop` — XDG user-dirs actually relocates the
 * folder on disk (e.g. `~/Bureau` in French), unlike Windows, where the underlying folder name
 * stays "Desktop" regardless of the UI language. Falls back to `~/Desktop` when the command is
 * unavailable (minimal/server distros without xdg-user-dirs installed) or returns nothing usable.
 */
export function resolveLinuxDesktopDir(homeDir: string, execImpl: ExecFn = defaultExec): string {
  try {
    const output = execImpl('xdg-user-dir', ['DESKTOP']).trim();
    if (output) return output;
  } catch { /* xdg-user-dirs not installed — fall back below */ }
  return join(homeDir, 'Desktop');
}

// Escape single quotes in a path by replacing ' with '\''
// This works within double quotes: the \'' becomes a literal \' when interpreted by bash
function escapeForShell(value: string): string {
  return value.replace(/'/g, "'\\''");
}

/**
 * A standard freedesktop .desktop entry. `Terminal=true` so the bridge's output is visible exactly
 * as on the other two OSes. GNOME requires a one-time "Allow Launching" confirmation on a .desktop
 * file created outside a package manager — known, unavoidable, and not solved here.
 *
 * Runs the exact `node` binary given (`nodeBin`, normally `process.execPath` — the one currently
 * executing this installer) rather than relying on `env node` to resolve it from PATH: a
 * `.desktop` file's Exec line is launched by the desktop environment through a non-interactive,
 * non-login shell, which — unlike an actual terminal session — never sources `.bashrc`/`.zshrc`.
 * Any PATH entry added there (as nvm, fnm, etc. commonly do) is invisible to it, so `env node`
 * fails with "No such file or directory" even though `node` works fine from a real terminal.
 */
export function buildDesktopEntry(installDir: string, iconPath: string, nodeBin: string): string {
  const escapedDir = escapeForShell(installDir);
  const escapedNode = escapeForShell(nodeBin);
  const execCommand = `bash -c "cd '${escapedDir}' && '${escapedNode}' ./node_modules/.bin/local-bridge; exec bash"`;
  return `[Desktop Entry]
Type=Application
Name=MyRailDepot Bridge
Exec=${execCommand}
Icon=${iconPath}
Terminal=true
Categories=Utility;
`;
}

/** Writes `~/Desktop/myraildepot-bridge.desktop` (or the resolved localized equivalent), executable. */
export function installLinuxLauncher(installDir: string, assetsDir: string, desktopDir: string, nodeBin: string): void {
  mkdirSync(desktopDir, { recursive: true });
  const iconPath = join(assetsDir, 'icon.png');
  const desktopFilePath = join(desktopDir, 'myraildepot-bridge.desktop');
  writeFileSync(desktopFilePath, buildDesktopEntry(installDir, iconPath, nodeBin));
  chmodSync(desktopFilePath, 0o755);
}
