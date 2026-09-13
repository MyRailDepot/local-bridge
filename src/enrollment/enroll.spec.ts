import { describe, it, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCredentials } from './enroll.ts';

const SAAS_BASE_URL = 'https://myraildepot.com';
const tempDirs: string[] = [];

function makeEnvPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'local-bridge-enroll-test-'));
  tempDirs.push(dir);
  return join(dir, '.env');
}

afterEach(() => {
  mock.reset();
});

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('ensureCredentials', () => {
  it('returns existing credentials immediately, with no fetch call, when both are already set', async () => {
    const fetchMock = mock.fn();
    mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch);

    const result = await ensureCredentials({
      envPath: makeEnvPath(),
      existingBridgeId: 'bridge-existing',
      existingApiKey: 'key-existing',
      enrollmentToken: undefined,
      saasBaseUrl: SAAS_BASE_URL,
    });

    assert.deepEqual(result, { bridgeId: 'bridge-existing', apiKey: 'key-existing' });
    assert.equal(fetchMock.mock.calls.length, 0);
  });

  it('throws a clear error when neither existing credentials nor a token are available', async () => {
    await assert.rejects(
      () => ensureCredentials({
        envPath: makeEnvPath(),
        existingBridgeId: undefined,
        existingApiKey: undefined,
        enrollmentToken: undefined,
        saasBaseUrl: SAAS_BASE_URL,
      }),
      /No bridge credentials found and no enrollment token provided.*npx @myraildepot\/local-bridge <TOKEN>/,
    );
  });

  it('exchanges a token for credentials, posting the right URL/method/headers/body', async () => {
    const fetchMock = mock.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ bridgeId: 'bridge-new', apiKey: 'key-new' }),
    }));
    mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch);

    const result = await ensureCredentials({
      envPath: makeEnvPath(),
      existingBridgeId: undefined,
      existingApiKey: undefined,
      enrollmentToken: 'ABC123',
      saasBaseUrl: SAAS_BASE_URL,
    });

    assert.deepEqual(result, { bridgeId: 'bridge-new', apiKey: 'key-new' });
    assert.equal(fetchMock.mock.calls.length, 1);
    const [url, init] = fetchMock.mock.calls[0]!.arguments as [string, RequestInit];
    assert.equal(url, 'https://myraildepot.com/exchangeBridgeEnrollment');
    assert.equal(init.method, 'POST');
    assert.equal((init.headers as Record<string, string>)['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body as string), { token: 'ABC123' });
  });

  it('throws with the status code and body text when the exchange call fails', async () => {
    mock.method(globalThis, 'fetch', (async () => ({
      ok: false,
      status: 410,
      text: async () => 'Enrollment token expired.',
    })) as unknown as typeof fetch);

    await assert.rejects(
      () => ensureCredentials({
        envPath: makeEnvPath(),
        existingBridgeId: undefined,
        existingApiKey: undefined,
        enrollmentToken: 'EXPIRED',
        saasBaseUrl: SAAS_BASE_URL,
      }),
      /Enrollment failed \(410\): Enrollment token expired\./,
    );
  });

  it('extracts the message from a JSON error body instead of surfacing the raw JSON', async () => {
    mock.method(globalThis, 'fetch', (async () => ({
      ok: false,
      status: 410,
      text: async () => JSON.stringify({ error: { status: 'DEADLINE_EXCEEDED', message: 'Enrollment token expired.' } }),
    })) as unknown as typeof fetch);

    await assert.rejects(
      () => ensureCredentials({
        envPath: makeEnvPath(),
        existingBridgeId: undefined,
        existingApiKey: undefined,
        enrollmentToken: 'EXPIRED',
        saasBaseUrl: SAAS_BASE_URL,
      }),
      (err: Error) => {
        assert.equal(err.message, 'Enrollment failed (410): Enrollment token expired.');
        assert.doesNotMatch(err.message, /DEADLINE_EXCEEDED|\{|\}/);
        return true;
      },
    );
  });

  it('throws a clear error when a successful response is missing bridgeId/apiKey', async () => {
    mock.method(globalThis, 'fetch', (async () => ({
      ok: true,
      json: async () => ({ bridgeId: 'bridge-new' }), // apiKey missing
    })) as unknown as typeof fetch);

    await assert.rejects(
      () => ensureCredentials({
        envPath: makeEnvPath(),
        existingBridgeId: undefined,
        existingApiKey: undefined,
        enrollmentToken: 'ABC123',
        saasBaseUrl: SAAS_BASE_URL,
      }),
      /missing bridgeId\/apiKey/,
    );
  });

  it('trims whitespace from a copy-pasted enrollment token before sending it', async () => {
    const fetchMock = mock.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ bridgeId: 'bridge-new', apiKey: 'key-new' }),
    }));
    mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch);

    await ensureCredentials({
      envPath: makeEnvPath(),
      existingBridgeId: undefined,
      existingApiKey: undefined,
      enrollmentToken: '  ABC123\n',
      saasBaseUrl: SAAS_BASE_URL,
    });

    const [, init] = fetchMock.mock.calls[0]!.arguments as [string, RequestInit];
    assert.deepEqual(JSON.parse(init.body as string), { token: 'ABC123' });
  });

  it('writes .env with owner-only permissions (0600), not world-readable', async () => {
    mock.method(globalThis, 'fetch', (async () => ({
      ok: true,
      json: async () => ({ bridgeId: 'bridge-new', apiKey: 'key-new' }),
    })) as unknown as typeof fetch);

    const envPath = makeEnvPath();
    await ensureCredentials({
      envPath,
      existingBridgeId: undefined,
      existingApiKey: undefined,
      enrollmentToken: 'ABC123',
      saasBaseUrl: SAAS_BASE_URL,
    });

    const mode = statSync(envPath).mode & 0o777;
    assert.equal(mode, 0o600);
  });

  it('appends BRIDGE_ID/BRIDGE_API_KEY to a .env file that does not exist yet', async () => {
    mock.method(globalThis, 'fetch', (async () => ({
      ok: true,
      json: async () => ({ bridgeId: 'bridge-new', apiKey: 'key-new' }),
    })) as unknown as typeof fetch);

    const envPath = makeEnvPath();
    await ensureCredentials({
      envPath,
      existingBridgeId: undefined,
      existingApiKey: undefined,
      enrollmentToken: 'ABC123',
      saasBaseUrl: SAAS_BASE_URL,
    });

    const content = readFileSync(envPath, 'utf8');
    assert.match(content, /^BRIDGE_ID=bridge-new$/m);
    assert.match(content, /^BRIDGE_API_KEY=key-new$/m);
  });

  it('appends BRIDGE_ID/BRIDGE_API_KEY to a .env file that already has other content', async () => {
    mock.method(globalThis, 'fetch', (async () => ({
      ok: true,
      json: async () => ({ bridgeId: 'bridge-new', apiKey: 'key-new' }),
    })) as unknown as typeof fetch);

    const envPath = makeEnvPath();
    writeFileSync(envPath, 'SOME_OTHER_VAR=already-here\n');

    await ensureCredentials({
      envPath,
      existingBridgeId: undefined,
      existingApiKey: undefined,
      enrollmentToken: 'ABC123',
      saasBaseUrl: SAAS_BASE_URL,
    });

    const content = readFileSync(envPath, 'utf8');
    assert.match(content, /^SOME_OTHER_VAR=already-here$/m);
    assert.match(content, /^BRIDGE_ID=bridge-new$/m);
    assert.match(content, /^BRIDGE_API_KEY=key-new$/m);
    // The pre-existing line must survive intact, not be clobbered.
    assert.equal(content.startsWith('SOME_OTHER_VAR=already-here'), true);
  });
});
