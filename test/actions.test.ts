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

test('unlock on a non-leaking ES10: writes 0x4800 but reads stay zero → does not take', async () => {
  const h = makeHarness({ passwordExists: true, leaksCleartext: false, password: 'topsecret' });
  await recoverPasswordAndUnlock(h.app);
  // A failed unlock must NOT report the device as unlocked (the decode guard depends on this).
  assert.equal(h.store.get().unlocked, false);
  // The CORRECTED clear register (0x4800), not the old 0x4740.
  assert.ok(wroteByte(h.device, ADDR.PL_CLEAR, 0x00));
  assert.equal(wroteByte(h.device, ADDR.PL_LEVEL1, 0x00), false);
  assert.ok(logged(h.logger, 'Still all zero after writing 0x00FF4800'));
});

test('unlock shows the recovered password in a verify prompt before writing', async () => {
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, password: 'sesame', program: new Uint8Array(4).fill(1) });
  await recoverPasswordAndUnlock(h.app);
  assert.equal(h.ui.confirmMessages.length, 1);
  assert.ok(h.ui.confirmMessages[0].includes('sesame'));
});

test('unlock does NOTHING if the operator cancels the verify prompt', async () => {
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, password: 'sesame' });
  h.ui.confirmReturn = false; // operator clicks Cancel
  await recoverPasswordAndUnlock(h.app);
  assert.equal(h.device.writes.some((w) => w[0] === 0x01), false); // no write at all
  assert.equal(h.store.get().unlocked, false);
  assert.ok(logged(h.logger, 'Aborted at the verify prompt'));
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

test('recoverNoReneg on a non-leaking device writes 0x4800 and reports the firmware holds', async () => {
  const h = makeHarness({ passwordExists: true, leaksCleartext: false });
  await recoverNoReneg(h.app);
  assert.ok(wroteByte(h.device, ADDR.PL_CLEAR, 0x00));
  assert.ok(logged(h.logger, 'firmware genuinely holds'));
});

test('recoverNoReneg on a leaking device recovers the program after the 0x4800 write', async () => {
  const prog = new Uint8Array(16).fill(0x11);
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, program: prog });
  await recoverNoReneg(h.app);
  assert.ok(logged(h.logger, 'reads returned real data'));
});

test('relock writes 0x4801 (set protection) and restores the state', async () => {
  const h = makeHarness({ passwordExists: true });
  await relock(h.app);
  assert.ok(wroteByte(h.device, ADDR.PL_SET, 0x00));
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
