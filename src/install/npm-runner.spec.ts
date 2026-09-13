import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { runNpmInstall, runNpmUpdateInBackground, type SpawnFn } from './npm-runner.ts';

function makeFakeChild(): { child: EventEmitter & { stderr: EventEmitter }; emitExit: (code: number) => void } {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  child.stderr = new EventEmitter();
  return { child, emitExit: (code: number) => { child.emit('exit', code); } };
}

describe('runNpmInstall', () => {
  it('spawns npm install <pkg> --prefix <dir> in the install directory', async () => {
    const calls: Array<{ command: string; args: string[]; options: { cwd: string } }> = [];
    const { child, emitExit } = makeFakeChild();
    const spawnImpl: SpawnFn = (command, args, options) => {
      calls.push({ command, args, options });
      queueMicrotask(() => emitExit(0));
      return child;
    };

    await runNpmInstall('/fake/install/dir', spawnImpl);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.command, 'npm');
    assert.deepEqual(calls[0]!.args, ['install', '@myraildepot/local-bridge', '--prefix', '/fake/install/dir']);
    assert.equal(calls[0]!.options.cwd, '/fake/install/dir');
  });

  it('rejects with a clear message including stderr when npm exits non-zero', async () => {
    const { child, emitExit } = makeFakeChild();
    const spawnImpl: SpawnFn = () => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('network error'));
        emitExit(1);
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
    const { child, emitExit } = makeFakeChild();
    const spawnImpl: SpawnFn = (command, args) => {
      calls.push({ command, args });
      queueMicrotask(() => emitExit(0));
      return child;
    };

    runNpmUpdateInBackground('/fake/install/dir', spawnImpl);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.args, ['update', '@myraildepot/local-bridge', '--prefix', '/fake/install/dir']);
  });

  it('never throws synchronously even though it does not await the result', () => {
    const { child, emitExit } = makeFakeChild();
    const spawnImpl: SpawnFn = () => {
      queueMicrotask(() => emitExit(1));
      return child;
    };

    assert.doesNotThrow(() => { runNpmUpdateInBackground('/fake/install/dir', spawnImpl); });
  });

  it('logs a warning (never throws, never rejects unhandled) when the background update fails', async () => {
    const { child, emitExit } = makeFakeChild();
    const spawnImpl: SpawnFn = () => {
      queueMicrotask(() => {
        child.stderr.emit('data', Buffer.from('offline'));
        emitExit(1);
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
