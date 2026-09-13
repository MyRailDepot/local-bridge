import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

/** The fixed, persistent location the bridge self-installs into — same path shape on every OS. */
export function getInstallDir(homeDir: string = homedir()): string {
  return join(homeDir, '.myraildepot', 'local-bridge');
}

/**
 * True when `currentPackageRoot` — the directory this running copy's code actually lives in — is
 * the fixed install directory itself, meaning this launch came from the desktop/Applications
 * shortcut rather than an ephemeral `npx` cache. Resolves symlinks on whichever side already
 * exists on disk (the install directory won't exist yet on the very first, ephemeral run), so a
 * symlinked home directory doesn't produce a false negative.
 */
export function isInstalledCopy(currentPackageRoot: string, installDir: string): boolean {
  const real = (path: string): string => (existsSync(path) ? realpathSync(path) : resolve(path));
  return real(currentPackageRoot) === real(installDir);
}
