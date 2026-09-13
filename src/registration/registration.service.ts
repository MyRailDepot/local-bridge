import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { getBridgeConfig, setBridgeConfig } from '../bridge-config';
import { detectLocalIp, buildLocalUrl } from '../lib/network';
import { BridgeServerService } from './bridge-server.service';

const BRIDGE_PORT          = parseInt(process.env['BRIDGE_PORT'] ?? '3000', 10);
const SAAS_BASE_URL        = process.env['SAAS_BASE_URL'] ?? 'https://myraildepot.com';
const IP_CHECK_INTERVAL_MS = 10_000;

@Injectable()
export class RegistrationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RegistrationService.name);
  private ipCheckId: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly bridgeServer: BridgeServerService) {}

  onModuleInit(): void {
    if (process.env['BRIDGE_URL']) {
      this.logger.log('BRIDGE_URL is set statically — IP change watcher disabled.');
      return;
    }
    this.ipCheckId = setInterval(() => void this.checkIpChange(), IP_CHECK_INTERVAL_MS);
    this.logger.log('IP change watcher started (10s interval)');
  }

  onModuleDestroy(): void {
    if (this.ipCheckId) clearInterval(this.ipCheckId);
  }

  private async checkIpChange(): Promise<void> {
    const ip = detectLocalIp();
    if (!ip) return;

    const newUrl = buildLocalUrl(ip, BRIDGE_PORT);
    const { localUrl: currentUrl } = getBridgeConfig();
    if (newUrl === currentUrl) return;

    this.logger.warn(`IP changed: ${currentUrl} → ${newUrl}`);

    try {
      const res = await fetch(`${SAAS_BASE_URL}/bridgeAnnounce`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bridgeId: process.env['BRIDGE_ID'],
          apiKey: process.env['BRIDGE_API_KEY'],
          localUrl: newUrl,
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        this.logger.error(`Re-announce failed (${res.status}): ${text}`);
        return;
      }

      const { cert, key } = await res.json() as { cert: string; key: string };

      setBridgeConfig({ ...getBridgeConfig(), localUrl: newUrl });
      this.bridgeServer.updateTlsCert(cert, key);
      this.logger.log(`Re-announced with new URL: ${newUrl}`);
    } catch (err) {
      this.logger.error(`Re-announce error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
