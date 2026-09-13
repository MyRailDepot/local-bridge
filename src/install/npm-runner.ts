import { spawn as nodeSpawn } from 'node:child_process';
import { printWarning } from '../lib/console-ui';

interface MinimalChildProcess {
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'exit', listener: (code: number | null) => void): void;
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string }) => MinimalChildProcess;

const defaultSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, args, options);

function runNpm(args: string[], installDir: string, spawnImpl: SpawnFn): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl('npm', args, { cwd: installDir });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err) => rejectPromise(err));
    child.on('exit', (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`npm ${args.join(' ')} exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

/**
 * Materializes a real, persistent copy of the package at `installDir` — the self-install step's
 * core action. Awaited by the caller (there's nothing meaningful to do with a launcher pointing at
 * an install that isn't finished yet), but this itself never blocks the *server* from already
 * serving requests, since it's only ever invoked after `app.listen()` has resolved.
 */
export async function runNpmInstall(installDir: string, spawnImpl: SpawnFn = defaultSpawn): Promise<void> {
  await runNpm(['install', '@myraildepot/local-bridge', '--prefix', installDir], installDir, spawnImpl);
}

/**
 * Fire-and-forget: refreshes the persistent install in the background so the *next* launch picks
 * up any fix. Never awaited by the caller, never throws — a failure (offline, registry down) is
 * only ever logged as a warning, since the currently-running bridge already has everything it
 * needs on disk and must keep serving regardless.
 */
export function runNpmUpdateInBackground(installDir: string, spawnImpl: SpawnFn = defaultSpawn): void {
  runNpm(['update', '@myraildepot/local-bridge', '--prefix', installDir], installDir, spawnImpl)
    .catch((err: unknown) => {
      printWarning(`Background update check failed: ${err instanceof Error ? err.message : String(err)}`);
    });
}
