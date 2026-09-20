import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface BridgeCredentials {
  bridgeId: string;
  apiKey: string;
}

export interface EnsureCredentialsOptions {
  envPath: string;
  existingBridgeId: string | undefined;
  existingApiKey: string | undefined;
  enrollmentToken: string | undefined;
  saasBaseUrl: string;
  fetchImpl?: typeof fetch;
}

/**
 * The server's error responses are always JSON (`{ error: { status, message } }` — see
 * apps/firebase-cloud's `sendError`), but a proxy/load balancer in front of it could return a plain-text
 * or HTML body instead. Extract a clean message when it's the expected shape; fall back to the raw body
 * otherwise, so a failure never surfaces an unparsed JSON blob to the user for no reason.
 */
function extractErrorMessage(rawBody: string): string {
  try {
    const parsed = JSON.parse(rawBody) as { error?: { message?: string } };
    if (typeof parsed.error?.message === 'string' && parsed.error.message) {
      return parsed.error.message;
    }
  } catch {
    // Not JSON — fall through to the raw body.
  }
  return rawBody;
}

/**
 * Decides which enrollment token, if any, counts as an explicit signal to (re-)enroll. A CLI
 * argument always wins unconditionally: the user just ran the command with a token, right now.
 * `BRIDGE_ENROLLMENT_TOKEN` from the environment is different — it commonly lives on in a process
 * manager's persistent config (a systemd unit, a docker-compose file) well past the first
 * successful enrollment, so it only seeds the very first run: once local credentials already
 * exist, it must not force a re-exchange on every restart.
 */
export function resolveEnrollmentToken(
  cliToken: string | undefined,
  envToken: string | undefined,
  hasExistingCredentials: boolean,
): string | undefined {
  return cliToken ?? (hasExistingCredentials ? undefined : envToken);
}

/**
 * Resolves the credentials the bridge needs to run. An explicitly-provided enrollment token always
 * wins and triggers a fresh exchange — even when local credentials already exist — because
 * providing a token is an explicit signal to (re-)enroll. This matters after a bridge is deleted
 * server-side and re-declared: this machine's `.env` still has the old, now-revoked
 * BRIDGE_ID/BRIDGE_API_KEY, and silently trusting them instead of the fresh token would
 * re-register with dead credentials. Only when no token is given do existing credentials get
 * reused, with no network call — the normal restart-from-the-shortcut path.
 */
export async function ensureCredentials(opts: EnsureCredentialsOptions): Promise<BridgeCredentials> {
  const { envPath, existingBridgeId, existingApiKey, saasBaseUrl } = opts;
  const enrollmentToken = opts.enrollmentToken?.trim();
  const doFetch = opts.fetchImpl ?? fetch;

  if (!enrollmentToken) {
    if (existingBridgeId && existingApiKey) {
      return { bridgeId: existingBridgeId, apiKey: existingApiKey };
    }
    throw new Error(
      'No bridge credentials found and no enrollment token provided. ' +
      'Run: npx @myraildepot/local-bridge <TOKEN> — get a token from the "Declare a bridge" screen.',
    );
  }

  const res = await doFetch(`${saasBaseUrl}/exchangeBridgeEnrollment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: enrollmentToken }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Enrollment failed (${res.status}): ${extractErrorMessage(text)}`);
  }

  const body = await res.json().catch(() => null) as Partial<BridgeCredentials> | null;
  if (!body || typeof body.bridgeId !== 'string' || !body.bridgeId || typeof body.apiKey !== 'string' || !body.apiKey) {
    throw new Error('Enrollment succeeded but the server response was missing bridgeId/apiKey.');
  }
  const { bridgeId, apiKey } = body;

  // envPath now typically points into ~/.myraildepot/local-bridge/, which won't exist yet on a
  // machine's very first-ever run — the persistent install dir is normally created by
  // self-install.ts, but that hasn't run yet at this point in the bootstrap sequence.
  mkdirSync(dirname(envPath), { recursive: true });
  writeEnvCredentials(envPath, bridgeId, apiKey);

  return { bridgeId, apiKey };
}

/**
 * Sets BRIDGE_ID/BRIDGE_API_KEY in the `.env` file at `envPath`, replacing any existing occurrence
 * of either key in place instead of appending a duplicate — a stale pair from a previous
 * enrollment must not linger alongside the fresh one (Node's env-file loading isn't a contract
 * worth relying on for which duplicate wins). Any other line — a user's own BRIDGE_PORT or
 * SAAS_BASE_URL override, say — is preserved untouched.
 */
function writeEnvCredentials(envPath: string, bridgeId: string, apiKey: string): void {
  const existingLines = existsSync(envPath) ? readFileSync(envPath, 'utf8').split('\n') : [];
  // A trailing newline in the file produces one spurious empty element from split('\n') — drop
  // only that artifact, not genuine blank lines a user may have put between sections.
  if (existingLines.length > 0 && existingLines[existingLines.length - 1] === '') {
    existingLines.pop();
  }
  const keptLines = existingLines.filter(
    (line) => !line.startsWith('BRIDGE_ID=') && !line.startsWith('BRIDGE_API_KEY='),
  );
  const content = [...keptLines, `BRIDGE_ID=${bridgeId}`, `BRIDGE_API_KEY=${apiKey}`].join('\n') + '\n';
  writeFileSync(envPath, content, { mode: 0o600 });
  // Secrets: never leave .env world/group-readable, regardless of the umask that created it.
  chmodSync(envPath, 0o600);
}
