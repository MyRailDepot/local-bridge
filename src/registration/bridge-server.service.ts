import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class BridgeServerService {
  private readonly logger = new Logger(BridgeServerService.name);
  private server: { setSecureContext(ctx: { cert: string; key: string }): void } | null = null;

  setServer(server: { setSecureContext(ctx: { cert: string; key: string }): void }): void {
    this.server = server;
  }

  updateTlsCert(cert: string, key: string): void {
    if (!this.server) {
      this.logger.warn('Cannot update TLS cert — server not yet initialized.');
      return;
    }
    this.server.setSecureContext({ cert, key });
    this.logger.log('TLS certificate updated in-place.');
  }
}
