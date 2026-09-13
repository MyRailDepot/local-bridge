import { Module } from '@nestjs/common';
import { RegistrationService } from './registration.service';
import { BridgeServerService } from './bridge-server.service';

@Module({
  providers: [RegistrationService, BridgeServerService],
  exports: [BridgeServerService],
})
export class RegistrationModule {}
