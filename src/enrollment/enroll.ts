import { appendFileSync, existsSync } from 'node:fs';

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
 * Resolves the credentials the bridge needs to run. If they already exist (a prior enrollment wrote
 * them to `.env`), returns them with no network call. Otherwise, exchanges the one-time enrollment
 * token for real credentials and appends them to the `.env` file at `envPath`.
 */
export async function ensureCredentials(opts: EnsureCredentialsOptions): Promise<BridgeCredentials> {
  const { envPath, existingBridgeId, existingApiKey, enrollmentToken, saasBaseUrl } = opts;
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
    throw new Error(`Enrollment failed (${res.status}): ${text}`);
  }

  const { bridgeId, apiKey } = await res.json() as BridgeCredentials;

  const line = `\nBRIDGE_ID=${bridgeId}\nBRIDGE_API_KEY=${apiKey}\n`;
  if (!existsSync(envPath)) {
    appendFileSync(envPath, line.trimStart());
  } else {
    appendFileSync(envPath, line);
  }

  return { bridgeId, apiKey };
}
