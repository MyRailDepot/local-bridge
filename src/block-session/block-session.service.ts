import { Injectable } from '@nestjs/common';
import { Subject } from 'rxjs';
import type { Block, BlockState, FeedbackBus } from '../protocol/block.types';
import type { OccupancyUpdate } from '../central/z21/z21.client';

/**
 * Which feedback buses need an explicit poll on session load, and which R-BUS
 * groups to ask for. R-BUS only ever has two groups (modules 1–10 and 11–20).
 */
export interface PollPlan {
  rbusGroups: (0 | 1)[];
  loconet: boolean;
  can: boolean;
}

/**
 * How long a block keeps showing "occupied" after its detector reports free.
 *
 * Current-sensing S88 detectors chatter at insulated block joints: as a loco
 * crosses, contact makes/breaks for a few hundred ms and the two adjacent
 * detectors trade the current back and forth. The Z21 reports every transition
 * raw. Holding the free edge for a bit lets a re-occupy cancel it, so the block
 * never flickers free during a hand-off. Occupied is always applied immediately.
 *
 * TODO(backlog): make this configurable, ideally per-block.
 */
export const RELEASE_DELAY_MS = 700;

/** What a single (bus, module, channel) address is bound to. */
interface BlockBinding {
  blockId: string;
  bus: FeedbackBus;
  module: number;
  channel: number;
}

@Injectable()
export class BlockSessionService {
  readonly change$ = new Subject<BlockState[]>();

  // `${bus}:${module}:${channel}` → binding. The key is only an index for O(1)
  // occupancy lookup; the structured fields live on the value so nothing has to
  // parse the key back apart.
  private readonly lookup = new Map<string, BlockBinding>();
  // blockId → occupied
  private readonly states = new Map<string, boolean>();
  // Blocks whose detector reported free and are waiting out RELEASE_DELAY_MS.
  // One shared timer flushes them together so a multi-block release still
  // broadcasts a single change$.
  private readonly pendingReleases = new Set<string>();
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;

  private static key(bus: FeedbackBus, module: number, channel: number): string {
    return `${bus}:${module}:${channel}`;
  }

  setBlocks(blocks: Block[]): void {
    // Carry forward occupation states already known from Z21 events. Without this,
    // a PWA reload triggers PUT /session/blocks which would reset every state to
    // false; the Z21 sends no occupancy events while nothing moves, so the UI
    // would show all blocks free even with a train sitting on one.
    const prevStates = new Map(this.states);

    this.cancelPendingReleases();
    this.lookup.clear();
    this.states.clear();

    for (const block of blocks) {
      const { feedbackBus: bus, feedbackModule: module, feedbackChannel: channel } = block;
      const k = BlockSessionService.key(bus, module, channel);
      if (this.lookup.has(k)) {
        // Duplicate (bus, module, channel) triple — keep the first, drop the rest.
        continue;
      }
      this.lookup.set(k, { blockId: block.id, bus, module, channel });
      this.states.set(block.id, prevStates.get(block.id) ?? false);
    }

    this.change$.next(this.getStates());
  }

  /**
   * Apply an occupancy update from one feedback bus. Every channel in the update
   * carries an explicit `occupied` flag, so a channel we track is set directly —
   * no "module absent = clear" inference. Channels that map to no block (and
   * updates on a bus we don't use) are ignored.
   *
   * Occupied is applied immediately. Free is deferred by RELEASE_DELAY_MS so a
   * detector bounce (free → re-occupy) at a block joint never surfaces as a flap.
   */
  processOccupancy(update: OccupancyUpdate): void {
    let changed = false;

    for (const ch of update.channels) {
      const binding = this.lookup.get(BlockSessionService.key(update.bus, ch.address, ch.channel));
      if (binding === undefined) continue;
      const id = binding.blockId;

      if (ch.occupied) {
        // Occupied wins now and cancels any pending release for this block.
        if (this.pendingReleases.delete(id) && this.pendingReleases.size === 0) {
          this.stopReleaseTimer();
        }
        if (this.states.get(id) !== true) {
          this.states.set(id, true);
          changed = true;
        }
      } else if (this.states.get(id) === true) {
        // Free is held: remember it and let the shared timer flush it later.
        this.pendingReleases.add(id);
        if (this.releaseTimer === undefined) {
          this.releaseTimer = setTimeout(() => this.flushReleases(), RELEASE_DELAY_MS);
          this.releaseTimer.unref?.();
        }
      }
    }

    if (changed) this.change$.next(this.getStates());
  }

  /** Apply every pending free at once, in a single change$ emission. */
  private flushReleases(): void {
    this.releaseTimer = undefined;
    let changed = false;
    for (const id of this.pendingReleases) {
      if (this.states.get(id) === true) {
        this.states.set(id, false);
        changed = true;
      }
    }
    this.pendingReleases.clear();
    if (changed) this.change$.next(this.getStates());
  }

  private stopReleaseTimer(): void {
    if (this.releaseTimer !== undefined) {
      clearTimeout(this.releaseTimer);
      this.releaseTimer = undefined;
    }
  }

  private cancelPendingReleases(): void {
    this.stopReleaseTimer();
    this.pendingReleases.clear();
  }

  getStates(): BlockState[] {
    return Array.from(this.states.entries()).map(([blockId, occupied]) => ({ blockId, occupied }));
  }

  /**
   * Poll instructions for the registered blocks: which R-BUS groups to fetch
   * and whether LocoNet / CAN detectors should be queried.
   * feedbackModule is 1-indexed (module 1 → group 0).
   */
  getPollPlan(): PollPlan {
    const rbusGroups = new Set<0 | 1>();
    let loconet = false;
    let can = false;

    for (const { bus, module } of this.lookup.values()) {
      if (bus === 'rbus') {
        rbusGroups.add(module <= 10 ? 0 : 1);
      } else if (bus === 'loconet') {
        loconet = true;
      } else if (bus === 'can') {
        can = true;
      }
    }

    return { rbusGroups: Array.from(rbusGroups), loconet, can };
  }

  /** Mark all blocks free without clearing the lookup. Called when track power goes off. */
  resetStates(): void {
    this.cancelPendingReleases();
    if (this.states.size === 0) return;
    let changed = false;
    for (const [id, occupied] of this.states) {
      if (occupied) {
        this.states.set(id, false);
        changed = true;
      }
    }
    if (changed) this.change$.next(this.getStates());
  }

  clearBlocks(): void {
    this.cancelPendingReleases();
    if (this.states.size === 0 && this.lookup.size === 0) return;
    this.lookup.clear();
    this.states.clear();
    this.change$.next([]);
  }
}
