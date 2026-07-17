// End-to-end workflow tests: drive the action functions exactly as the buttons do, against the
// fake device, and assert the resulting store state, the bytes written, and the logged outcome.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { logged, makeHarness, wroteByte } from './helpers/harness.js';
import { doCheckMode, doDisconnect, doStop } from '../src/actions/session.js';
import { recoverPassword, clearProtectionAndUnlock, relock, simpleDecode } from '../src/actions/password.js';
import { readFirmware } from '../src/actions/diagnostics.js';
import { ADDR } from '../src/pg/constants.js';

test('doCheckMode records the STOP state', async () => {
  const h = makeHarness({ mode: 0x42 });
  await doCheckMode(h.app);
  assert.equal(h.store.get().stopped, true);
});

test('disconnect closes the session and resets derived state', async () => {
  const h = makeHarness();
  h.store.set({ connected: true, stopped: true, protected: true, passwordRead: true, unlocked: true, dumped: true });
  await doDisconnect(h.app);
  assert.equal(h.app.conn, null);
  assert.deepEqual(h.store.get(), { connected: false, stopped: false, protected: null, passwordRead: false, unlocked: false, dumped: false });
  assert.equal(h.ui.status, 'not connected');
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

test('clear-protection on a non-leaking ES10: writes 0x4800 but reads stay zero → does not take', async () => {
  const h = makeHarness({ passwordExists: true, leaksCleartext: false, password: 'topsecret' });
  await clearProtectionAndUnlock(h.app);
  // A failed unlock must NOT report the device as unlocked (the decode guard depends on this).
  assert.equal(h.store.get().unlocked, false);
  // The CORRECTED clear register (0x4800), not the old 0x4740.
  assert.ok(wroteByte(h.device, ADDR.PL_CLEAR, 0x00));
  assert.equal(wroteByte(h.device, ADDR.PL_LEVEL1, 0x00), false);
  assert.ok(logged(h.logger, 'Program read NOT opened'));
});

test('simpleDecode reverses the "protect customer" XOR obfuscation', () => {
  const KEY = 'protect customer';
  const enc = Uint8Array.from([...'hunter2'].map((c, i) => (c.charCodeAt(0) ^ 0xff ^ KEY.charCodeAt(i)) & 0xff));
  assert.equal(simpleDecode(enc), 'hunter2');
});

test('recoverPassword decrypts and displays the password on encrypted (newer-0BA6/ES10) firmware', async () => {
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, encryptPassword: true, password: 'hunter2', program: new Uint8Array(4).fill(1) });
  await recoverPassword(h.app);
  // The XOR-decoded interpretation reveals the real password, shown in both the log and the panel.
  assert.ok(logged(h.logger, 'hunter2'));
  assert.ok(h.ui.password.includes('hunter2'));
});

test('recoverPassword displays the value non-modally and writes NOTHING to the PLC', async () => {
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, password: 'sesame', program: new Uint8Array(4).fill(1) });
  await recoverPassword(h.app);
  // The password is shown in the persistent panel (no pop-up), and no byte is ever written.
  assert.ok(h.ui.password.includes('sesame'));
  assert.equal(h.device.writes.some((w) => w[0] === 0x01), false);
  assert.equal(h.store.get().passwordRead, true);
});

test('recoverPassword on a non-leaking device flags the experimental bypass, still no write', async () => {
  const h = makeHarness({ passwordExists: true, leaksCleartext: false, password: 'sesame' });
  await recoverPassword(h.app);
  assert.equal(h.device.writes.some((w) => w[0] === 0x01), false); // read-only
  assert.ok(h.ui.password.includes('EXPERIMENTAL bypass'));
  assert.ok(logged(h.logger, 'all zero'));
});

test('a successful clear-protection DOES set unlocked=true (clear write opens the program)', async () => {
  const prog = new Uint8Array(16).fill(0x5a);
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, clearWriteUnlocks: true, password: 'pw', program: prog });
  await clearProtectionAndUnlock(h.app);
  assert.equal(h.store.get().unlocked, true);
});

test('recover then clear on a leaking device: cleartext recovered and program readable', async () => {
  const prog = new Uint8Array(16).fill(0xab);
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, clearWriteUnlocks: true, password: 'letmein', program: prog });
  await recoverPassword(h.app);
  assert.ok(logged(h.logger, 'letmein'));
  await clearProtectionAndUnlock(h.app);
  assert.ok(logged(h.logger, 'Read access OPEN'));
});

test('a readable password but a HELD program does NOT count as unlocked', async () => {
  // The distinguishing case: the password store leaks, but the clear write does not open the
  // program (clearWriteUnlocks:false). Program access — not password readability — defines unlocked.
  const h = makeHarness({ passwordExists: true, leaksCleartext: true, clearWriteUnlocks: false, password: 'pw', program: new Uint8Array(16).fill(0x5a) });
  await clearProtectionAndUnlock(h.app);
  assert.equal(h.store.get().unlocked, false);
  assert.ok(logged(h.logger, 'Program read NOT opened'));
});

test('recoverPassword aborts (no write, panel cleared) when no password is set', async () => {
  const h = makeHarness({ passwordExists: false });
  await recoverPassword(h.app);
  assert.equal(h.device.writes.some((w) => w[0] === 0x01), false);
  assert.equal(h.ui.password, '');
  assert.ok(logged(h.logger, 'no protection to recover'));
});

test('clear-protection aborts before any write when no password is set', async () => {
  const h = makeHarness({ passwordExists: false });
  await clearProtectionAndUnlock(h.app);
  assert.equal(
    h.device.writes.some((w) => w[0] === 0x01),
    false,
  );
  assert.ok(logged(h.logger, 'no protection to clear'));
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
