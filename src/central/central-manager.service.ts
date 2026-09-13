import { Injectable, OnModuleDestroy, OnModuleInit, Logger } from '@nestjs/common';
import { Subject } from 'rxjs';
import { getBridgeConfig } from '../bridge-config';
import type { CentralConfig, CentralConnectionStatus, CentralStatus } from './central.types';
import { Z21Client } from './z21/z21.client';
import type { OccupancyUpdate } from './z21/z21.client';
import type { PollPlan } from '../block-session/block-session.service';
import { DemoCentralClient } from './demo-central.client';

const DEMO_MODE = process.env['DEMO_MODE'] === 'true';

// Both Z21Client and DemoCentralClient share the same duck-type interface.
type AnyClient = Z21Client | DemoCentralClient;

@Injectable()
export class CentralManagerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CentralManagerService.name);
  private readonly clients = new Map<string, AnyClient>();
  private readonly statuses = new Map<string, CentralConnectionStatus>();

  readonly statusChange$ = new Subject<CentralConnectionStatus[]>();
  readonly trackPower$   = new Subject<boolean>();
  readonly occupancy$    = new Subject<OccupancyUpdate>();

  onModuleInit(): void {
    const { centralConfigs } = getBridgeConfig();

    for (const config of centralConfigs) {
      if (DEMO_MODE) {
        this.initDemoClient(config);
      } else {
        this.initZ21Client(config);
      }
    }

    // No centrals configured in demo mode → inject a standalone demo central
    if (DEMO_MODE && centralConfigs.length === 0) {
      this.initDemoClient({ id: 'demo', name: 'Demo Z21', type: 'z21' });
    }

    this.logger.log(`Managing ${this.clients.size} central(s)${DEMO_MODE ? ' [DEMO MODE]' : ''}.`);
  }

  onModuleDestroy(): void {
    for (const client of this.clients.values()) client.destroy();
  }

  getAll(): CentralConnectionStatus[] {
    return Array.from(this.statuses.values());
  }

  getClient(centralId: string): AnyClient | undefined {
    return this.clients.get(centralId);
  }

  setLocoSpeed(address: number, speed: number, forward: boolean, engineSpeedSteps?: number): void {
    for (const client of this.clients.values()) {
      if (client.status === 'connected') client.setLocoSpeed(address, speed, forward, engineSpeedSteps);
    }
  }

  setTrackPower(on: boolean): void {
    for (const client of this.clients.values()) {
      if (client.status === 'connected') client.setTrackPower(on);
    }
  }

  setLocoFunction(address: number, fn: number, active: boolean): void {
    for (const client of this.clients.values()) {
      if (client.status === 'connected') client.setLocoFunction(address, fn, active);
    }
  }

  setAccessoryOutput(dccAddress: number, activate: boolean, momentary: boolean): void {
    for (const client of this.clients.values()) {
      if (client.status === 'connected') client.setAccessory(dccAddress, activate, momentary);
    }
  }

  setExtendedAccessory(dccAddress: number, aspectValue: number): void {
    // DCC address 2044 is reserved for the extended emergency stop broadcast — never send it.
    if (dccAddress < 1 || dccAddress > 2043) {
      this.logger.error(`setExtendedAccessory: dccAddress ${dccAddress} out of range 1–2043 — command dropped.`);
      return;
    }
    for (const client of this.clients.values()) {
      if (client.status === 'connected') client.setExtAccessory(dccAddress, aspectValue);
    }
  }

  /** Run a block poll plan against every connected central. */
  executePollPlan(plan: PollPlan): void {
    for (const client of this.connectedClients()) {
      for (const groupIndex of plan.rbusGroups) client.pollRmbusGroup(groupIndex);
      if (plan.loconet) client.pollLoconetDetectors();
      if (plan.can) client.pollCanDetectors();
    }
  }

  private *connectedClients(): Iterable<AnyClient> {
    for (const client of this.clients.values()) {
      if (client.status === 'connected') yield client;
    }
  }

  async emergencyStopAll(): Promise<void> {
    const connected = Array.from(this.clients.values()).filter(c => c.status === 'connected');
    await Promise.allSettled(connected.map(c => c.emergencyStop()));
    this.logger.warn(`E-STOP sent to ${connected.length} central(s).`);
  }

  private initZ21Client(config: CentralConfig): void {
    this.statuses.set(config.id, { id: config.id, name: config.name, type: config.type, status: 'connecting' });

    if (config.type !== 'z21') {
      this.logger.warn(`Unknown central type "${config.type}" for "${config.name}" — skipped.`);
      this.setStatus(config.id, 'error');
      return;
    }

    const z21Debug = process.env['Z21_DEBUG'] === 'true';
    const client = new Z21Client(config.id, config.network.host, config.network.port, z21Debug);
    client.on('status', (s: CentralStatus) => {
      this.logger.log(`[${config.name}] ${s}`);
      this.setStatus(config.id, s);
    });
    client.on('trackPower', (on: boolean) => {
      this.logger.log(`[${config.name}] trackPower: ${on ? 'ON' : 'OFF'}`);
      this.trackPower$.next(on);
    });
    client.on('occupancy', (update: OccupancyUpdate) => {
      this.occupancy$.next(update);
    });
    this.clients.set(config.id, client);
  }

  private initDemoClient(config: Pick<CentralConfig, 'id' | 'name' | 'type'>): void {
    this.statuses.set(config.id, { id: config.id, name: config.name, type: config.type, status: 'connecting' });
    const client = new DemoCentralClient(config.id);
    client.on('status', (s: CentralStatus) => {
      this.logger.log(`[${config.name}] ${s}`);
      this.setStatus(config.id, s);
    });
    this.clients.set(config.id, client);
  }

  private setStatus(id: string, status: CentralConnectionStatus['status']): void {
    const entry = this.statuses.get(id);
    if (!entry || entry.status === status) return;
    entry.status = status;
    this.statusChange$.next(this.getAll());
  }
}
