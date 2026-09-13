import { EventEmitter } from 'node:events';
import { Logger } from '@nestjs/common';
import { Z21Client as Z21LibClient } from 'z21-client';
import type { FeedbackBus, OccupancyChannel } from 'z21-client';
import type { CentralStatus } from '../central.types';

/**
 * One `occupancy` update from the Z21, forwarded verbatim from z21-client.
 * `channels` carries an explicit `occupied` boolean per channel, so consumers
 * never have to infer "absent module = clear" the way the old S88 feed did.
 */
export interface OccupancyUpdate {
  bus: FeedbackBus;
  channels: OccupancyChannel[];
}

// Fast pings until the first connection is established
const CONNECT_PING_INTERVAL_MS = 5_000;
// If no events received for this long while connected, send one liveness ping
const IDLE_TIMEOUT_MS = 60_000;
// How long to wait for a pong before declaring the connection dead
const PONG_TIMEOUT_MS = 5_000;

// Events that prove the Z21 is alive but don't confirm connection on their own.
// 'status', 'trackPower', and 'occupancy' are handled separately.
const LIVENESS_EVENTS = [
  'cvResult', 'broadcastFlags',
  'engineInfo', 'programmingMode', 'shortCircuit',
  'accessoryInfo', 'serialNumber',
] as const;

export class Z21Client extends EventEmitter {
  private readonly logger = new Logger(Z21Client.name);
  private readonly lib: Z21LibClient;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout>  | null = null;
  private idleTimer: ReturnType<typeof setTimeout>  | null = null;
  private _status: CentralStatus = 'connecting';

  constructor(
    private readonly id: string,
    host: string,
    port: number = 21105,
    debug: boolean = false,
  ) {
    super();
    this.lib = new Z21LibClient(host, port, debug);

    // 'status' is the pong to our getStatus() ping — confirms connection.
    // The status string also encodes the initial track power state:
    // "Unknown Status" = 0x00 = normal operation = track power ON.
    this.lib.on('status', (payload: string) => {
      this.logger.debug(`[${this.id}] ← status: ${payload}`);
      this.clearPongTimer();
      this.onReceivedFromZ21();
      this.setStatus('connected');
      // Emergency Stop (LAN_X_SET_STOP) keeps track power ON — only "Track Voltage Off"
      // means the track is physically de-energised. Don't conflate the two.
      const on = payload !== 'Track Voltage Off';
      this.emit('trackPower', on);
      // Add the LocoNet + CAN detector broadcasts on top of the library default
      // (driving | rbus | railcom), so all three feedback buses are subscribed on (re)connect.
      this.lib.system.setBroadcastFlags({ loconetDetector: true, canDetector: true }).catch((err: unknown) => {
        this.logger.warn(`[${this.id}] setBroadcastFlags failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    });

    // 'occupancy' carries R-BUS / LocoNet / CAN track occupation data — forward the
    // payload so consumers can map (bus, module, channel) to block states.
    this.lib.on('occupancy', (update: OccupancyUpdate) => {
      this.logger.debug(`[${this.id}] ← occupancy: ${update.bus} ${update.channels.length} channel(s)`);
      this.onReceivedFromZ21();
      this.emit('occupancy', update);
    });

    // 'trackPower' fires on LAN_X_BC_TRACK_POWER_OFF/ON (physical power change).
    this.lib.on('trackPower', (value: string) => {
      this.logger.debug(`[${this.id}] ← trackPower: ${value}`);
      this.onReceivedFromZ21();
      this.emit('trackPower', value === 'on');
    });

    // 'stopped' fires on LAN_X_BC_STOPPED (0x81) — global E-STOP broadcast.
    // Track power stays ON; decoders halt until LAN_X_TRACK_POWER_ON is received.
    this.lib.on('stopped', () => {
      this.logger.debug(`[${this.id}] ← LAN_X_BC_STOPPED`);
      this.onReceivedFromZ21();
    });

    // All other Z21 events: proof the connection is alive, reset idle timer
    for (const event of LIVENESS_EVENTS) {
      this.lib.on(event, () => {
        this.logger.debug(`[${this.id}] ← ${event}`);
        this.onReceivedFromZ21();
      });
    }

    this.lib.on('error', (err: unknown) => {
      // Protocol-level NACKs { code: "nack" | "nack-sc" | "invalid-payload", message }
      // are Z21 decoder responses, not connection failures — ignore them here.
      if (err !== null && typeof err === 'object' && 'code' in err) {
        this.logger.debug(`[${this.id}] protocol error (not a disconnect): ${JSON.stringify(err)}`);
        return;
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[${this.id}] socket error → disconnecting: ${msg}`);
      this.stopIdleTimer();
      this.setStatus('error');
      this.startPingLoop();
    });

    // Start pinging rapidly until first connection
    this.startPingLoop();
  }

  get status(): CentralStatus { return this._status; }

  /** Access to the underlying library for programming operations. */
  get engines() { return this.lib.engines; }
  get system()  { return this.lib.system; }

  setLocoSpeed(address: number, speed: number, forward: boolean, engineSpeedSteps?: number): void {
    this.lib.engines.setDriveEngine(address, speed, forward, engineSpeedSteps);
  }

  setTrackPower(on: boolean): void {
    const op = on ? this.lib.system.setTrackPowerOn() : this.lib.system.setTrackPowerOff();
    op.catch((err: unknown) => {
      this.logger.warn(`[${this.id}] setTrackPower(${on}) failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  setLocoFunction(address: number, fn: number, active: boolean): void {
    // Fire-and-forget DCC command; the bus repeats each packet, so a dropped
    // promise here is acceptable.
    void this.lib.engines.setEngineFunctions(address, fn, active ? 'on' : 'off');
  }

  // Pulse duration for solenoid accessories. The DCC bus repeats each packet 2-4 times,
  // so we need to leave enough room for the deactivate to land cleanly before the next command.
  private static readonly TURNOUT_PULSE_MS = 150;

  // Per-address serialisation for momentary accessories.
  // activePulse: resolves when the in-flight pulse (activate + delay + deactivate) is done.
  // nextOutput: the output bit queued while a pulse is in flight — only the latest is kept.
  private readonly activePulse = new Map<number, Promise<void>>();
  private readonly nextOutput  = new Map<number, boolean>();

  setAccessory(address: number, active: boolean, momentary: boolean): void {
    if (!momentary) {
      // Steady-state accessories (light, signal, other): maintain the requested output level.
      // output=false → coil 1 (straight / inactive), output=true → coil 2 (diverging / active)
      this.lib.accessories.setBasicAccessory(address, active, active).catch((err: unknown) => {
        this.logger.warn(`[${this.id}] setAccessory(${address}, ${active}) failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      return;
    }

    if (this.activePulse.has(address)) {
      // A pulse is already running — replace any pending next command with the latest request.
      // This way rapid clicks never stack up, but the last intent is always honoured.
      this.nextOutput.set(address, active);
      return;
    }

    this.runPulse(address, active);
  }

  private runPulse(address: number, active: boolean): void {
    const output = active; // false → coil 1 (straight), true → coil 2 (diverging)
    const promise = this.lib.accessories.setBasicAccessory(address, output, true)
      .then(() => new Promise<void>(resolve => setTimeout(resolve, Z21Client.TURNOUT_PULSE_MS)))
      .then(() => this.lib.accessories.setBasicAccessory(address, output, false))
      .then(() => {
        this.activePulse.delete(address);
        const next = this.nextOutput.get(address);
        if (next !== undefined) {
          this.nextOutput.delete(address);
          this.runPulse(address, next);
        }
      })
      .catch((err: unknown) => {
        this.activePulse.delete(address);
        this.nextOutput.delete(address);
        this.logger.warn(`[${this.id}] setAccessory(${address}, ${active}) pulse failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    this.activePulse.set(address, promise);
  }

  setExtAccessory(address: number, aspectValue: number): void {
    this.lib.accessories.setExtAccessory(address, aspectValue).catch((err: unknown) => {
      this.logger.warn(`[${this.id}] setExtAccessory(${address}, ${aspectValue}) failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Poll one R-BUS feedback group (0 = modules 1–10, 1 = modules 11–20). */
  pollRmbusGroup(groupIndex: 0 | 1): void {
    this.lib.system.getRmbusData(groupIndex).catch((err: unknown) => {
      this.logger.warn(`[${this.id}] pollRmbusGroup(${groupIndex}) failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Poll all LocoNet occupancy detectors (SIC request — Digitrax / Blücher). */
  pollLoconetDetectors(): void {
    this.lib.system.getLoconetDetector(0x80).catch((err: unknown) => {
      this.logger.warn(`[${this.id}] pollLoconetDetectors failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /** Poll all CAN occupancy detectors (broadcast NID). */
  pollCanDetectors(): void {
    this.lib.system.getCanDetector().catch((err: unknown) => {
      this.logger.warn(`[${this.id}] pollCanDetectors failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private onReceivedFromZ21(): void {
    // Stop connect-phase pinging, switch to idle monitoring
    this.stopPingLoop();
    this.resetIdleTimer();
  }

  private startPingLoop(): void {
    if (this.pingTimer) return;
    this.ping();
    this.pingTimer = setInterval(() => this.ping(), CONNECT_PING_INTERVAL_MS);
  }

  private stopPingLoop(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    this.clearPongTimer();
  }

  private resetIdleTimer(): void {
    this.stopIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.logger.debug(`[${this.id}] idle for ${IDLE_TIMEOUT_MS}ms — pinging to verify`);
      this.startPingLoop();
    }, IDLE_TIMEOUT_MS);
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  private ping(): void {
    this.logger.debug(`[${this.id}] → getStatus (status=${this._status})`);
    this.lib.system.getStatus().catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`[${this.id}] ping rejected: ${msg}`);
      this.setStatus('error');
    });
    this.pongTimer = setTimeout(() => {
      this.logger.warn(`[${this.id}] pong timeout after ${PONG_TIMEOUT_MS}ms`);
      this.setStatus('disconnected');
    }, PONG_TIMEOUT_MS);
  }

  private clearPongTimer(): void {
    if (this.pongTimer) { clearTimeout(this.pongTimer); this.pongTimer = null; }
  }

  private setStatus(next: CentralStatus): void {
    if (this._status === next) return;
    this.logger.log(`[${this.id}] ${this._status} → ${next}`);
    this._status = next;
    this.emit('status', next);
  }

  async emergencyStop(): Promise<void> {
    await this.lib.system.emergencyStop().catch((err: unknown) => {
      this.logger.warn(`[${this.id}] emergencyStop failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  destroy(): void {
    this.stopPingLoop();
    this.stopIdleTimer();
    this.lib.close().catch(() => {});
  }
}
