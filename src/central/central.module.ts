import { Module } from '@nestjs/common';
import { CentralManagerService } from './central-manager.service';

@Module({
  providers: [CentralManagerService],
  exports:   [CentralManagerService],
})
export class CentralModule {}
