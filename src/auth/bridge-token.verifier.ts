import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import * as jwt from 'jsonwebtoken';
import type { BridgeTokenPayload } from '../protocol/bridge.types';

export type { BridgeTokenPayload };

@Injectable()
export class BridgeTokenVerifier {
  private readonly logger = new Logger(BridgeTokenVerifier.name);
  private readonly secret = process.env['BRIDGE_API_KEY'] ?? '';

  verify(token: string): BridgeTokenPayload {
    if (!this.secret) throw new UnauthorizedException('Bridge API key not configured');

    let payload: BridgeTokenPayload;
    try {
      payload = jwt.verify(token, this.secret, { algorithms: ['HS256'] }) as BridgeTokenPayload;
    } catch (e) {
      this.logger.warn(`Bridge token verification failed: ${(e as Error).message}`);
      throw new UnauthorizedException('Token verification failed');
    }

    if (
      typeof payload.sub !== 'string' || !payload.sub ||
      typeof payload.workspaceId !== 'string' || !payload.workspaceId ||
      typeof payload.bridgeId !== 'string' || !payload.bridgeId ||
      !Array.isArray(payload.permissions)
    ) {
      this.logger.warn('Bridge token has malformed payload');
      throw new UnauthorizedException('Token verification failed');
    }

    if (payload.bridgeId !== (process.env['BRIDGE_ID'] ?? '')) {
      this.logger.warn(`Bridge token issued for ${payload.bridgeId}, not this bridge`);
      throw new UnauthorizedException('Token verification failed');
    }

    return payload;
  }
}
