import { Module } from '@nestjs/common';
import { CentralConfigService } from './central-config.service';

@Module({
  providers: [CentralConfigService],
  exports: [CentralConfigService],
})
export class CentralConfigModule {}
