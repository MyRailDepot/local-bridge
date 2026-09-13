export interface CentralConfig {
  id: string;
  name: string;
  type: string;
  network: { host: string; port: number };
}

export type CentralStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface CentralConnectionStatus {
  id: string;
  name: string;
  type: string;
  status: CentralStatus;
}
