import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface InstalledCredentials {
  bridgeId: string;
  apiKey: string;
}

/**
 * Writes a fresh `.env` into the self-install directory from credentials already resolved in
 * memory this run — unlike `ensureCredentials`'s append-if-present behavior for the *current*
 * run's own `.env`, there is no existing file to merge with here, since this is the first time
 * anything has ever lived at this fixed location. Assumes `installDir` already exists.
 */
export function writeInstallEnv(installDir: string, credentials: InstalledCredentials): void {
  const envPath = join(installDir, '.env');
  const content = `BRIDGE_ID=${credentials.bridgeId}\nBRIDGE_API_KEY=${credentials.apiKey}\n`;
  writeFileSync(envPath, content, { mode: 0o600 });
  // Secrets: never leave .env world/group-readable, regardless of the umask in effect.
  chmodSync(envPath, 0o600);
}
