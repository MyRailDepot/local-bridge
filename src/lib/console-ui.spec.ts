import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import {
  printBanner,
  printStep,
  printStepDone,
  printStepFailed,
  printInfo,
  printWarning,
} from './console-ui.ts';

let originalIsTTY: boolean | undefined;
let originalNoColor: string | undefined;

beforeEach(() => {
  originalIsTTY = process.stdout.isTTY;
  originalNoColor = process.env['NO_COLOR'];
});

afterEach(() => {
  process.stdout.isTTY = originalIsTTY;
  if (originalNoColor === undefined) delete process.env['NO_COLOR'];
  else process.env['NO_COLOR'] = originalNoColor;
  mock.reset();
});

function captureConsole(): { logCalls: string[]; errorCalls: string[]; warnCalls: string[] } {
  const logCalls: string[] = [];
  const errorCalls: string[] = [];
  const warnCalls: string[] = [];
  mock.method(console, 'log', (...args: unknown[]) => { logCalls.push(args.join(' ')); });
  mock.method(console, 'error', (...args: unknown[]) => { errorCalls.push(args.join(' ')); });
  mock.method(console, 'warn', (...args: unknown[]) => { warnCalls.push(args.join(' ')); });
  return { logCalls, errorCalls, warnCalls };
}

describe('console-ui (colors forced off — NO_COLOR set)', () => {
  beforeEach(() => {
    process.env['NO_COLOR'] = '1';
  });

  it('printStep prints a plain "▶ <label>…" line, no escape codes', () => {
    const { logCalls } = captureConsole();
    printStep('Connecting');
    assert.deepEqual(logCalls, ['▶ Connecting…']);
    assert.ok(!logCalls[0]!.includes('\x1b'));
  });

  it('printStepDone prints a plain "✓ <label>" line', () => {
    const { logCalls } = captureConsole();
    printStepDone('Connected');
    assert.deepEqual(logCalls, ['✓ Connected']);
  });

  it('printStepFailed writes to console.error as "✗ <label>: <detail>"', () => {
    const { errorCalls } = captureConsole();
    printStepFailed('Connecting', 'timed out');
    assert.deepEqual(errorCalls, ['✗ Connecting: timed out']);
  });

  it('printInfo prints the message unchanged', () => {
    const { logCalls } = captureConsole();
    printInfo('Local URL: https://example.bridge.myraildepot.com:3000');
    assert.deepEqual(logCalls, ['Local URL: https://example.bridge.myraildepot.com:3000']);
  });

  it('printWarning writes to console.warn as "⚠ <message>"', () => {
    const { warnCalls } = captureConsole();
    printWarning('Update check failed: offline');
    assert.deepEqual(warnCalls, ['⚠ Update check failed: offline']);
  });

  it('printBanner prints a 3-line box containing the name and version, no escape codes', () => {
    const { logCalls } = captureConsole();
    printBanner('1.2.3');
    assert.equal(logCalls.length, 3);
    assert.ok(logCalls[1]!.includes('MyRailDepot Bridge  v1.2.3'));
    for (const line of logCalls) assert.ok(!line.includes('\x1b'));
  });

  it('printBanner grows its box to fit a longer version string without truncating', () => {
    const { logCalls } = captureConsole();
    printBanner('10.20.30-beta.1');
    assert.ok(logCalls[1]!.includes('MyRailDepot Bridge  v10.20.30-beta.1'));
    assert.equal(logCalls[0]!.length, logCalls[1]!.length);
    assert.equal(logCalls[0]!.length, logCalls[2]!.length);
  });
});

describe('console-ui (colors enabled — TTY, no NO_COLOR)', () => {
  beforeEach(() => {
    process.stdout.isTTY = true;
    delete process.env['NO_COLOR'];
  });

  it('printStepDone wraps the ✓ in green ANSI codes', () => {
    const { logCalls } = captureConsole();
    printStepDone('Connected');
    assert.ok(logCalls[0]!.includes('\x1b[32m'));
    assert.ok(logCalls[0]!.includes('Connected'));
  });

  it('printStepFailed wraps the ✗ in red ANSI codes', () => {
    const { errorCalls } = captureConsole();
    printStepFailed('Connecting', 'timed out');
    assert.ok(errorCalls[0]!.includes('\x1b[31m'));
  });
});

describe('console-ui (non-TTY, even without NO_COLOR — e.g. piped output)', () => {
  beforeEach(() => {
    process.stdout.isTTY = undefined;
    delete process.env['NO_COLOR'];
  });

  it('printStepDone prints plain text with no escape codes', () => {
    const { logCalls } = captureConsole();
    printStepDone('Connected');
    assert.deepEqual(logCalls, ['✓ Connected']);
  });
});
