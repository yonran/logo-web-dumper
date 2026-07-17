// Password / protection actions. These are the only operations that WRITE to the PLC.
// Addresses VERIFIED by decompiling LOGO!Soft Comfort V8.0 (Modular0.checkPassword /
// uploadPassword / clearPasswordOnLogo): read the flag 0x48FF, read the cleartext at 0x0566,
// compare in the PC, and on a match clear protection by writing 0 to 0x4800 (NOT the 0x4740
// our older code inherited from brickpool). Re-lock writes 0 to 0x4801. See PROTOCOL.md §3.4.

import type { App } from '../app.js';
import { ADDR, isPasswordSet } from '../pg/constants.js';
import { addr8, ascii, hex } from '../util/hex.js';
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

/**
 * Decode a `SymmetricalSimpleEncoding`-obfuscated password store (newer 0BA6 firmware).
 * The key is applied POSITION-WISE, so the store must be read up to the first terminator (0x00),
 * not with zeros filtered out — filtering would shift every later byte onto the wrong key position.
 * (Matches LSC / passwordString, which stop at the first zero.)
 */
export function simpleDecode(raw: Uint8Array): string {
  const end = raw.indexOf(0);
  const bytes = end >= 0 ? raw.slice(0, end) : raw;
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const c = (bytes[i] ^ SIMPLE_KEY.charCodeAt(i) ^ 0xff) & 0xff;
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
  app.store.set({ protected: isPasswordSet(exists) });
  if (!isPasswordSet(exists)) {
    app.log('Password byte @48FF = 0x' + exists.toString(16) + ' — no protection to recover. Skip to “4 · Read program & save”.', 'ok');
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
  // password bytes; on the 0BA6.ES10 it returns zeros because the firmware doesn't leak it.
  app.log('Reading the stored password from 0x00000566 (as LOGO!Soft does, before any write)…', 'mut');
  const pw = await conn.readRegion(ADDR.PWD_MEM, 10, 'password area');
  const pwnz = [...pw].some((b) => b);
  // The stored representation is fixed by the device model, and we know which one we're talking to
  // from the IdentNo: the 0BA6.ES10 (0x45, LSC Logo6Update2) stores it XOR-obfuscated
  // (SymmetricalSimpleEncoding); the 0BA5 and earlier 0BA6 (0x42/0x43/0x44) store cleartext. So we
  // decode the RIGHT way instead of guessing, and only mention the alternative as a fallback.
  const usesXor = conn.identNo === 0x45;
  const primary = usesXor ? simpleDecode(pw) : passwordString(pw);
  const other = usesXor ? passwordString(pw) : simpleDecode(pw);
  const primaryLabel = usesXor ? 'XOR-decoded (0BA6.ES10 "protect customer")' : 'cleartext';
  const otherLabel = usesXor ? 'cleartext' : 'XOR-decoded';
  if (pwnz) {
    app.log('Password @0x00000566: raw bytes ' + hex(pw), 'ok');
    app.log('  → ' + primaryLabel + ' [' + conn.deviceName + ']: "' + primary + '"', 'ok');
    app.log('  → if that looks wrong, ' + otherLabel + ': "' + other + '"', 'mut');
  } else {
    app.log('Password area @0x00000566: all zero — the device did not return a readable password', 'err');
  }

  // Verify prompt (OK / Cancel). This is the client-side "compare" step — the operator confirms
  // the recovered password looks right before we touch the protection register.
  const msg = pwnz
    ? 'Password read from the device (raw ' + hex(pw) + '):\n\n' +
      '  ▶ ' + primaryLabel + ':  "' + primary + '"\n' +
      '     (fallback ' + otherLabel + ': "' + other + '")\n\n' +
      'The first line is how your ' + conn.deviceName + ' stores it. Verify it looks right.\n\n' +
      'OK  = clear protection (write 0x00FF4800 = 0, what LOGO!Soft does) and read the program.\n' +
      'Cancel = abort, nothing is written.'
    : '⚠ EXPERIMENTAL BYPASS — this is NOT password recovery.\n\n' +
      'The device did NOT return a readable password (0x00000566 is all zero) — this firmware is\n' +
      'not leaking it, so there is nothing to verify. Clicking OK does not recover your password;\n' +
      'it gambles that the clear-protection register alone opens read access on this firmware.\n\n' +
      'OK  = WRITE 0x00FF4800 = 0 to the PLC and see if the program opens (reversible with Re-lock).\n' +
      'Cancel = abort, nothing is written. (Recommended unless you are deliberately testing this.)';
  if (!app.ui.confirm(msg)) {
    app.log('Aborted at the verify prompt — nothing was written to the PLC.', 'mut');
    return;
  }
  if (!pwnz) {
    app.log('⚠ No password was recovered — proceeding with the EXPERIMENTAL clear-protection write only (not password recovery).', 'err');
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
    app.log('Password area @0x00000566 (after clear): ' + (pw2nz ? '"' + passwordString(pw2) + '"  raw ' + hex(pw2) : 'still all zero'), pw2nz ? 'ok' : 'err');
    app.log('Verifying read access to the program area…', 'mut');
    // LSC's Memory.upload reads the program via READ BLOCK (0x05), not Read Byte. Try that at the
    // correct 0BA6 program address FIRST — our only earlier block rejection was ILLEGAL ACCESS
    // (0x03) at the WRONG 0BA4 address (0x00FF0EE8), not "block reads unsupported". Then also probe
    // with Read Byte for comparison, so the log shows exactly which path (if any) opened.
    const blk = await conn.readBlock(conn.mem.programBase, 16, 'program Read Block probe');
    const test = await conn.readRegion(conn.mem.programBase, 16, 'program Read Byte probe');
    let nz = 0;
    let nff = 0;
    for (const d of test) {
      if (d) nz++;
      if (d === 0xff) nff++;
    }
    const blkNz = blk ? [...blk].filter((b) => b).length : 0;
    const blkAllFf = blk ? blk.every((b) => b === 0xff) : false;
    // "Opened" means the PROGRAM reads back credible data via SOME command — NOT that the password
    // store was readable (pw2nz). All-0x00 = protected; all-0xFF = erased/unmapped/wrong address.
    const byteReadable = nz > 0 && nff !== test.length;
    const blockReadable = blk !== null && blkNz > 0 && !blkAllFf;
    if (blockReadable && blk) {
      opened = true;
      app.log('✅ Read access OPEN via Read Block — ' + addr8(conn.mem.programBase) + ' returned real data (' + blkNz + '/16 non-zero: ' + hex(blk) + '). Run “4 · Read program & save”.', 'ok');
    } else if (byteReadable) {
      opened = true;
      app.log('✅ Read access OPEN via Read Byte — ' + addr8(conn.mem.programBase) + ' returned real data (' + nz + '/16 non-zero: ' + hex(test) + '). Run “4 · Read program & save”.', 'ok');
    } else if (blk === null) {
      app.log('Program read NOT opened: Read Block was rejected (see NOK code above — 0x03 = illegal access ⇒ still the wrong address; other codes ⇒ still protected) and Read Byte returned ' + (nff === test.length ? 'all 0xFF' : 'all zero') + '.', 'err');
      app.log('If Read Block gave 0x03 illegal-access, the program base may still be off; if it is another NOK or all-zero, the firmware is still holding read protection.', 'mut');
    } else {
      app.log('Program read NOT opened after the 0x4800 write — neither Read Byte nor Read Block returned real data' + (pw2nz ? ', even though the password store was readable' : '') + '.', 'err');
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
  // 0x48FF only reports that a password EXISTS, not that read-protection is currently ACTIVE — the
  // device exposes no register for the protection LEVEL. So we can confirm the write was ACK'd and
  // that a password is still present, but NOT independently verify that protection is now enforced.
  app.log('Re-lock command sent (wrote 0x00FF4801 = 0) and ACK\'d by the device.', isPasswordSet(chk) ? 'ok' : 'err');
  app.log(
    'Password @48FF = 0x' + chk.toString(16) + (isPasswordSet(chk)
      ? ' — a password still exists. NOTE: 0x48FF cannot report the protection LEVEL, so active read-protection cannot be independently verified here; trust the ACK, or re-read the program to confirm it now returns zeros.'
      : ' — UNEXPECTED: no password present after the set-protection write; protection is NOT restored.'),
    isPasswordSet(chk) ? 'mut' : 'err',
  );
  app.log('Note: 0x4801 is LOGO!Soft\'s set-protection register (paired with the 0x4800 clear). The stored password is untouched.', 'mut');
  app.store.set({ unlocked: false, protected: isPasswordSet(chk) });
}
