import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CentralManagerService } from './central-manager.service.ts';
import { CentralCommandError, EstopUnconfirmedError } from './central.types.ts';
import type { CentralStatus } from './central.types.ts';

type Outcome = 'ok' | 'fail' | 'unconfirmed';

function fakeClient(status: CentralStatus, outcome: Outcome) {
  const calls: string[] = [];
  const run = (name: string) => {
    calls.push(name);
    if (outcome === 'ok') return Promise.resolve();
    if (outcome === 'unconfirmed') return Promise.reject(new EstopUnconfirmedError('silent'));
    return Promise.reject(new Error('send failed'));
  };
  return {
    calls,
    status,
    setLocoSpeed:    () => run('speed'),
    setLocoFunction: () => run('function'),
    setTrackPower:   () => run('power'),
    emergencyStop:   () => run('estop'),
  };
}

function managerWith(...clients: ReturnType<typeof fakeClient>[]) {
  const manager = new CentralManagerService();
  const map = (manager as unknown as { clients: Map<string, unknown> }).clients;
  clients.forEach((c, i) => map.set(`c${i}`, c));
  return manager;
}

async function rejectsWith(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => err instanceof CentralCommandError && err.code === code);
}

test('e-stop resolves when the connected station confirms', async () => {
  const z21 = fakeClient('connected', 'ok');
  await managerWith(z21).emergencyStopAll();
  assert.deepEqual(z21.calls, ['estop']);
});

test('every command rejects with NO_CENTRAL when no station is connected', async () => {
  const offline = fakeClient('disconnected', 'ok');
  const manager = managerWith(offline);
  await rejectsWith(manager.emergencyStopAll(), 'NO_CENTRAL');
  await rejectsWith(manager.setLocoSpeed(3, 10, true), 'NO_CENTRAL');
  await rejectsWith(manager.setLocoFunction(3, 0, true), 'NO_CENTRAL');
  await rejectsWith(manager.setTrackPower(true), 'NO_CENTRAL');
  assert.deepEqual(offline.calls, [], 'a disconnected station is never sent anything');
});

test('NO_CENTRAL with no station configured at all', async () => {
  await rejectsWith(managerWith().emergencyStopAll(), 'NO_CENTRAL');
});

test('CENTRAL_SEND_FAILED when sending fails on every station', async () => {
  const manager = managerWith(fakeClient('connected', 'fail'), fakeClient('connected', 'fail'));
  await rejectsWith(manager.emergencyStopAll(), 'CENTRAL_SEND_FAILED');
  await rejectsWith(manager.setLocoSpeed(3, 10, true), 'CENTRAL_SEND_FAILED');
  await rejectsWith(manager.setLocoFunction(3, 1, true), 'CENTRAL_SEND_FAILED');
  await rejectsWith(manager.setTrackPower(false), 'CENTRAL_SEND_FAILED');
});

test('ESTOP_UNCONFIRMED when the e-stop was sent but no station confirmed it', async () => {
  await rejectsWith(managerWith(fakeClient('connected', 'unconfirmed')).emergencyStopAll(), 'ESTOP_UNCONFIRMED');
});

test('a mix of send failure and missing confirmation is reported as a send failure', async () => {
  const manager = managerWith(fakeClient('connected', 'unconfirmed'), fakeClient('connected', 'fail'));
  await rejectsWith(manager.emergencyStopAll(), 'CENTRAL_SEND_FAILED');
});

test('one confirming station is enough when another stays silent', async () => {
  const silent = fakeClient('connected', 'unconfirmed');
  const ok = fakeClient('connected', 'ok');
  await managerWith(silent, ok).emergencyStopAll();
  assert.deepEqual(silent.calls, ['estop']);
  assert.deepEqual(ok.calls, ['estop']);
});

test('a client that throws synchronously counts as a send failure', async () => {
  const thrower = { ...fakeClient('connected', 'ok'), setTrackPower: () => { throw new Error('boom'); } };
  await rejectsWith(managerWith(thrower).setTrackPower(true), 'CENTRAL_SEND_FAILED');
});
