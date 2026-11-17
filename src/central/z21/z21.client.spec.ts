import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Z21Client, ESTOP_CONFIRM_TIMEOUT_MS } from './z21.client.ts';
import { EstopUnconfirmedError } from '../central.types.ts';

/** A Z21Client whose library e-stop send is replaced by `send`. */
function clientWithSend(send: () => Promise<void>) {
  const client = new Z21Client('test', '127.0.0.1', 21105);
  const lib = (client as unknown as { lib: { system: { emergencyStop: () => Promise<void> } } }).lib;
  lib.system.emergencyStop = send;
  return client;
}

test('emergencyStop resolves when LAN_X_BC_STOPPED arrives', async (t) => {
  const client = clientWithSend(async () => { setTimeout(() => client.emit('stopped'), 20); });
  t.after(() => client.destroy());
  await client.emergencyStop();
});

test('emergencyStop catches a broadcast that arrives before the send resolves', async (t) => {
  const client = clientWithSend(() => { client.emit('stopped'); return Promise.resolve(); });
  t.after(() => client.destroy());
  await client.emergencyStop();
});

test('emergencyStop rejects with EstopUnconfirmedError without a broadcast', async (t) => {
  const client = clientWithSend(async () => {});
  t.after(() => client.destroy());
  const started = Date.now();
  await assert.rejects(client.emergencyStop(), EstopUnconfirmedError);
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= ESTOP_CONFIRM_TIMEOUT_MS - 20 && elapsed < 1_000, `waited ${elapsed} ms`);
  assert.equal(client.listenerCount('stopped'), 0, 'listener removed after the timeout');
});

test('emergencyStop rejects at once when the send fails', async (t) => {
  const client = clientWithSend(() => Promise.reject(new Error('socket closed')));
  t.after(() => client.destroy());
  const started = Date.now();
  await assert.rejects(client.emergencyStop(), /socket closed/);
  assert.ok(Date.now() - started < ESTOP_CONFIRM_TIMEOUT_MS, 'no wait for the confirmation');
  assert.equal(client.listenerCount('stopped'), 0);
});
