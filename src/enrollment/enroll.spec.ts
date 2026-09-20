import { describe, it, after, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureCredentials, resolveEnrollmentToken } from './enroll.ts';

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

describe('resolveEnrollmentToken', () => {
  it('a CLI token always wins, even when credentials already exist', () => {
    assert.equal(resolveEnrollmentToken('cli-token', 'env-token', true), 'cli-token');
  });

  it('a CLI token is used to enroll when no credentials exist yet', () => {
    assert.equal(resolveEnrollmentToken('cli-token', undefined, false), 'cli-token');
  });

  it('an env token seeds enrollment when no CLI token and no existing credentials', () => {
    assert.equal(resolveEnrollmentToken(undefined, 'env-token', false), 'env-token');
  });

  it('an env token is ignored once credentials already exist, so it cannot force a re-exchange on every restart', () => {
    assert.equal(resolveEnrollmentToken(undefined, 'env-token', true), undefined);
  });

  it('returns undefined when neither source provides a token', () => {
    assert.equal(resolveEnrollmentToken(undefined, undefined, false), undefined);
  });
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

  it('creates the parent directory when envPath points into one that does not exist yet', async () => {
    mock.method(globalThis, 'fetch', (async () => ({
      ok: true,
      json: async () => ({ bridgeId: 'bridge-new', apiKey: 'key-new' }),
    })) as unknown as typeof fetch);

    const dir = mkdtempSync(join(tmpdir(), 'local-bridge-enroll-test-'));
    tempDirs.push(dir);
    // .myraildepot/local-bridge doesn't exist under this fresh temp dir — ensureCredentials must
    // create it, the same way it would on a machine's very first-ever run.
    const envPath = join(dir, '.myraildepot', 'local-bridge', '.env');

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

  it('re-exchanges the token even when local credentials already exist, ignoring the stale pair', async () => {
    // Regression: a bridge deleted server-side and re-declared hands out a fresh token, but this
    // machine's .env still has the old, now-revoked BRIDGE_ID/BRIDGE_API_KEY. A token must always
    // win over whatever is already on disk.
    const fetchMock = mock.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ bridgeId: 'bridge-fresh', apiKey: 'key-fresh' }),
    }));
    mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch);

    const result = await ensureCredentials({
      envPath: makeEnvPath(),
      existingBridgeId: 'bridge-stale',
      existingApiKey: 'key-stale',
      enrollmentToken: 'FRESH-TOKEN',
      saasBaseUrl: SAAS_BASE_URL,
    });

    assert.deepEqual(result, { bridgeId: 'bridge-fresh', apiKey: 'key-fresh' });
    assert.equal(fetchMock.mock.calls.length, 1);
  });

  it('replaces a stale BRIDGE_ID/BRIDGE_API_KEY pair in .env instead of duplicating it', async () => {
    mock.method(globalThis, 'fetch', (async () => ({
      ok: true,
      json: async () => ({ bridgeId: 'bridge-fresh', apiKey: 'key-fresh' }),
    })) as unknown as typeof fetch);

    const envPath = makeEnvPath();
    writeFileSync(envPath, 'SOME_OTHER_VAR=already-here\nBRIDGE_ID=bridge-stale\nBRIDGE_API_KEY=key-stale\n');

    await ensureCredentials({
      envPath,
      existingBridgeId: undefined,
      existingApiKey: undefined,
      enrollmentToken: 'FRESH-TOKEN',
      saasBaseUrl: SAAS_BASE_URL,
    });

    const content = readFileSync(envPath, 'utf8');
    assert.match(content, /^SOME_OTHER_VAR=already-here$/m);
    assert.match(content, /^BRIDGE_ID=bridge-fresh$/m);
    assert.match(content, /^BRIDGE_API_KEY=key-fresh$/m);
    assert.doesNotMatch(content, /bridge-stale/);
    assert.doesNotMatch(content, /key-stale/);
    assert.equal((content.match(/^BRIDGE_ID=/gm) ?? []).length, 1);
    assert.equal((content.match(/^BRIDGE_API_KEY=/gm) ?? []).length, 1);
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

  it('preserves blank lines a user put between sections of their own .env', async () => {
    mock.method(globalThis, 'fetch', (async () => ({
      ok: true,
      json: async () => ({ bridgeId: 'bridge-new', apiKey: 'key-new' }),
    })) as unknown as typeof fetch);

    const envPath = makeEnvPath();
    writeFileSync(envPath, 'SAAS_BASE_URL=https://x\n\nBRIDGE_PORT=4000\n');

    await ensureCredentials({
      envPath,
      existingBridgeId: undefined,
      existingApiKey: undefined,
      enrollmentToken: 'ABC123',
      saasBaseUrl: SAAS_BASE_URL,
    });

    const content = readFileSync(envPath, 'utf8');
    assert.equal(content, 'SAAS_BASE_URL=https://x\n\nBRIDGE_PORT=4000\nBRIDGE_ID=bridge-new\nBRIDGE_API_KEY=key-new\n');
  });
});
