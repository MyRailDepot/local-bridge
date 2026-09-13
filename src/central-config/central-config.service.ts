import { Injectable } from '@nestjs/common';
import { getBridgeConfig } from '../bridge-config';

@Injectable()
export class CentralConfigService {
  get centralConfigs() {
    return getBridgeConfig().centralConfigs;
  }
}
