import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { getInstallDir, isInstalledCopy } from './paths';
import { writeInstallEnv, type InstalledCredentials } from './env-writer';
import { runNpmInstall, runNpmUpdateInBackground, type SpawnFn as NpmSpawnFn } from './npm-runner';
import { installMacLauncher } from './launchers/mac';
import { installWindowsLauncher, type SpawnFn as WindowsSpawnFn } from './launchers/windows';
import { installLinuxLauncher } from './launchers/linux';
import { printStep, printStepDone, printStepFailed } from '../lib/console-ui';

const defaultWindowsSpawn: WindowsSpawnFn = (command, args) => nodeSpawn(command, args);

export interface SelfInstallOptions {
  currentPackageRoot: string;
  assetsDir: string;
  credentials: InstalledCredentials;
  platform?: NodeJS.Platform;
  homeDir?: string;
  npmSpawnImpl?: NpmSpawnFn;
  windowsSpawnImpl?: WindowsSpawnFn;
}

/**
 * Called once per launch, after the server is already listening — nothing here ever blocks first
 * use of the bridge. On an ephemeral (npx) run, materializes a persistent install and a
 * platform-appropriate launcher; on a launch from that persistent install, only refreshes it in
 * the background for next time.
 */
export async function selfInstallIfNeeded(opts: SelfInstallOptions): Promise<void> {
  const homeDir = opts.homeDir ?? homedir();
  const platform = opts.platform ?? process.platform;
  const installDir = getInstallDir(homeDir);

  if (isInstalledCopy(opts.currentPackageRoot, installDir)) {
    runNpmUpdateInBackground(installDir, opts.npmSpawnImpl);
    return;
  }

  try {
    printStep('Setting up a permanent install and a desktop shortcut');
    mkdirSync(installDir, { recursive: true });
    writeInstallEnv(installDir, opts.credentials);
    await runNpmInstall(installDir, opts.npmSpawnImpl);

    // Every launcher-creation call below is given its target directory explicitly, computed from
    // this function's own (possibly injected) `homeDir` — never left to default to the real
    // os.homedir() internally, or a test-injected homeDir would be silently ignored.
    if (platform === 'darwin') {
      installMacLauncher(installDir, opts.assetsDir, join(homeDir, 'Applications'));
    } else if (platform === 'win32') {
      await installWindowsLauncher(
        installDir,
        opts.assetsDir,
        join(homeDir, 'Desktop'),
        opts.windowsSpawnImpl ?? defaultWindowsSpawn,
      );
    } else {
      installLinuxLauncher(installDir, opts.assetsDir, join(homeDir, 'Desktop'));
    }

    printStepDone('A shortcut named "MyRailDepot Bridge" was created — use it next time');
  } catch (err) {
    printStepFailed('Setting up a permanent install', err instanceof Error ? err.message : String(err));
  }
}
