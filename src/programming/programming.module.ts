import { Module } from '@nestjs/common';
import { CentralModule } from '../central/central.module';
import { ProgrammingController } from './programming.controller';
import { ProgrammingService } from './programming.service';

@Module({
  imports: [CentralModule],
  controllers: [ProgrammingController],
  providers: [ProgrammingService],
})
export class ProgrammingModule {}
