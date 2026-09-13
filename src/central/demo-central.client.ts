import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import type { CentralStatus } from './central.types';

const DEMO_CONNECT_DELAY_MS = 300;

/**
 * Fake central for DEMO_MODE=true.
 * Reports as "connected" after a short delay, logs drive commands, returns zero for CV reads.
 * Has the same duck-type interface as Z21Client so CentralManagerService can use it transparently.
 */
export class DemoCentralClient extends EventEmitter {
  private readonly logger = new Logger('DemoCentral');
  private _status: CentralStatus = 'connecting';

  constructor(private readonly id: string) {
    super();
    setTimeout(() => {
      this.logger.log(`[${this.id}] Demo central connected.`);
      this._status = 'connected';
      this.emit('status', 'connected' satisfies CentralStatus);
    }, DEMO_CONNECT_DELAY_MS);
  }

  get status(): CentralStatus { return this._status; }

  get engines() {
    return {
      setDriveEngine: (address: number, speed: number, forward: boolean) => {
        this.logger.log(`[${this.id}] setDriveEngine(addr=${address}, speed=${speed}, fwd=${forward})`);
      },
      cvRead: async (cv: number) => {
        this.logger.log(`[${this.id}] cvRead(${cv}) → 0 [demo]`);
        return { value: 0 };
      },
      cvWrite: async (cv: number, value: number) => {
        this.logger.log(`[${this.id}] cvWrite(${cv}, ${value}) [demo]`);
        return { value };
      },
      cvReadIndexed: async (indexHigh: number, indexLow: number, cv: number) => {
        this.logger.log(`[${this.id}] cvReadIndexed(${indexHigh}, ${indexLow}, ${cv}) → 0 [demo]`);
        return { value: 0 };
      },
    };
  }

  get system() {
    return {
      getStatus:     async () => {},
      emergencyStop: async () => { this.logger.log(`[${this.id}] emergencyStop [demo]`); },
    };
  }

  setLocoSpeed(address: number, speed: number, forward: boolean, engineSpeedSteps?: number): void {
    this.logger.log(`[${this.id}] setLocoSpeed(addr=${address}, speed=${speed}, fwd=${forward}, steps=${engineSpeedSteps ?? 128}) [demo]`);
  }

  setTrackPower(on: boolean): void {
    this.logger.log(`[${this.id}] setTrackPower(${on}) [demo]`);
  }

  setLocoFunction(address: number, fn: number, active: boolean): void {
    this.logger.log(`[${this.id}] setLocoFunction(addr=${address}, fn=${fn}, active=${active}) [demo]`);
  }

  async emergencyStop(): Promise<void> {
    this.logger.log(`[${this.id}] emergencyStop [demo]`);
  }

  setAccessory(address: number, active: boolean, momentary: boolean): void {
    this.logger.log(`[${this.id}] setAccessory(addr=${address}, active=${active}, momentary=${momentary}) [demo]`);
  }

  setExtAccessory(address: number, aspectValue: number): void {
    this.logger.log(`[${this.id}] setExtAccessory(addr=${address}, aspect=${aspectValue}) [demo]`);
  }

  pollRmbusGroup(_groupIndex: 0 | 1): void { /* no-op in demo mode */ }
  pollLoconetDetectors(): void { /* no-op in demo mode */ }
  pollCanDetectors(): void { /* no-op in demo mode */ }

  destroy(): void {}
}
