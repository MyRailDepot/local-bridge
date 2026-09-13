import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { runNpmInstall, runNpmUpdateInBackground, type SpawnFn } from './npm-runner.ts';

function makeFakeChild(): { child: EventEmitter & { stderr: EventEmitter }; emitClose: (code: number) => void } {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  child.stderr = new EventEmitter();
  // `runNpm` listens on 'close' (not 'exit') so that stderr is guaranteed fully flushed before
  // resolving/rejecting — see Finding 2 in the task-4 review.
  return { child, emitClose: (code: number) => { child.emit('close', code); } };
}

/**
 * Stubs `process.platform` for the duration of a test and returns a restore function. Uses
 * `Object.defineProperty` (the platform accessor is normally non-configurable via plain
 * assignment) and always restores the exact original descriptor, so a stub never leaks into
 * another test file sharing this process — callers must call the returned restore in a
 * `finally` block.
 */
function stubPlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return () => { Object.defineProperty(process, 'platform', original); };
}

describe('runNpmInstall', () => {
  it('spawns npm install <pkg> --prefix <dir> in the install directory', async () => {
    const calls: Array<{ command: string; args: string[]; options: { cwd: string; shell: boolean } }> = [];
    const { child, emitClose } = makeFakeChild();
    const spawnImpl: SpawnFn = (command, args, options) => {
      calls.push({ command, args, options });
      queueMicrotask(() => emitClose(0));
      return child;
    };

    await runNpmInstall('/fake/install/dir', spawnImpl);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, 'npm');
    assert.deepEqual(calls[0]!.args, ['install', '@myraildepot/local-bridge', '--prefix', '/fake/install/dir']);
    assert.equal(calls[0]!.options.cwd, '/fake/install/dir');
  });

  it('rejects with a clear message including stderr when npm exits non-zero', async () => {
    const { child, emitClose } = makeFakeChild();
    const spawnImpl: SpawnFn = () => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('network error'));
        emitClose(1);
      });
      return child;
    };

    await assert.rejects(
      () => runNpmInstall('/fake/install/dir', spawnImpl),
      /exited with code 1.*network error/,
    );
  });
});

describe('runNpmUpdateInBackground', () => {
  it('spawns npm update <pkg> --prefix <dir>', () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const { child, emitClose } = makeFakeChild();
    const spawnImpl: SpawnFn = (command, args) => {
      calls.push({ command, args });
      queueMicrotask(() => emitClose(0));
      return child;
    };

    runNpmUpdateInBackground('/fake/install/dir', spawnImpl);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, ['update', '@myraildepot/local-bridge', '--prefix', '/fake/install/dir']);
  });

  it('never throws synchronously even though it does not await the result', () => {
    const { child, emitClose } = makeFakeChild();
    const spawnImpl: SpawnFn = () => {
      queueMicrotask(() => emitClose(1));
      return child;
    };

    assert.doesNotThrow(() => { runNpmUpdateInBackground('/fake/install/dir', spawnImpl); });
  });

  it('logs a warning (never throws, never rejects unhandled) when the background update fails', async () => {
    const { child, emitClose } = makeFakeChild();
    const spawnImpl: SpawnFn = () => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('offline'));
        emitClose(1);
      });
      return child;
    };
    const warnCalls: string[] = [];
    mock.method(console, 'warn', (...args: unknown[]) => { warnCalls.push(args.join(' ')); });

    runNpmUpdateInBackground('/fake/install/dir', spawnImpl);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(warnCalls.length, 1);
    assert.match(warnCalls[0]!, /Background update check failed.*offline/);
    mock.reset();
  });
});

describe('defaultSpawn (real node:child_process.spawn path)', () => {
  it('passes shell: true through to the real spawn on Windows, so npm.cmd resolves', async () => {
    const restorePlatform = stubPlatform('win32');
    const { child, emitClose } = makeFakeChild();
    const calls: Array<{ command: string; args: string[]; options: unknown }> = [];
    const spawnMock = mock.method(
      childProcess,
      'spawn',
      (command: string, args: readonly string[], options: unknown) => {
        calls.push({ command, args: [...args], options });
        queueMicrotask(() => emitClose(0));
        return child as unknown as ReturnType<typeof childProcess.spawn>;
      },
    );

    try {
      // No spawnImpl passed: exercises the real defaultSpawn -> node:child_process.spawn path.
      await runNpmInstall('/fake/install/dir');
    } finally {
      spawnMock.mock.restore();
      restorePlatform();
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, 'npm');
    assert.deepEqual(calls[0]!.options, { cwd: '/fake/install/dir', shell: true });
  });
});

describe('runNpm shell/quoting per platform', () => {
  it('on win32: passes shell: true and quotes an argument containing whitespace', async () => {
    const restorePlatform = stubPlatform('win32');
    const calls: Array<{ command: string; args: string[]; options: { cwd: string; shell: boolean } }> = [];
    const { child, emitClose } = makeFakeChild();
    const spawnImpl: SpawnFn = (command, args, options) => {
      calls.push({ command, args, options });
      queueMicrotask(() => emitClose(0));
      return child;
    };

    try {
      await runNpmInstall('/fake/install dir/here', spawnImpl);
    } finally {
      restorePlatform();
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.options.shell, true);
    assert.deepEqual(calls[0]!.args, [
      'install',
      '@myraildepot/local-bridge',
      '--prefix',
      '"/fake/install dir/here"',
    ]);
  });

  // Regression test: right before this fix, `shell` was unconditionally `true` on every platform,
  // so an argument containing a space would have been silently word-split by the shell on mac/Linux
  // too (corrupting the --prefix value) — this test would have seen `shell: true` and a quoted
  // argument here, and must fail against that prior code.
  it('on darwin: passes shell: false and leaves a whitespace argument unquoted/unmodified', async () => {
    const restorePlatform = stubPlatform('darwin');
    const calls: Array<{ command: string; args: string[]; options: { cwd: string; shell: boolean } }> = [];
    const { child, emitClose } = makeFakeChild();
    const spawnImpl: SpawnFn = (command, args, options) => {
      calls.push({ command, args, options });
      queueMicrotask(() => emitClose(0));
      return child;
    };

    try {
      await runNpmInstall('/fake/install dir/here', spawnImpl);
    } finally {
      restorePlatform();
    }

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.options.shell, false);
    assert.deepEqual(calls[0]!.args, [
      'install',
      '@myraildepot/local-bridge',
      '--prefix',
      '/fake/install dir/here',
    ]);
  });
});
