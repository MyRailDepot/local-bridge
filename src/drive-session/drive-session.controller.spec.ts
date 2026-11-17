import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpException } from '@nestjs/common';
import { DriveSessionController } from './drive-session.controller.ts';
import { DriveSessionService } from './drive-session.service.ts';
import { CentralCommandError } from '../central/central.types.ts';
import type { CentralCommandErrorCode } from '../central/central.types.ts';
import type { CentralManagerService } from '../central/central-manager.service.ts';
import type { BlockSessionService } from '../block-session/block-session.service.ts';

function setup(failure?: CentralCommandErrorCode) {
  const sent: string[] = [];
  const answer = (name: string) => {
    sent.push(name);
    return failure ? Promise.reject(new CentralCommandError(failure, failure)) : Promise.resolve();
  };
  const manager = {
    setLocoSpeed:     () => answer('speed'),
    setLocoFunction:  () => answer('function'),
    setTrackPower:    () => answer('power'),
    emergencyStopAll: () => answer('estop'),
  } as unknown as CentralManagerService;
  const session = new DriveSessionService();
  const controller = new DriveSessionController(session, manager, {} as BlockSessionService);
  const train = session.addTrain('rs1', 3);
  return { controller, session, train, sent };
}

async function rejectsWithStatus(p: Promise<unknown>, status: number, code: string) {
  await assert.rejects(p, (err: unknown) => {
    if (!(err instanceof HttpException)) return false;
    const body = err.getResponse() as { code?: string };
    return err.getStatus() === status && body.code === code;
  });
}

test('e-stop answers stopped once a station confirmed it', async () => {
  const { controller, train, sent } = setup();
  assert.deepEqual(await controller.estop(train.id), { stopped: true });
  assert.deepEqual(sent, ['estop']);
});

for (const [code, status] of [['NO_CENTRAL', 503], ['CENTRAL_SEND_FAILED', 502], ['ESTOP_UNCONFIRMED', 504]] as const) {
  test(`e-stop answers ${status} on ${code} and still sets every train to 0`, async () => {
    const { controller, session, train } = setup(code);
    session.setSpeed(train.id, 12, 'forward');
    await rejectsWithStatus(controller.estop(train.id), status, code);
    assert.equal(session.getSession().trains[0]!.speedStep, 0);
  });
}

test('speed: session updated after a successful send', async () => {
  const { controller, session, train } = setup();
  assert.deepEqual(await controller.setSpeed(train.id, { speedStep: 10, direction: 'forward' }), { speedStep: 10, direction: 'forward' });
  assert.equal(session.getSession().trains[0]!.speedStep, 10);
});

test('speed: 503 and session unchanged with no station', async () => {
  const { controller, session, train } = setup('NO_CENTRAL');
  await rejectsWithStatus(controller.setSpeed(train.id, { speedStep: 10, direction: 'forward' }), 503, 'NO_CENTRAL');
  assert.equal(session.getSession().trains[0]!.speedStep, 0);
});

test('speed: 502 and session unchanged when every send fails', async () => {
  const { controller, session, train } = setup('CENTRAL_SEND_FAILED');
  await rejectsWithStatus(controller.setSpeed(train.id, { speedStep: 10, direction: 'forward' }), 502, 'CENTRAL_SEND_FAILED');
  assert.equal(session.getSession().trains[0]!.speedStep, 0);
});

test('function: session updated only after a successful send', async () => {
  const ok = setup();
  assert.deepEqual(await ok.controller.setFunction(ok.train.id, '1', { active: true }), { fn: 1, active: true });
  const failed = setup('NO_CENTRAL');
  const before = JSON.stringify(failed.session.getSession().trains[0]);
  await rejectsWithStatus(failed.controller.setFunction(failed.train.id, '1', { active: true }), 503, 'NO_CENTRAL');
  assert.equal(JSON.stringify(failed.session.getSession().trains[0]), before);
});

test('track power: 503 / 502 and session unchanged on failure', async () => {
  const ok = setup();
  assert.deepEqual(await ok.controller.setTrackPower({ on: true }), { trackPower: true });
  assert.equal(ok.session.getSession().trackPower, true);
  for (const [code, status] of [['NO_CENTRAL', 503], ['CENTRAL_SEND_FAILED', 502]] as const) {
    const failed = setup(code);
    await rejectsWithStatus(failed.controller.setTrackPower({ on: true }), status, code);
    assert.equal(failed.session.getSession().trackPower, false);
  }
});
