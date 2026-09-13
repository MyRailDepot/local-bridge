#!/usr/bin/env node
// Load .env from apps/local-bridge before reading process.env
try { process.loadEnvFile(); } catch { /* no .env file, rely on system env */ }

import type { Server as HttpsServer } from 'node:https';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { setBridgeConfig } from './bridge-config';
import { detectLocalIp, buildLocalUrl } from './lib/network';
import { BridgeServerService } from './registration/bridge-server.service';

const BRIDGE_ID     = process.env['BRIDGE_ID']!;
const BRIDGE_API_KEY = process.env['BRIDGE_API_KEY']!;
const BRIDGE_PORT   = parseInt(process.env['BRIDGE_PORT'] ?? '3000', 10);
const SAAS_BASE_URL = process.env['SAAS_BASE_URL'] ?? 'https://myraildepot.com';

if (!BRIDGE_ID || !BRIDGE_API_KEY || !process.env['FIREBASE_PROJECT_ID']) {
  console.error('[bridge] Missing required env vars: BRIDGE_ID, BRIDGE_API_KEY, and FIREBASE_PROJECT_ID must be set.');
  process.exit(1);
}

const ALLOWED_ORIGINS = new Set([
  'https://app.myraildepot.com',
  'https://myraildepot.web.app',
  'https://myraildepot.firebaseapp.com',
  'http://localhost:5173',
]);

async function bootstrap(): Promise<void> {
  const localUrl = process.env['BRIDGE_URL'] ?? (() => {
    const ip = detectLocalIp();
    if (!ip) {
      console.error('[bridge] Could not detect local IP. Set BRIDGE_URL env var.');
      process.exit(1);
    }
    return buildLocalUrl(ip, BRIDGE_PORT);
  })();

  console.log(`[bridge] Local URL: ${localUrl}${process.env['DEMO_MODE'] === 'true' ? ' [DEMO MODE]' : ''}`);

  const announceRes = await fetch(`${SAAS_BASE_URL}/bridgeAnnounce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bridgeId: BRIDGE_ID, apiKey: BRIDGE_API_KEY, localUrl }),
  });

  if (!announceRes.ok) {
    const text = await announceRes.text().catch(() => '');
    console.error(`[bridge] bridgeAnnounce failed (${announceRes.status}): ${text}`);
    process.exit(1);
  }

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
  await app.listen(BRIDGE_PORT);

  // Register the HTTPS server so RegistrationService can hot-swap the TLS cert on IP change
  app.get(BridgeServerService).setServer(app.getHttpServer() as HttpsServer);

  console.log(`[bridge] HTTPS server listening at ${localUrl}`);
}

void bootstrap();
