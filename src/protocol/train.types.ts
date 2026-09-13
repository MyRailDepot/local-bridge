export interface TrainLoco {
  rollingStockId: string;
  dccAddress: number;
  speedSteps?: 14 | 28 | 128; // Decoder speed step mode; used for proper DCC packet encoding
}

export interface Train {
  id: string;
  locos: TrainLoco[];
  createdAt: string; // ISO 8601
  speedStep?: number;  // 0–28 current commanded step
  direction?: 'forward' | 'reverse' | 'neutral';
  functions?: Record<number, boolean>; // fn index → active state
}

export interface SessionAccessory {
  id: string;
  dccAddress: number;
  controlModel: 'binary' | 'multi-aspect';
  position: 'active' | 'inactive' | null; // binary: current position; null = unknown
  aspectId: string | null;                 // multi-aspect: current aspect; null = unknown
  momentary?: boolean;
}

export interface DriveSession {
  infraId: string | null;
  trains: Train[];
  trackPower: boolean; // Whether track voltage is currently enabled
  accessories?: SessionAccessory[];
}
