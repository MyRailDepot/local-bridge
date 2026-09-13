#!/usr/bin/env node
// Load .env from cwd before reading process.env
try { process.loadEnvFile(); } catch { /* no .env file, rely on system env */ }

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Server as HttpsServer } from 'node:https';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { setBridgeConfig } from './bridge-config';
import { detectLocalIp, buildLocalUrl } from './lib/network';
import { BridgeServerService } from './registration/bridge-server.service';
import { ensureCredentials } from './enrollment/enroll';
import { printBanner, printStep, printStepDone, printStepFailed, printInfo } from './lib/console-ui';
import { selfInstallIfNeeded } from './install/self-install';

const BRIDGE_PORT = parseInt(process.env['BRIDGE_PORT'] ?? '3000', 10);
const SAAS_BASE_URL = process.env['SAAS_BASE_URL'] ?? 'https://app.myraildepot.com';
// Not consumed anywhere yet — kept as an override hook for a future prod/dev project split.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const FIREBASE_PROJECT_ID = process.env['FIREBASE_PROJECT_ID'] ?? 'myraildepot';

const ALLOWED_ORIGINS = new Set([
  'https://app.myraildepot.com',
  'https://myraildepot.web.app',
  'https://myraildepot.firebaseapp.com',
  'http://localhost:5173',
]);

// __dirname is dist/ once compiled — its parent is this package's own root, whether that's an
// ephemeral npx cache copy or the self-installed persistent copy. Used both to read our own
// version for the startup banner and, later, to locate assets/ and to detect which case this is.
const packageRoot = dirname(__dirname);

function readOwnVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

async function bootstrap(): Promise<void> {
  printBanner(readOwnVersion());

  let bridgeId: string;
  let bridgeApiKey: string;
  printStep('Resolving credentials');
  try {
    const creds = await ensureCredentials({
      envPath: join(process.cwd(), '.env'),
      existingBridgeId: process.env['BRIDGE_ID'],
      existingApiKey: process.env['BRIDGE_API_KEY'],
      enrollmentToken: process.argv[2] ?? process.env['BRIDGE_ENROLLMENT_TOKEN'],
      saasBaseUrl: SAAS_BASE_URL,
    });
    bridgeId = creds.bridgeId;
    bridgeApiKey = creds.apiKey;
    process.env['BRIDGE_ID'] = bridgeId;
    process.env['BRIDGE_API_KEY'] = bridgeApiKey;
    printStepDone('Credentials resolved');
  } catch (err) {
    printStepFailed('Resolving credentials', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const localUrl = process.env['BRIDGE_URL'] ?? (() => {
    const ip = detectLocalIp();
    if (!ip) {
      printStepFailed('Detecting local network address', 'Could not detect local IP. Set BRIDGE_URL env var.');
      process.exit(1);
    }
    return buildLocalUrl(ip, BRIDGE_PORT);
  })();

  printInfo(`Local URL: ${localUrl}${process.env['DEMO_MODE'] === 'true' ? ' [DEMO MODE]' : ''}`);

  printStep('Announcing to the cloud');
  const announceRes = await fetch(`${SAAS_BASE_URL}/bridgeAnnounce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bridgeId, apiKey: bridgeApiKey, localUrl }),
  });

  if (!announceRes.ok) {
    const text = await announceRes.text().catch(() => '');
    printStepFailed('Announcing to the cloud', `HTTP ${announceRes.status}: ${text}`);
    process.exit(1);
  }
  printStepDone('Announced to the cloud');

  const { cert, key, centralConfigs } = await announceRes.json() as {
    cert: string;
    key: string;
    centralConfigs: Array<{ id: string; name: string; type: string; network: { host: string; port: number } }>;
  };

  setBridgeConfig({ localUrl, centralConfigs: centralConfigs ?? [] });

  const app = await NestFactory.create(AppModule, {
    httpsOptions: { cert, key },
    logger: ['log', 'warn', 'error'],
  });

  // Chrome Private Network Access: respond with Allow-Private-Network on PNA preflights
  app.use((
    req: { headers: Record<string, string | string[] | undefined> },
    res: { setHeader(name: string, value: string): void },
    next: () => void,
  ) => {
    if (req.headers['access-control-request-private-network']) {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
    }
    next();
  });

  app.enableCors({
    origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || ALLOWED_ORIGINS.has(origin)) {
        callback(null, true);
      } else {
        callback(new Error('CORS: origin not allowed'));
      }
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false,
  });

  app.useWebSocketAdapter(new WsAdapter(app));
  printStep('Starting the local server');
  await app.listen(BRIDGE_PORT);

  // Register the HTTPS server so RegistrationService can hot-swap the TLS cert on IP change
  app.get(BridgeServerService).setServer(app.getHttpServer() as HttpsServer);

  printStepDone(`HTTPS server listening at ${localUrl}`);

  // Fire-and-forget: never blocks first use of the bridge. On an ephemeral (npx) run this
  // materializes a persistent install + desktop shortcut; on a launch from that persistent
  // install, it only refreshes it in the background for next time.
  void selfInstallIfNeeded({
    currentPackageRoot: packageRoot,
    assetsDir: join(packageRoot, 'assets'),
    credentials: { bridgeId, apiKey: bridgeApiKey },
  });
}

void bootstrap();
