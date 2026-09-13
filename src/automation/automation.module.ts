import { Module } from '@nestjs/common';
import { BlockSessionModule } from '../block-session/block-session.module';
import { DriveSessionModule } from '../drive-session/drive-session.module';
import { AutomationService } from './automation.service';

@Module({
  imports: [BlockSessionModule, DriveSessionModule],
  providers: [AutomationService],
})
export class AutomationModule {}
