import { describe, it, before, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { setBridgeConfig } from '../bridge-config.ts';
import { BridgeServerService } from './bridge-server.service.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let RegistrationService: any;

before(async () => {
  // Import the module BEFORE BRIDGE_ID/BRIDGE_API_KEY exist in process.env, on purpose: a module-scope
  // `const BRIDGE_ID = process.env['BRIDGE_ID']!` would freeze to `undefined` right here, at import
  // time — this is exactly the ordering hazard this test exists to catch. A correct, lazy-read
  // implementation only reads process.env when checkIpChange() actually runs, later in this file.
  // Dynamic import (not a static one) because esbuild/tsx hoists static imports to the top of the
  // compiled output regardless of source position — only a runtime import() actually defers loading
  // to this exact point.
  delete process.env['BRIDGE_ID'];
  delete process.env['BRIDGE_API_KEY'];
  ({ RegistrationService } = await import('./registration.service.ts'));
});

function makeService(): InstanceType<typeof RegistrationService> {
  return new RegistrationService(new BridgeServerService());
}

// checkIpChange() is private; casting to call it directly is simpler and more readable here than
// routing through onModuleInit() + fake timers just to reach the same code path.
function triggerIpCheck(service: InstanceType<typeof RegistrationService>): Promise<void> {
  return (service as unknown as { checkIpChange(): Promise<void> }).checkIpChange();
}

beforeEach(() => {
  // A local URL guaranteed to differ from whatever buildLocalUrl() computes from the machine's real
  // IP, so checkIpChange() always detects a change and proceeds to the announce call.
  setBridgeConfig({ localUrl: 'https://old-address.bridge.myraildepot.com:3000', centralConfigs: [] });
});

afterEach(() => {
  mock.reset();
  delete process.env['BRIDGE_ID'];
  delete process.env['BRIDGE_API_KEY'];
});

describe('RegistrationService', () => {
  it('reads BRIDGE_ID/BRIDGE_API_KEY at call time, not at module-import time', async () => {
    // Set these AFTER the module was already imported in before() above — a module-scope const would
    // never see them.
    process.env['BRIDGE_ID'] = 'bridge-in-test';
    process.env['BRIDGE_API_KEY'] = 'key-in-test';

    const fetchMock = mock.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ cert: 'cert-pem', key: 'key-pem' }),
    }));
    mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch);

    await triggerIpCheck(makeService());

    assert.equal(fetchMock.mock.calls.length, 1);
    const [, init] = fetchMock.mock.calls[0]!.arguments as [string, RequestInit];
    const body = JSON.parse(init.body as string) as { bridgeId?: string; apiKey?: string };
    assert.equal(body.bridgeId, 'bridge-in-test');
    assert.equal(body.apiKey, 'key-in-test');
  });

  it('posts to SAAS_BASE_URL/bridgeAnnounce with the new local URL', async () => {
    process.env['BRIDGE_ID'] = 'bridge-in-test';
    process.env['BRIDGE_API_KEY'] = 'key-in-test';

    const fetchMock = mock.fn(async (_url: string, _init: RequestInit) => ({
      ok: true,
      json: async () => ({ cert: 'cert-pem', key: 'key-pem' }),
    }));
    mock.method(globalThis, 'fetch', fetchMock as unknown as typeof fetch);

    await triggerIpCheck(makeService());

    const [url] = fetchMock.mock.calls[0]!.arguments as [string, RequestInit];
    assert.equal(url, 'https://myraildepot.com/bridgeAnnounce');
  });

  it('logs and returns without throwing when the re-announce call fails', async () => {
    process.env['BRIDGE_ID'] = 'bridge-in-test';
    process.env['BRIDGE_API_KEY'] = 'key-in-test';

    mock.method(globalThis, 'fetch', (async () => ({
      ok: false,
      status: 500,
      text: async () => 'boom',
    })) as unknown as typeof fetch);

    await assert.doesNotReject(() => triggerIpCheck(makeService()));
  });
});
