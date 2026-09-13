import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { CentralModule } from '../central/central.module';
import { BlockSessionModule } from '../block-session/block-session.module';
import { DriveSessionController } from './drive-session.controller';
import { DriveSessionService } from './drive-session.service';

@Module({
  imports: [CentralModule, AuthModule, BlockSessionModule],
  controllers: [DriveSessionController],
  providers: [DriveSessionService],
  exports: [DriveSessionService],
})
export class DriveSessionModule {}
