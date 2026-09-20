import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { printWarning } from '../lib/console-ui';

interface MinimalChildProcess {
  stderr: { on(event: 'data', listener: (chunk: Buffer) => void): void } | null;
  on(event: 'error', listener: (err: Error) => void): void;
  on(event: 'close', listener: (code: number | null) => void): void;
  kill(): void;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; shell: boolean; stdio: ['ignore', 'ignore', 'pipe'] },
) => MinimalChildProcess;

// `npm` normally lives right next to `node` in the same bin directory, regardless of install
// method (nvm, system package, Volta, the official installer...). Resolving it this way sidesteps
// `process.env.PATH` entirely on mac/Linux — necessary because this process can be launched (e.g.
// from the Linux desktop shortcut) through a non-interactive shell that never sourced the nvm/fnm
// lines in .bashrc/.zshrc responsible for putting that bin directory on PATH in the first place,
// even though the currently-running `node` is undeniably sitting in exactly that directory. On
// Windows, `npm` resolves to `npm.cmd` via PATH + `shell: true` (see defaultSpawn below) — that
// PATH comes from the system environment, not a shell rc file, so it's not the same failure mode.
function resolveNpmCommand(): string {
  if (process.platform === 'win32') return 'npm';
  const colocated = join(dirname(process.execPath), 'npm');
  return fs.existsSync(colocated) ? colocated : 'npm';
}

// `shell: true` is required on the real spawn path: on Windows, `npm` resolves to `npm.cmd`, and
// Node can only launch a `.cmd`/`.bat` file through a shell — without it, spawn emits an `'error'`
// event instead of ever running anything. mac/Linux never need this.
//
// When shell is true, Node emits DEP0190 ("Passing args to a child process with shell option true
// can lead to security vulnerabilities...") for any non-empty `args` array, regardless of whether
// the caller already escaped each argument — which `runNpm`'s `quoteForShell` already does. Node
// can't verify that from the outside, so it warns unconditionally. Folding `args` into `command` as
// a single, already-quoted string (with an empty `args` array) sidesteps the warning entirely
// without changing the actual command line executed — it's the exact string Node would otherwise
// have assembled internally.
const defaultSpawn: SpawnFn = (command, args, options) => {
  const resolvedCommand = command === 'npm' ? resolveNpmCommand() : command;
  if (options.shell) return nodeSpawn([resolvedCommand, ...args].join(' '), [], options);
  return nodeSpawn(resolvedCommand, args, options);
};

// A hung `npm install`/`npm update` (a slow registry, a stuck network) would otherwise leave the
// self-install step waiting forever with no feedback — this turns a silent hang into a reported
// failure. 5 minutes comfortably covers a cold install of this package's modest dependency tree
// even on a slow connection, while still bounding the worst case.
const NPM_TIMEOUT_MS = 5 * 60 * 1000;

// When `shell: true`, Node joins `[file, ...args]` into a single command-line string using plain
// spaces, with no automatic escaping — so any argument could be split or reinterpreted by the
// shell (not just ones containing whitespace: Windows account names can legally contain cmd.exe
// metacharacters like `&`, `^`, `%`, `(`, `)` with no space at all, e.g. "C:\Users\A&B\..."). Quote
// every argument unconditionally on the shell path — never conditionally on whether it happens to
// contain a space. Quoting is only safe on that shell path in the first place: a non-shell spawn
// passes each array element as an atomic argv entry with zero interpretation, so injecting literal
// `"` characters there would corrupt the argument instead of protecting it.
function quoteForShell(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

function runNpm(args: string[], installDir: string, spawnImpl: SpawnFn): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    // Only Windows needs `shell: true` (to resolve npm.cmd) — see the comment on `defaultSpawn`.
    const useShell = process.platform === 'win32';
    const spawnArgs = useShell ? args.map(quoteForShell) : args;
    // stdout is intentionally 'ignore', not 'pipe': a piped stream nobody reads fills the OS pipe
    // buffer (~64KB) once npm writes enough to it, at which point npm blocks on write() and never
    // exits — silently and permanently hanging this promise. npm's actual errors go to stderr,
    // which is the only stream this function needs, so there's nothing to lose by discarding
    // stdout outright rather than collecting output nothing here would ever read.
    const child = spawnImpl('npm', spawnArgs, { cwd: installDir, shell: useShell, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const timeout = setTimeout(() => {
      child.kill();
      rejectPromise(new Error(`npm ${args.join(' ')} timed out after ${NPM_TIMEOUT_MS / 1000}s`));
    }, NPM_TIMEOUT_MS);

    child.on('error', (err) => {
      clearTimeout(timeout);
      rejectPromise(err);
    });
    // Listen on 'close' rather than 'exit': per Node's docs, stdio streams "might still be open"
    // when 'exit' fires, while 'close' fires only once stdout/stderr are fully flushed — so 'exit'
    // risks under-reporting the stderr collected above.
    child.on('close', (code) => {
      clearTimeout(timeout);
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
