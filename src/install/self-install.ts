import { copyFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { getInstallDir, isInstalledCopy } from './paths';
import { writeInstallEnv, type InstalledCredentials } from './env-writer';
import { runNpmInstall, runNpmUpdateInBackground, type SpawnFn as NpmSpawnFn } from './npm-runner';
import { installMacLauncher, resolveMacAppsDir } from './launchers/mac';
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
  /** Override for the system-wide macOS Applications dir; defaults to '/Applications'. Tests must
   *  pass a fake one — see resolveMacAppsDir — to avoid touching the real machine's folder. */
  systemAppsDir?: string;
  npmSpawnImpl?: NpmSpawnFn;
  windowsSpawnImpl?: WindowsSpawnFn;
}

/**
 * Copies one icon file into a subfolder of the persistent install directory and returns that
 * subfolder. Windows/Linux launchers only ever *reference* their icon path (unlike macOS, which
 * copies icon.icns straight into its own .app bundle) — if that path pointed at `opts.assetsDir`
 * on an ephemeral run, it would point into npx's disposable cache (`~/.npm/_npx/<hash>/...`),
 * and the desktop icon would silently go blank after a `npm cache clean` or similar pruning.
 * `installDir` itself is the one location guaranteed to persist for as long as the shortcut does.
 */
function persistIconAsset(assetsDir: string, installDir: string, filename: string): string {
  const persistentDir = join(installDir, 'assets');
  mkdirSync(persistentDir, { recursive: true });
  copyFileSync(join(assetsDir, filename), join(persistentDir, filename));
  return persistentDir;
}

/**
 * Called once per launch, after the server is already listening — nothing here ever blocks first
 * use of the bridge. On an ephemeral (npx) run, materializes a persistent install and a
 * platform-appropriate launcher; on a launch from that persistent install, only refreshes it in
 * the background for next time.
 */
export async function selfInstallIfNeeded(opts: SelfInstallOptions): Promise<void> {
  try {
    // homedir()/getInstallDir()/isInstalledCopy() all live inside this try, not before it: even
    // though they're not expected to throw, isInstalledCopy calls realpathSync, which can (a
    // permissions error, a symlink loop, a TOCTOU race against its own existsSync check), and
    // homedir() itself can throw in a container with neither HOME nor a passwd entry. This
    // function's only caller (main.ts) invokes it with a bare `void`, so an exception that
    // escaped this try would become an unhandled rejection — which Node treats as fatal by
    // default, killing a bridge that may already be listening and serving trains. A failure here
    // must always be reported, never fatal.
    const homeDir = opts.homeDir ?? homedir();
    const platform = opts.platform ?? process.platform;
    const installDir = getInstallDir(homeDir);

    if (isInstalledCopy(opts.currentPackageRoot, installDir)) {
      printStep('Checking for updates');
      runNpmUpdateInBackground(installDir, opts.npmSpawnImpl);
      printStepDone('Update check started in the background — applies on next launch');
      return;
    }

    printStep('Setting up a permanent install and a desktop shortcut');
    mkdirSync(installDir, { recursive: true });
    writeInstallEnv(installDir, opts.credentials);
    await runNpmInstall(installDir, opts.npmSpawnImpl);

    // Every launcher-creation call below is given its target directory explicitly, computed from
    // this function's own (possibly injected) `homeDir` — never left to default to the real
    // os.homedir() internally, or a test-injected homeDir would be silently ignored.
    if (platform === 'darwin') {
      installMacLauncher(installDir, opts.assetsDir, resolveMacAppsDir(homeDir, opts.systemAppsDir));
    } else if (platform === 'win32') {
      const persistentAssetsDir = persistIconAsset(opts.assetsDir, installDir, 'icon.ico');
      await installWindowsLauncher(
        installDir,
        persistentAssetsDir,
        join(homeDir, 'Desktop'),
        opts.windowsSpawnImpl ?? defaultWindowsSpawn,
      );
    } else {
      const persistentAssetsDir = persistIconAsset(opts.assetsDir, installDir, 'icon.png');
      installLinuxLauncher(installDir, persistentAssetsDir, join(homeDir, 'Desktop'));
    }

    printStepDone('A shortcut named "MyRailDepot Bridge" was created — use it next time');
  } catch (err) {
    printStepFailed('Setting up a permanent install', err instanceof Error ? err.message : String(err));
  }
}
