import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A standard freedesktop .desktop entry. `Terminal=true` so the bridge's output is visible exactly
 * as on the other two OSes. GNOME requires a one-time "Allow Launching" confirmation on a .desktop
 * file created outside a package manager — known, unavoidable, and not solved here.
 */
export function buildDesktopEntry(installDir: string, iconPath: string): string {
  // Escape single quotes in the path by replacing ' with '\''
  // This works within double quotes: the \'' becomes a literal \' when interpreted by bash
  const escapedDir = installDir.replace(/'/g, "'\\''");
  const execCommand = `bash -c "cd '${escapedDir}' && ./node_modules/.bin/local-bridge; exec bash"`;
  return `[Desktop Entry]
Type=Application
Name=MyRailDepot Bridge
Exec=${execCommand}
Icon=${iconPath}
Terminal=true
Categories=Utility;
`;
}

/** Writes `~/Desktop/myraildepot-bridge.desktop`, executable. */
export function installLinuxLauncher(installDir: string, assetsDir: string, desktopDir: string): void {
  mkdirSync(desktopDir, { recursive: true });
  const iconPath = join(assetsDir, 'icon.png');
  const desktopFilePath = join(desktopDir, 'myraildepot-bridge.desktop');
  writeFileSync(desktopFilePath, buildDesktopEntry(installDir, iconPath));
  chmodSync(desktopFilePath, 0o755);
}
