// Password / protection actions. These are the only operations that WRITE to the PLC.
// Addresses VERIFIED by decompiling LOGO!Soft Comfort V8.0 (Modular0.checkPassword /
// uploadPassword / clearPasswordOnLogo): read the flag 0x48FF, read the cleartext at 0x0566,
// compare in the PC, and on a match clear protection by writing 0 to 0x4800 (NOT the 0x4740
// our older code inherited from brickpool). Re-lock writes 0 to 0x4801. See PROTOCOL.md §3.4.

import type { App } from '../app.js';
import { ADDR, PWD_EXISTS_YES } from '../pg/constants.js';
import { ascii, hex } from '../util/hex.js';
import { ensureStopped } from './common.js';

/** Cleartext string from the 10-byte password area, stopping at the first zero (as LSC does). */
function passwordString(pw: Uint8Array): string {
  const end = pw.indexOf(0);
  return ascii(end >= 0 ? pw.slice(0, end) : pw);
}

// LSC's `SymmetricalSimpleEncoding` — newer 0BA6 firmware (e.g. the ES10 / Logo6Update2) stores the
// password XOR-obfuscated, not cleartext. It is a plain symmetric XOR against the fixed 16-byte
// ASCII key "protect customer" plus a bit-flip (0xFF), applied position-wise over the NONZERO
// stored bytes. This reverses it. (Not a cipher — no key material beyond this hardcoded string.)
const SIMPLE_KEY = 'protect customer';

/** Decode a `SymmetricalSimpleEncoding`-obfuscated password store (newer 0BA6 firmware). */
export function simpleDecode(raw: Uint8Array): string {
  const nz = [...raw].filter((b) => b !== 0);
  let out = '';
  for (let i = 0; i < nz.length; i++) {
    const c = (nz[i] ^ SIMPLE_KEY.charCodeAt(i) ^ 0xff) & 0xff;
    out += c >= 32 && c < 127 ? String.fromCharCode(c) : '·';
  }
  return out;
}

/**
 * Recover + unlock, following what LOGO!Soft Comfort actually does (verified from its bytecode):
 * read the flag, read the stored cleartext password FIRST, show it to the operator to verify,
 * and on confirmation clear protection by writing 0 to 0x00FF4800 — then read the program back.
 * No password is ever sent to the device; the compare is the operator eyeballing the prompt.
 */
export async function recoverPasswordAndUnlock(app: App): Promise<void> {
  const conn = await ensureStopped(app);
  if (!conn) return;
  const exists = await conn.readByte(ADDR.PWD_EXISTS);
  app.store.set({ protected: exists === PWD_EXISTS_YES });
  if (exists !== PWD_EXISTS_YES) {
    app.log('Password byte @48FF = 0x' + exists.toString(16) + ' — no protection to recover. Skip to “4 · Read program & decode”.', 'ok');
    return;
  }
  const g1 = await conn.readByte(ADDR.PWD_MAGIC1);
  const g2 = await conn.readByte(ADDR.PWD_MAGIC2);
  if (g1 !== 0x04 || g2 !== 0x00) {
    app.log('Magic bytes unexpected (0x' + g1.toString(16) + '/0x' + g2.toString(16) + '); aborting BEFORE any write.', 'err');
    return;
  }
  // Read the stored password FIRST, before any write — this is the order LOGO!Soft uses
  // (uploadPassword runs before clearPasswordOnLogo). On a leaking device this returns the real
  // cleartext; on the 0BA6.ES10 it returns zeros because the firmware doesn't leak it.
  app.log('Reading the stored password from 0x00FF0566 (as LOGO!Soft does, before any write)…', 'mut');
  const pw = await conn.readRegion(ADDR.PWD_MEM, 10, 'password area');
  const pwnz = [...pw].some((b) => b);
  // Older firmware stores the password as cleartext; newer 0BA6 (ES10) stores it XOR-obfuscated
  // (LSC SymmetricalSimpleEncoding). We can't always tell which, so we show BOTH interpretations
  // and let the operator recognise their password.
  const cleartext = passwordString(pw);
  const decoded = simpleDecode(pw);
  if (pwnz) {
    app.log('Password @0x00FF0566: raw bytes ' + hex(pw), 'ok');
    app.log('  → as cleartext (older firmware): "' + cleartext + '"', 'mut');
    app.log('  → XOR-decoded (newer 0BA6 / ES10 "protect customer"): "' + decoded + '"', 'mut');
  } else {
    app.log('Password area @0x00FF0566: all zero — the device did not return a readable password', 'err');
  }

  // Verify prompt (OK / Cancel). This is the client-side "compare" step — the operator confirms
  // the recovered password looks right before we touch the protection register.
  const msg = pwnz
    ? 'Password read from the device (raw ' + hex(pw) + '):\n\n' +
      '  • cleartext (older firmware):   "' + cleartext + '"\n' +
      '  • XOR-decoded (newer 0BA6/ES10): "' + decoded + '"\n\n' +
      'One of these is your password (it depends on firmware). Verify it looks right.\n\n' +
      'OK  = clear protection (write 0x00FF4800 = 0, what LOGO!Soft does) and read the program.\n' +
      'Cancel = abort, nothing is written.'
    : 'The device did NOT return a readable password (0x00FF0566 is all zero) — this firmware is not leaking it.\n\n' +
      'OK  = try the clear-protection write anyway (0x00FF4800 = 0, the register LOGO!Soft uses) and see if the program opens.\n' +
      'Cancel = abort, nothing is written.';
  if (!app.ui.confirm(msg)) {
    app.log('Aborted at the verify prompt — nothing was written to the PLC.', 'mut');
    return;
  }

  // The clear-protection write: 0x00FF4800 = 0 (LSC ADR_CLEAR_PASSWORD_ACTIVE). Reversible with
  // Re-lock (writes 0x00FF4801). This is the CORRECTED register — our old 0x4740 never took.
  app.log('Confirmed. Clearing protection — writing 0x00FF4800 = 0x00 (the address LOGO!Soft Comfort uses).', 'mut');
  await conn.writeByte(ADDR.PL_CLEAR, 0x00);
  app.store.set({ protected: true });
  let opened = false;
  try {
    // Read straight back in the same session — LSC does not re-negotiate between the clear and
    // the program read.
    const pw2 = await conn.readRegion(ADDR.PWD_MEM, 10, 'password area (after clear)');
    const pw2nz = [...pw2].some((b) => b);
    app.log('Password area @0x00FF0566 (after clear): ' + (pw2nz ? '"' + passwordString(pw2) + '"  raw ' + hex(pw2) : 'still all zero'), pw2nz ? 'ok' : 'err');
    app.log('Verifying read access to the program area…', 'mut');
    const test = await conn.readRegion(ADDR.PROGRAM, 16, 'program probe');
    let nz = 0;
    for (const d of test) if (d) nz++;
    if (nz > 0 || pw2nz) {
      opened = true;
      app.log('Read access OPEN — 0x00FF0EE8 returns real data now (' + nz + '/16 non-zero: ' + hex(test) + '). Run “4 · Read program & decode”.', 'ok');
    } else {
      app.log('Still all zero after writing 0x00FF4800 = 0 — the corrected clear register did not open reads either.', 'err');
      app.log('This is the FIRST time the register LOGO!Soft actually uses (0x4800) was tried on this device. If it still holds, the 0BA6.ES10 (fw V1.07.07) genuinely enforces read protection. Options: power-cycle then retry; otherwise the program may only be recoverable from an original .lsc source.', 'mut');
    }
  } finally {
    app.store.set({ unlocked: opened });
    app.log('⚠️ A protection-clear write was sent (0x00FF4800 = 0). Press “5 · Re-lock” to restore protection when done.', 'err');
  }
}

/**
 * Diagnostic variant: same corrected clear write (0x00FF4800), no verify prompt, no re-negotiate.
 * Kept as an automated one-shot for quick retesting.
 */
export async function recoverNoReneg(app: App): Promise<void> {
  app.log('— EXPERIMENT: write 0x00FF4800=0 (LSC clear-protection register) then read 0x0566/program in the SAME session. —', 'mut');
  const conn = await ensureStopped(app);
  if (!conn) return;
  const exists = await conn.readByte(ADDR.PWD_EXISTS);
  app.store.set({ protected: exists === PWD_EXISTS_YES });
  if (exists !== PWD_EXISTS_YES) {
    app.log('Password byte @48FF = 0x' + exists.toString(16) + ' — no protection to recover.', 'ok');
    return;
  }
  const g1 = await conn.readByte(ADDR.PWD_MAGIC1);
  const g2 = await conn.readByte(ADDR.PWD_MAGIC2);
  if (g1 !== 0x04 || g2 !== 0x00) {
    app.log('Magic bytes unexpected (0x' + g1.toString(16) + '/0x' + g2.toString(16) + '); aborting BEFORE any write.', 'err');
    return;
  }
  app.log('Writing 0x00FF4800=0x00 and reading 0x00FF0566/program back-to-back — no restart in between.', 'mut');
  await conn.writeByte(ADDR.PL_CLEAR, 0x00);
  app.store.set({ protected: true });
  let opened = false;
  try {
    const pw = await conn.readRegion(ADDR.PWD_MEM, 10, 'password area (no-reneg)');
    const pwnz = [...pw].some((b) => b);
    app.log('Password area @0x00FF0566 (same session): ' + (pwnz ? '"' + passwordString(pw) + '"  raw ' + hex(pw) : 'still all zero'), pwnz ? 'ok' : 'err');
    app.log('Reading program area 0x00FF0EE8 in the same session…', 'mut');
    const test = await conn.readRegion(ADDR.PROGRAM, 16, 'program probe (no-reneg)');
    let nz = 0;
    for (const d of test) if (d) nz++;
    if (pwnz || nz > 0) {
      opened = true;
      app.log('RESULT: reads returned real data (' + nz + '/16 program bytes non-zero: ' + hex(test) + '). Use step 4 to dump.', 'ok');
    } else {
      app.log('RESULT: still all zero after writing 0x00FF4800 — this firmware genuinely holds read protection.', 'err');
    }
  } finally {
    app.store.set({ unlocked: opened });
    app.log('⚠️ A protection-clear write was sent (0x00FF4800 = 0). Press “5 · Re-lock” to restore protection when done.', 'err');
  }
}

/** Restore protection: write 0 to 0x00FF4801 (LSC ADR_SET_PASSWORD_ACTIVE). Password untouched. */
export async function relock(app: App): Promise<void> {
  const conn = await ensureStopped(app, 'Needs STOP mode.');
  if (!conn) return;
  await conn.writeByte(ADDR.PL_SET, 0x00);
  const chk = await conn.readByte(ADDR.PWD_EXISTS);
  app.log(
    'Re-locked (wrote 0x00FF4801 = 0). Password byte @48FF = 0x' + chk.toString(16) + (chk === PWD_EXISTS_YES ? ' (password protection restored).' : ' (unexpected — protection may not be active).'),
    chk === PWD_EXISTS_YES ? 'ok' : 'err',
  );
  app.log('Note: 0x4801 is LOGO!Soft\'s set-protection register (paired with the 0x4800 clear). The stored password is untouched.', 'mut');
  app.store.set({ unlocked: false, protected: chk === PWD_EXISTS_YES });
}
