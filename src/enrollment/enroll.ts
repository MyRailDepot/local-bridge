import { appendFileSync, chmodSync, existsSync } from 'node:fs';

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
 * Resolves the credentials the bridge needs to run. If they already exist (a prior enrollment wrote
 * them to `.env`), returns them with no network call. Otherwise, exchanges the one-time enrollment
 * token for real credentials and appends them to the `.env` file at `envPath`.
 */
export async function ensureCredentials(opts: EnsureCredentialsOptions): Promise<BridgeCredentials> {
  const { envPath, existingBridgeId, existingApiKey, saasBaseUrl } = opts;
  const enrollmentToken = opts.enrollmentToken?.trim();
  const doFetch = opts.fetchImpl ?? fetch;

  if (existingBridgeId && existingApiKey) {
    return { bridgeId: existingBridgeId, apiKey: existingApiKey };
  }

  if (!enrollmentToken) {
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

  const line = `\nBRIDGE_ID=${bridgeId}\nBRIDGE_API_KEY=${apiKey}\n`;
  if (!existsSync(envPath)) {
    appendFileSync(envPath, line.trimStart(), { mode: 0o600 });
  } else {
    appendFileSync(envPath, line);
  }
  // Secrets: never leave .env world/group-readable, regardless of the umask that created it.
  chmodSync(envPath, 0o600);

  return { bridgeId, apiKey };
}
