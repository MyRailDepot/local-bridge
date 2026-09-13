import { Controller, Post, Body } from '@nestjs/common';
import { ProgrammingService } from './programming.service';

class CvReadDto         { centralId!: string; cv!: number; }
class CvWriteDto        { centralId!: string; cv!: number; value!: number; }
class CvReadManyDto     { centralId!: string; cvs!: number[]; }
class CvWriteManyDto    { centralId!: string; cvs!: Array<{ cv: number; value: number }>; }
class CvReadIndexedDto  { centralId!: string; indexHigh!: number; indexLow!: number; cv!: number; }

@Controller('programming')
export class ProgrammingController {
  constructor(private readonly programming: ProgrammingService) {}

  @Post('cv/read')
  cvRead(@Body() body: CvReadDto) {
    return this.programming.cvRead(body.centralId, body.cv);
  }

  @Post('cv/write')
  cvWrite(@Body() body: CvWriteDto) {
    return this.programming.cvWrite(body.centralId, body.cv, body.value);
  }

  @Post('cv/read-many')
  cvReadMany(@Body() body: CvReadManyDto) {
    return this.programming.cvReadMany(body.centralId, body.cvs);
  }

  @Post('cv/write-many')
  cvWriteMany(@Body() body: CvWriteManyDto) {
    return this.programming.cvWriteMany(body.centralId, body.cvs);
  }

  @Post('cv/read-indexed')
  cvReadIndexed(@Body() body: CvReadIndexedDto) {
    return this.programming.cvReadIndexed(body.centralId, body.indexHigh, body.indexLow, body.cv);
  }
}
