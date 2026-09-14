import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/** The fixed, persistent location the bridge self-installs into — same path shape on every OS. */
export function getInstallDir(homeDir: string = homedir()): string {
  return join(homeDir, '.myraildepot', 'local-bridge');
}

/**
 * True when `currentPackageRoot` — the directory this running copy's code actually lives in — is
 * inside the fixed install directory, meaning this launch came from the desktop/Applications
 * shortcut rather than an ephemeral `npx` cache. This is a containment check, not exact equality:
 * `npm install <pkg> --prefix <installDir>` places the package at
 * `<installDir>/node_modules/@myraildepot/local-bridge`, one level below the prefix itself, so the
 * running package's real root is always a *descendant* of `installDir` once installed, never equal
 * to it. Resolves symlinks on whichever side already exists on disk (the install directory won't
 * exist yet on the very first, ephemeral run), so a symlinked home directory doesn't produce a
 * false negative.
 */
export function isInstalledCopy(currentPackageRoot: string, installDir: string): boolean {
  const real = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path));
  const current = real(currentPackageRoot);
  const install = real(installDir);
  return current === install || current.startsWith(install + sep);
}
