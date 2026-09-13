import type { CentralConfig } from './central/central.types';

export interface BridgeConfig {
  localUrl: string;
  centralConfigs: CentralConfig[];
}

let _config: BridgeConfig | null = null;

export function setBridgeConfig(config: BridgeConfig): void {
  _config = config;
}

export function getBridgeConfig(): BridgeConfig {
  if (!_config) throw new Error('BridgeConfig not initialized. Call setBridgeConfig() in main.ts first.');
  return _config;
}
