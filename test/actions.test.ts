// End-to-end workflow tests: drive the action functions exactly as the buttons do, against the
// fake device, and assert the resulting store state, the bytes written, and the logged outcome.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logged, makeHarness, wroteByte } from './helpers/harness.js';
import { doCheckMode, doStop } from '../src/actions/session.js';
import { recoverPasswordAndUnlock, relock, simpleDecode } from '../src/actions/password.js';
import { readFirmware } from '../src/actions/diagnostics.js';
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
  assert.ok(logged(h.logger, 'did not open program reads'));
});

test('simpleDecode reverses the "protect customer" XOR obfuscation', () => {
  const KEY = 'protect customer';
  const enc = Uint8Array.from([...'hunter2'].map((c, i) => (c.charCodeAt(0) ^ 0xff ^ KEY.charCodeAt(i)) & 0xff));
  assert.equal(simpleDecode(enc), 'hunter2');
});

test('unlock decrypts and displays the password on encrypted (newer-0BA6/ES10) firmware', async () => {
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, encryptPassword: true, password: 'hunter2', program: new Uint8Array(4).fill(1) });
  await recoverPasswordAndUnlock(h.app);
  // The XOR-decoded interpretation reveals the real password, shown in both the log and the prompt.
  assert.ok(logged(h.logger, 'hunter2'));
  assert.ok(h.ui.confirmMessages.some((m) => m.includes('hunter2')));
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

test('a successful unlock DOES set unlocked=true (clear write opens the program)', async () => {
  const prog = new Uint8Array(16).fill(0x5a);
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, clearWriteUnlocks: true, password: 'pw', program: prog });
  await recoverPasswordAndUnlock(h.app);
  assert.equal(h.store.get().unlocked, true);
});

test('unlock on a leaking device: cleartext recovered and program readable', async () => {
  const prog = new Uint8Array(16).fill(0xab);
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, clearWriteUnlocks: true, password: 'letmein', program: prog });
  await recoverPasswordAndUnlock(h.app);
  assert.ok(logged(h.logger, 'letmein'));
  assert.ok(logged(h.logger, 'Read access OPEN'));
});

test('a readable password but a HELD program does NOT count as unlocked', async () => {
  // The distinguishing case: the password store leaks, but the clear write does not open the
  // program (clearWriteUnlocks:false). Program access — not password readability — defines unlocked.
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, clearWriteUnlocks: false, password: 'pw', program: new Uint8Array(16).fill(0x5a) });
  await recoverPasswordAndUnlock(h.app);
  assert.equal(h.store.get().unlocked, false);
  assert.ok(logged(h.logger, 'did not open program reads'));
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
