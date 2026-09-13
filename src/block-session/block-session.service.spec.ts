import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BlockSessionService, RELEASE_DELAY_MS } from './block-session.service.ts';
import type { OccupancyUpdate } from '../central/z21/z21.client.ts';
import type { Block, FeedbackBus } from '../protocol/block.types.ts';

function makeBlock(overrides: Partial<Block> = {}): Block {
  return {
    id: 'c1',
    name: 'Block 1',
    workspaceId: 'ws1',
    infraId: 'infra1',
    feedbackBus: 'rbus',
    feedbackModule: 1,
    feedbackChannel: 1,
    sideA: [],
    sideB: [],
    createdDate: new Date().toISOString(),
    ...overrides,
  };
}

function occ(
  bus: FeedbackBus,
  channels: { address: number; channel: number; occupied: boolean }[],
): OccupancyUpdate {
  return { bus, channels };
}

// ── setBlocks ──────────────────────────────────────────────────────────────

test('setBlocks() initialises all blocks to false when no prior state exists', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1' }), makeBlock({ id: 'c2', feedbackChannel: 2 })]);

  const states = svc.getStates();
  assert.equal(states.length, 2);
  assert.ok(states.every(s => s.occupied === false));
});

test('setBlocks() preserves occupation state across reloads', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1' })]);
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));

  // Simulate PWA reload: setBlocks called again with the same block list
  svc.setBlocks([makeBlock({ id: 'c1' })]);

  const [state] = svc.getStates();
  assert.equal(state.occupied, true, 'occupation state must survive setBlocks()');
});

test('setBlocks() resets state to false for blocks not present in previous state', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1' })]);
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));

  svc.setBlocks([makeBlock({ id: 'c2', feedbackChannel: 2 })]);

  const [state] = svc.getStates();
  assert.equal(state.blockId, 'c2');
  assert.equal(state.occupied, false);
});

test('setBlocks() silently skips duplicate (bus, module, channel) triples', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([
    makeBlock({ id: 'c1', feedbackBus: 'rbus', feedbackModule: 1, feedbackChannel: 1 }),
    makeBlock({ id: 'c2', feedbackBus: 'rbus', feedbackModule: 1, feedbackChannel: 1 }),
  ]);

  assert.equal(svc.getStates().length, 1);
  assert.equal(svc.getStates()[0].blockId, 'c1');
});

test('setBlocks() treats the same module/channel on a different bus as distinct', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([
    makeBlock({ id: 'c1', feedbackBus: 'rbus', feedbackModule: 3, feedbackChannel: 2 }),
    makeBlock({ id: 'c2', feedbackBus: 'can', feedbackModule: 3, feedbackChannel: 2 }),
  ]);

  assert.equal(svc.getStates().length, 2);
});

test('setBlocks() emits change$ with current states', () => {
  const svc = new BlockSessionService();
  const emitted: unknown[] = [];
  svc.change$.subscribe(s => emitted.push(s));

  svc.setBlocks([makeBlock({ id: 'c1' })]);

  assert.equal(emitted.length, 1);
});

// ── processOccupancy ────────────────────────────────────────────────────────

test('processOccupancy() marks block occupied when its channel reports occupied', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 3 })]);

  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 3, occupied: true }]));

  assert.equal(svc.getStates()[0].occupied, true);
});

test('processOccupancy() marks block free when its channel reports not occupied', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 3 })]);
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 3, occupied: true }]));

  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 3, occupied: false }]));
  t.mock.timers.tick(RELEASE_DELAY_MS);

  assert.equal(svc.getStates()[0].occupied, false);
});

test('processOccupancy() ignores channels that map to no block', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 })]);
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));

  svc.processOccupancy(occ('rbus', [{ address: 9, channel: 4, occupied: true }]));

  assert.equal(svc.getStates()[0].occupied, true, 'unrelated channel must not affect known blocks');
});

test('processOccupancy() routes by bus — an rbus update does not touch a loconet block', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackBus: 'loconet', feedbackModule: 5, feedbackChannel: 0 })]);

  svc.processOccupancy(occ('rbus', [{ address: 5, channel: 0, occupied: true }]));

  assert.equal(svc.getStates()[0].occupied, false, 'rbus feedback must not occupy a loconet block');
});

test('processOccupancy() matches a loconet block on channel 0', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackBus: 'loconet', feedbackModule: 5, feedbackChannel: 0 })]);

  svc.processOccupancy(occ('loconet', [{ address: 5, channel: 0, occupied: true }]));

  assert.equal(svc.getStates()[0].occupied, true);
});

test('processOccupancy() emits change$ only when a state actually changes', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 })]);

  const emitted: unknown[] = [];
  svc.change$.subscribe(s => emitted.push(s));

  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: false }]));
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: false }]));

  assert.equal(emitted.length, 0, 'no change$ emission when state is unchanged');
});

test('processOccupancy() applies a full-group update in one pass', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const svc = new BlockSessionService();
  svc.setBlocks([
    makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 }),
    makeBlock({ id: 'c2', feedbackModule: 2, feedbackChannel: 4 }),
  ]);
  svc.processOccupancy(occ('rbus', [
    { address: 1, channel: 1, occupied: true },
    { address: 2, channel: 4, occupied: true },
  ]));
  // A later full-group sweep reports module 2 clear, module 1 still occupied
  svc.processOccupancy(occ('rbus', [
    { address: 1, channel: 1, occupied: true },
    { address: 2, channel: 4, occupied: false },
  ]));
  t.mock.timers.tick(RELEASE_DELAY_MS);

  const states = Object.fromEntries(svc.getStates().map(s => [s.blockId, s.occupied]));
  assert.equal(states['c1'], true);
  assert.equal(states['c2'], false);
});

// ── release delay (occupied fast, free debounced) ──────────────────────────

test('processOccupancy() applies occupied immediately — no delay on block entry', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 })]);

  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));

  assert.equal(svc.getStates()[0].occupied, true);
});

test('processOccupancy() defers the free transition until the release delay elapses', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 })]);
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));

  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: false }]));
  assert.equal(svc.getStates()[0].occupied, true, 'still occupied right after the free signal');

  t.mock.timers.tick(RELEASE_DELAY_MS);
  assert.equal(svc.getStates()[0].occupied, false, 'free once the delay elapsed');
});

test('processOccupancy() a re-occupy within the release window cancels the pending free', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 })]);
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));

  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: false }]));
  t.mock.timers.tick(Math.floor(RELEASE_DELAY_MS / 2));
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));
  t.mock.timers.tick(RELEASE_DELAY_MS);

  assert.equal(svc.getStates()[0].occupied, true, 'the bounce never surfaced as free');
});

test('processOccupancy() does not emit change$ while a free is only deferred', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 })]);
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));

  const emitted: unknown[] = [];
  svc.change$.subscribe(s => emitted.push(s));

  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: false }]));
  assert.equal(emitted.length, 0, 'no emission while the free is pending');

  t.mock.timers.tick(RELEASE_DELAY_MS);
  assert.equal(emitted.length, 1, 'one emission when the deferred free lands');
});

test('processOccupancy() flushes several simultaneous frees in a single change$', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const svc = new BlockSessionService();
  svc.setBlocks([
    makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 }),
    makeBlock({ id: 'c2', feedbackModule: 1, feedbackChannel: 2 }),
    makeBlock({ id: 'c3', feedbackModule: 1, feedbackChannel: 3 }),
  ]);
  svc.processOccupancy(occ('rbus', [
    { address: 1, channel: 1, occupied: true },
    { address: 1, channel: 2, occupied: true },
    { address: 1, channel: 3, occupied: true },
  ]));

  const emitted: unknown[] = [];
  svc.change$.subscribe(s => emitted.push(s));

  // One full-group sweep reports all three clear at once.
  svc.processOccupancy(occ('rbus', [
    { address: 1, channel: 1, occupied: false },
    { address: 1, channel: 2, occupied: false },
    { address: 1, channel: 3, occupied: false },
  ]));
  t.mock.timers.tick(RELEASE_DELAY_MS);

  assert.equal(emitted.length, 1, 'a batched release must broadcast once, not once per block');
  assert.ok(svc.getStates().every(s => s.occupied === false));
});

test('processOccupancy() a free→re-occupy bounce broadcasts nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 })]);
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));

  const emitted: unknown[] = [];
  svc.change$.subscribe(s => emitted.push(s));

  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: false }]));
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));
  t.mock.timers.tick(RELEASE_DELAY_MS);

  assert.equal(emitted.length, 0, 'occupied never left, so no change was broadcast');
});

test('resetStates() cancels a pending deferred free so a stale timer cannot fire later', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 })]);
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: false }])); // schedules free

  svc.resetStates();                                                                // must cancel it
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));   // occupied again

  t.mock.timers.tick(RELEASE_DELAY_MS);
  assert.equal(svc.getStates()[0].occupied, true, 'the stale pre-reset timer must not free the block');
});

test('setBlocks() cancels a pending deferred free so a stale timer cannot fire later', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 })]);
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: false }]));

  svc.setBlocks([makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 })]); // carries occupied=true forward
  t.mock.timers.tick(RELEASE_DELAY_MS);

  assert.equal(svc.getStates()[0].occupied, true, 'reload cancels the stale timer, block stays occupied');
});

// ── getPollPlan ─────────────────────────────────────────────────────────────

test('getPollPlan() maps rbus module 1-10 to group 0', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ feedbackBus: 'rbus', feedbackModule: 1 })]);
  assert.deepEqual(svc.getPollPlan(), { rbusGroups: [0], loconet: false, can: false });
});

test('getPollPlan() maps rbus module 11-20 to group 1', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ feedbackBus: 'rbus', feedbackModule: 11 })]);
  assert.deepEqual(svc.getPollPlan(), { rbusGroups: [1], loconet: false, can: false });
});

test('getPollPlan() deduplicates rbus groups from multiple blocks in the same group', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([
    makeBlock({ id: 'c1', feedbackBus: 'rbus', feedbackModule: 1, feedbackChannel: 1 }),
    makeBlock({ id: 'c2', feedbackBus: 'rbus', feedbackModule: 5, feedbackChannel: 2 }),
  ]);
  assert.deepEqual(svc.getPollPlan().rbusGroups, [0]);
});

test('getPollPlan() flags loconet and can when blocks use those buses', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([
    makeBlock({ id: 'c1', feedbackBus: 'rbus', feedbackModule: 2, feedbackChannel: 1 }),
    makeBlock({ id: 'c2', feedbackBus: 'loconet', feedbackModule: 10, feedbackChannel: 0 }),
    makeBlock({ id: 'c3', feedbackBus: 'can', feedbackModule: 3, feedbackChannel: 5 }),
  ]);
  assert.deepEqual(svc.getPollPlan(), { rbusGroups: [0], loconet: true, can: true });
});

test('getPollPlan() returns an empty plan when no blocks are registered', () => {
  const svc = new BlockSessionService();
  assert.deepEqual(svc.getPollPlan(), { rbusGroups: [], loconet: false, can: false });
});

// ── resetStates ─────────────────────────────────────────────────────────────

test('resetStates() sets all occupied blocks to free', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([
    makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 }),
    makeBlock({ id: 'c2', feedbackModule: 1, feedbackChannel: 2 }),
  ]);
  svc.processOccupancy(occ('rbus', [
    { address: 1, channel: 1, occupied: true },
    { address: 1, channel: 2, occupied: true },
  ]));

  svc.resetStates();

  assert.ok(svc.getStates().every(s => s.occupied === false));
});

test('resetStates() preserves the lookup so the next processOccupancy works', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 })]);
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));

  svc.resetStates();
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));

  assert.equal(svc.getStates()[0].occupied, true, 'lookup must survive resetStates()');
});

test('resetStates() emits change$ when at least one block was occupied', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1', feedbackModule: 1, feedbackChannel: 1 })]);
  svc.processOccupancy(occ('rbus', [{ address: 1, channel: 1, occupied: true }]));

  const emitted: unknown[] = [];
  svc.change$.subscribe(s => emitted.push(s));

  svc.resetStates();

  assert.equal(emitted.length, 1, 'must emit change$ when an occupied block is reset');
  assert.ok((emitted[0] as { occupied: boolean }[]).every(s => !s.occupied));
});

test('resetStates() does not emit change$ when all blocks were already free', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1' })]);

  const emitted: unknown[] = [];
  svc.change$.subscribe(s => emitted.push(s));

  svc.resetStates();
  assert.equal(emitted.length, 0);
});

// ── clearBlocks ────────────────────────────────────────────────────────────

test('clearBlocks() empties both lookup and states and emits []', () => {
  const svc = new BlockSessionService();
  svc.setBlocks([makeBlock({ id: 'c1' })]);

  const emitted: unknown[] = [];
  svc.change$.subscribe(s => emitted.push(s));

  svc.clearBlocks();

  assert.equal(svc.getStates().length, 0);
  assert.deepEqual(emitted, [[]]);
});

test('clearBlocks() is a no-op when already empty', () => {
  const svc = new BlockSessionService();

  const emitted: unknown[] = [];
  svc.change$.subscribe(s => emitted.push(s));

  svc.clearBlocks();

  assert.equal(emitted.length, 0, 'must not emit when already empty');
});
