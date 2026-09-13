import { Module } from '@nestjs/common';
import { BlockSessionService } from './block-session.service';

@Module({
  providers: [BlockSessionService],
  exports:   [BlockSessionService],
})
export class BlockSessionModule {}
