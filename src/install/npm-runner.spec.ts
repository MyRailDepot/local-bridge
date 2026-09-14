import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import childProcess from 'node:child_process';
import { runNpmInstall, runNpmUpdateInBackground, type SpawnFn } from './npm-runner.ts';

type FakeChild = EventEmitter & { stderr: EventEmitter; kill(): void; killCallCount: number };

function makeFakeChild(): { child: FakeChild; emitClose: (code: number) => void } {
  const child = new EventEmitter() as FakeChild;
  child.stderr = new EventEmitter();
  child.killCallCount = 0;
  child.kill = () => { child.killCallCount += 1; };
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

interface SpawnCallOptions {
  cwd: string;
  shell: boolean;
  stdio: ['ignore', 'ignore', 'pipe'];
}

describe('runNpmInstall', () => {
  it('spawns npm install <pkg> --prefix <dir> in the install directory, with stdout ignored and stderr piped', async () => {
    const calls: Array<{ command: string; args: string[]; options: SpawnCallOptions }> = [];
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
    // Regression guard: a piped-but-undrained stdout can fill the OS pipe buffer and hang npm
    // forever once it writes enough to it — stdout must be discarded, not collected unread.
    assert.deepEqual(calls[0]!.options.stdio, ['ignore', 'ignore', 'pipe']);
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
    assert.deepEqual(calls[0]!.options, { cwd: '/fake/install/dir', shell: true, stdio: ['ignore', 'ignore', 'pipe'] });
  });
});

describe('runNpm shell/quoting per platform', () => {
  it('on win32: passes shell: true and quotes every argument, not only ones containing whitespace', async () => {
    const restorePlatform = stubPlatform('win32');
    const calls: Array<{ command: string; args: string[]; options: SpawnCallOptions }> = [];
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
    // Every element is quoted, including ones with no whitespace at all — see the next test for
    // why (a Windows account name can contain cmd.exe metacharacters with no space in sight).
    assert.deepEqual(calls[0]!.args, [
      '"install"',
      '"@myraildepot/local-bridge"',
      '"--prefix"',
      '"/fake/install dir/here"',
    ]);
  });

  // Regression test for the finding that whitespace-only quoting missed: Windows account names
  // may legally contain cmd.exe metacharacters (&, ^, %, (, )) with no whitespace at all — e.g.
  // "C:\Users\A&B\...". Unquoted, `shell: true` hands this straight to cmd.exe, which treats `&`
  // as a command separator. Quoting unconditionally (not only when /\s/ matches) closes this.
  it('on win32: quotes an argument containing a cmd.exe metacharacter even with no whitespace', async () => {
    const restorePlatform = stubPlatform('win32');
    const calls: Array<{ command: string; args: string[]; options: SpawnCallOptions }> = [];
    const { child, emitClose } = makeFakeChild();
    const spawnImpl: SpawnFn = (command, args, options) => {
      calls.push({ command, args, options });
      queueMicrotask(() => emitClose(0));
      return child;
    };

    try {
      await runNpmInstall('C:\\Users\\A&B\\.myraildepot\\local-bridge', spawnImpl);
    } finally {
      restorePlatform();
    }

    assert.ok(calls[0]!.args.includes('"C:\\Users\\A&B\\.myraildepot\\local-bridge"'));
  });

  // Regression test: right before this fix, `shell` was unconditionally `true` on every platform,
  // so an argument containing a space would have been silently word-split by the shell on mac/Linux
  // too (corrupting the --prefix value) — this test would have seen `shell: true` and a quoted
  // argument here, and must fail against that prior code.
  it('on darwin: passes shell: false and leaves a whitespace argument unquoted/unmodified', async () => {
    const restorePlatform = stubPlatform('darwin');
    const calls: Array<{ command: string; args: string[]; options: SpawnCallOptions }> = [];
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

describe('runNpm timeout', () => {
  it('kills the child and rejects with a clear message if npm never closes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { child } = makeFakeChild();
    const spawnImpl: SpawnFn = () => child; // never emits 'close' or 'error'

    const pending = assert.rejects(
      () => runNpmInstall('/fake/install/dir', spawnImpl),
      /npm install .* timed out after 300s/,
    );
    t.mock.timers.tick(5 * 60 * 1000);
    await pending;

    assert.equal(child.killCallCount, 1);
  });

  it('clears the timeout on a normal close, leaving no dangling timer', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { child, emitClose } = makeFakeChild();
    const spawnImpl: SpawnFn = () => {
      queueMicrotask(() => emitClose(0));
      return child;
    };

    await runNpmInstall('/fake/install/dir', spawnImpl);

    // If the timeout weren't cleared, advancing past it here would still fire it and call kill()
    // on a child whose promise has already settled.
    t.mock.timers.tick(5 * 60 * 1000);
    assert.equal(child.killCallCount, 0);
  });
});
