// End-to-end workflow tests: drive the action functions exactly as the buttons do, against the
// fake device, and assert the resulting store state, the bytes written, and the logged outcome.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logged, makeHarness, wroteByte } from './helpers/harness.js';
import { doCheckMode, doStop } from '../src/actions/session.js';
import { recoverNoReneg, recoverPasswordAndUnlock, relock } from '../src/actions/password.js';
import { checkPassword, readFirmware } from '../src/actions/diagnostics.js';
import { ADDR } from '../src/pg/constants.js';

test('doCheckMode records the STOP state', async () => {
  const h = makeHarness({ mode: 0x42 });
  await doCheckMode(h.app);
  assert.equal(h.store.get().stopped, true);
});

test('doStop: forces STOP and records that a password exists, with the reversibility caveat', async () => {
  const h = makeHarness({ passwordExists: true });
  await doStop(h.app);
  assert.equal(h.store.get().stopped, true);
  assert.equal(h.store.get().protected, true);
  assert.ok(logged(h.logger, 'IS set (0x48FF=0x40)'));
  assert.ok(logged(h.logger, 'NOT the current protection level'));
});

test('doStop on an unprotected device: protected=false, no re-lock caveat', async () => {
  const h = makeHarness({ passwordExists: false });
  await doStop(h.app);
  assert.equal(h.store.get().protected, false);
  assert.equal(logged(h.logger, 'NOT the current protection level'), false);
});

test('unlock on a non-leaking ES10: write is sent but reads stay zero → UNLOCK DID NOT TAKE', async () => {
  const h = makeHarness({ passwordExists: true, leaksCleartext: false, password: 'topsecret' });
  await recoverPasswordAndUnlock(h.app);
  // A failed unlock must NOT report the device as unlocked (the decode guard depends on this).
  assert.equal(h.store.get().unlocked, false);
  assert.ok(wroteByte(h.device, ADDR.PL_LEVEL1, 0x00));
  assert.ok(logged(h.logger, 'UNLOCK DID NOT TAKE'));
  assert.ok(logged(h.logger, 'still all zero'));
});

test('a successful unlock DOES set unlocked=true (leaking device)', async () => {
  const prog = new Uint8Array(16).fill(0x5a);
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, password: 'pw', program: prog });
  await recoverPasswordAndUnlock(h.app);
  assert.equal(h.store.get().unlocked, true);
});

test('unlock on a leaking device: cleartext recovered and program readable', async () => {
  const prog = new Uint8Array(16).fill(0xab);
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, password: 'letmein', program: prog });
  await recoverPasswordAndUnlock(h.app);
  assert.ok(logged(h.logger, 'letmein'));
  assert.ok(logged(h.logger, 'Read access OPEN'));
});

test('unlock aborts before any write when no password is set', async () => {
  const h = makeHarness({ passwordExists: false });
  await recoverPasswordAndUnlock(h.app);
  assert.equal(
    h.device.writes.some((w) => w[0] === 0x01),
    false,
  );
  assert.ok(logged(h.logger, 'no protection to recover'));
});

test('recoverNoReneg on a non-leaking device reports the firmware genuinely holds', async () => {
  const h = makeHarness({ passwordExists: true, leaksCleartext: false });
  await recoverNoReneg(h.app);
  assert.ok(wroteByte(h.device, ADDR.PL_LEVEL1, 0x00));
  assert.ok(logged(h.logger, 'firmware genuinely holds'));
});

test('recoverNoReneg on a leaking device reports the re-negotiate was the cause', async () => {
  const prog = new Uint8Array(16).fill(0x11);
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, program: prog });
  await recoverNoReneg(h.app);
  assert.ok(logged(h.logger, 'WITHOUT a re-negotiate'));
});

test('relock writes protection level 3 and restores the state', async () => {
  const h = makeHarness({ passwordExists: true });
  await relock(h.app);
  assert.ok(wroteByte(h.device, ADDR.PL_LEVEL3, 0x00));
  assert.equal(h.store.get().protected, true);
  assert.equal(h.store.get().unlocked, false);
});

test('readFirmware decodes the version string to V1.07.07', async () => {
  const h = makeHarness();
  await readFirmware(h.app);
  assert.ok(logged(h.logger, 'V1.07.07'));
});

test('checkPassword updates store.protected from 0x48FF', async () => {
  const h = makeHarness({ passwordExists: true });
  assert.equal(await checkPassword(h.app), 0x40);
  assert.equal(h.store.get().protected, true);
});
