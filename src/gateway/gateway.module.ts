import { Module } from '@nestjs/common';
import { BridgeGateway } from './bridge.gateway';
import { CentralModule } from '../central/central.module';
import { AuthModule } from '../auth/auth.module';
import { DriveSessionModule } from '../drive-session/drive-session.module';
import { BlockSessionModule } from '../block-session/block-session.module';

@Module({
  imports:   [CentralModule, AuthModule, DriveSessionModule, BlockSessionModule],
  providers: [BridgeGateway],
})
export class GatewayModule {}
