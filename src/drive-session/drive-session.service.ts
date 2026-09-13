import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { DriveSession, SessionAccessory, Train, TrainLoco } from '../protocol/train.types';

@Injectable()
export class DriveSessionService {
  private session: DriveSession = { infraId: null, trains: [], trackPower: false };

  readonly change$ = new Subject<DriveSession>();

  getSession(): DriveSession {
    return this.session;
  }

  setInfra(infraId: string): void {
    this.session = { ...this.session, infraId };
    this.change$.next(this.session);
  }

  setTrackPower(on: boolean): void {
    this.session = { ...this.session, trackPower: on };
    this.change$.next(this.session);
  }

  addTrain(rsId: string, dccAddress: number, speedSteps?: 14 | 28 | 128): Train {
    const train: Train = {
      id: randomUUID(),
      locos: [{ rollingStockId: rsId, dccAddress, speedSteps }],
      createdAt: new Date().toISOString(),
      speedStep: 0,
      direction: 'forward',
    };
    this.session = { ...this.session, trains: [...this.session.trains, train] };
    this.change$.next(this.session);
    return train;
  }

  addLoco(trainId: string, rsId: string, dccAddress: number, speedSteps?: 14 | 28 | 128): Train {
    const train = this.session.trains.find(t => t.id === trainId);
    if (!train) throw new Error(`Train ${trainId} not found`);
    const loco: TrainLoco = { rollingStockId: rsId, dccAddress, speedSteps };
    const updated: Train = { ...train, locos: [...train.locos, loco] };
    this.session = {
      ...this.session,
      trains: this.session.trains.map(t => t.id === trainId ? updated : t),
    };
    this.change$.next(this.session);
    return updated;
  }

  setSpeed(trainId: string, speedStep: number, direction: 'forward' | 'reverse' | 'neutral'): Train {
    const train = this.session.trains.find(t => t.id === trainId);
    if (!train) throw new Error(`Train ${trainId} not found`);
    const actualStep = direction === 'neutral' ? 0 : speedStep;
    const updated: Train = { ...train, speedStep: actualStep, direction };
    this.session = {
      ...this.session,
      trains: this.session.trains.map(t => t.id === trainId ? updated : t),
    };
    this.change$.next(this.session);
    return updated;
  }

  setFunction(trainId: string, fn: number, active: boolean): Train {
    const train = this.session.trains.find(t => t.id === trainId);
    if (!train) throw new Error(`Train ${trainId} not found`);
    const functions = { ...(train.functions ?? {}), [fn]: active };
    const updated: Train = { ...train, functions };
    this.session = {
      ...this.session,
      trains: this.session.trains.map(t => t.id === trainId ? updated : t),
    };
    this.change$.next(this.session);
    return updated;
  }

  removeTrain(id: string): void {
    this.session = { ...this.session, trains: this.session.trains.filter(t => t.id !== id) };
    this.change$.next(this.session);
  }

  releaseAll(): void {
    this.session = { ...this.session, trains: [] };
    this.change$.next(this.session);
  }

  setAccessories(list: SessionAccessory[]): void {
    this.session = { ...this.session, accessories: list };
    this.change$.next(this.session);
  }

  setAccessoryState(
    id: string,
    update: { position?: 'active' | 'inactive'; aspectId?: string },
  ): SessionAccessory {
    const acc = (this.session.accessories ?? []).find(a => a.id === id);
    if (!acc) throw new Error(`Accessory ${id} not found in session`);

    if (update.position !== undefined && acc.controlModel === 'multi-aspect') {
      throw new Error(`controlModel mismatch: cannot set position on multi-aspect accessory ${id}`);
    }
    if (update.aspectId !== undefined && acc.controlModel === 'binary') {
      throw new Error(`controlModel mismatch: cannot set aspectId on binary accessory ${id}`);
    }

    const updated: SessionAccessory = {
      ...acc,
      ...(update.position !== undefined ? { position: update.position } : {}),
      ...(update.aspectId !== undefined ? { aspectId: update.aspectId } : {}),
    };
    this.session = {
      ...this.session,
      accessories: (this.session.accessories ?? []).map(a => a.id === id ? updated : a),
    };
    this.change$.next(this.session);
    return updated;
  }

  endSession(): void {
    this.session = { infraId: null, trains: [], trackPower: false };
    this.change$.next(this.session);
  }
}
