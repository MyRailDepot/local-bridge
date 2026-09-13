import { spawn as nodeSpawn } from 'node:child_process';
import { printWarning } from '../lib/console-ui';

interface MinimalChildProcess {
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; shell: boolean },
) => MinimalChildProcess;

// `shell: true` is required on the real spawn path: on Windows, `npm` resolves to `npm.cmd`, and
// Node can only launch a `.cmd`/`.bat` file through a shell — without it, spawn emits an `'error'`
// event instead of ever running anything. mac/Linux never need this.
const defaultSpawn: SpawnFn = (command, args, options) => nodeSpawn(command, args, options);

// When `shell: true`, Node joins `[file, ...args]` into a single command-line string using plain
// spaces, with no automatic escaping — so an argument containing whitespace (e.g. an install path
// like "/Users/John Doe/...") would get silently word-split by the shell. Quoting is only needed
// (and only safe) on that shell path: a non-shell spawn passes each array element as an atomic
// argv entry with zero interpretation, so injecting literal `"` characters there would corrupt the
// argument instead of protecting it.
function quoteIfNeeded(arg: string): string {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

function runNpm(args: string[], installDir: string, spawnImpl: SpawnFn): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Only Windows needs `shell: true` (to resolve npm.cmd) — see the comment on `defaultSpawn`.
    const useShell = process.platform === 'win32';
    const spawnArgs = useShell ? args.map(quoteIfNeeded) : args;
    const child = spawnImpl('npm', spawnArgs, { cwd: installDir, shell: useShell });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err) => rejectPromise(err));
    // Listen on 'close' rather than 'exit': per Node's docs, stdio streams "might still be open"
    // when 'exit' fires, while 'close' fires only once stdout/stderr are fully flushed — so 'exit'
    // risks under-reporting the stderr collected above.
    child.on('close', (code) => {
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
