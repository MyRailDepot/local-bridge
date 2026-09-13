import { Controller, Get } from '@nestjs/common';
import { Public } from '../auth/public.decorator';

@Controller()
export class HealthController {
  @Get('health')
  @Public()
  health(): { status: string; bridgeId: string; version: string } {
    return {
      status:   'ok',
      bridgeId: process.env['BRIDGE_ID'] ?? 'unknown',
      version:  '1.0.0',
    };
  }
}
