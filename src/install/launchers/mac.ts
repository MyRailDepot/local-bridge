import { chmodSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_NAME = 'MyRailDepot Bridge';

/**
 * A minimal Info.plist for a wrapper .app bundle — just enough for Finder to show the right name
 * and icon and know which file to run. No signing, no entitlements: this bundle is created locally
 * by the already-running bridge process, not downloaded, so it never carries the quarantine
 * attribute that would otherwise trigger Gatekeeper on launch.
 */
export function buildInfoPlist(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleDisplayName</key>
  <string>${APP_NAME}</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundleIconFile</key>
  <string>icon.icns</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleIdentifier</key>
  <string>com.myraildepot.bridge</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0</string>
</dict>
</plist>
`;
}

/**
 * Opens a Terminal window titled "MyRailDepot Bridge" (not the raw script path) and runs the
 * installed bridge inside it, via AppleScript. Closing that window stops the bridge — no extra
 * code needed, that's standard Terminal.app behavior for a foreground process.
 */
export function buildLauncherScript(installDir: string): string {
  const runCommand = `cd '${installDir}' && ./node_modules/.bin/local-bridge; exit`;
  const escapedCommand = runCommand.replace(/"/g, '\\"');
  return `#!/bin/bash
osascript <<'APPLESCRIPT'
tell application "Terminal"
  activate
  do script "${escapedCommand}"
  set custom title of front window to "${APP_NAME}"
end tell
APPLESCRIPT
`;
}

/** Writes the whole \`.app\` bundle to \`~/Applications/MyRailDepot Bridge.app\`. */
export function installMacLauncher(
  installDir: string,
  assetsDir: string,
  appsDir: string = join(homedir(), 'Applications'),
): void {
  const bundleDir = join(appsDir, `${APP_NAME}.app`);
  const contentsDir = join(bundleDir, 'Contents');
  const macOsDir = join(contentsDir, 'MacOS');
  const resourcesDir = join(contentsDir, 'Resources');

  mkdirSync(macOsDir, { recursive: true });
  mkdirSync(resourcesDir, { recursive: true });

  writeFileSync(join(contentsDir, 'Info.plist'), buildInfoPlist());

  const launcherPath = join(macOsDir, 'launcher');
  writeFileSync(launcherPath, buildLauncherScript(installDir));
  chmodSync(launcherPath, 0o755);

  copyFileSync(join(assetsDir, 'icon.icns'), join(resourcesDir, 'icon.icns'));
}
