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
 * Read and DISPLAY the stored password — a read-only step, no write to the PLC. Follows what
 * LOGO!Soft Comfort does (verified from its bytecode): read the flag, the magic bytes, then the
 * stored password. The value is shown non-modally (in the log and in a persistent panel) so the
 * operator can eyeball it BEFORE deciding to clear protection with the separate "Clear protection
 * & unlock" step. No password is ever sent to the device.
 */
export async function recoverPassword(app: App): Promise<void> {
  const conn = await ensureStopped(app);
  if (!conn) return;
  const exists = await conn.readByte(ADDR.PWD_EXISTS);
  app.store.set({ protected: isPasswordSet(exists) });
  if (!isPasswordSet(exists)) {
    app.ui.showPassword('');
    app.log('Password byte @48FF = 0x' + exists.toString(16) + ' — no protection to recover. Skip to “5 · Read program & save”.', 'ok');
    return;
  }
  const g1 = await conn.readByte(ADDR.PWD_MAGIC1);
  const g2 = await conn.readByte(ADDR.PWD_MAGIC2);
  if (g1 !== 0x04 || g2 !== 0x00) {
    app.log('Magic bytes unexpected (0x' + g1.toString(16) + '/0x' + g2.toString(16) + '); aborting.', 'err');
    return;
  }
  // Read the stored password. On a leaking device this returns the real password bytes; on the
  // 0BA6.ES10 it returns zeros because the firmware doesn't leak it. This step never writes.
  app.log('Reading the stored password from 0x00000566 (as LOGO!Soft does)…', 'mut');
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
    // Non-modal display of the recovered value — this replaces the old confirm() pop-up.
    app.ui.showPassword(
      'Recovered password [' + conn.deviceName + ']:  "' + primary + '"\n' +
        primaryLabel + '  ·  raw ' + hex(pw) + '\n' +
        'if that looks wrong, ' + otherLabel + ': "' + other + '"\n' +
        'Verify it looks right, then use “4 · Clear protection & unlock” to lower protection.',
    );
  } else {
    app.ui.showPassword(
      'No readable password — 0x00000566 returned all zero, so this firmware is not leaking it.\n' +
        '“4 · Clear protection & unlock” would be an EXPERIMENTAL bypass, not password recovery.',
    );
    app.log('Password area @0x00000566: all zero — the device did not return a readable password', 'err');
    app.log('⚠ There is nothing to verify. “4 · Clear protection & unlock” would be an EXPERIMENTAL bypass (not recovery) — reversible with Re-lock.', 'err');
  }
  app.store.set({ passwordRead: true });
}

/**
 * Clear read-protection and check whether the program opens — this is the WRITE step (armed with a
 * two-click confirm in the UI). It writes 0 to 0x00FF4800 (LSC ADR_CLEAR_PASSWORD_ACTIVE), then
 * reads the program back in the same session to see if access opened. Reversible with Re-lock.
 */
export async function clearProtectionAndUnlock(app: App): Promise<void> {
  const conn = await ensureStopped(app);
  if (!conn) return;
  const exists = await conn.readByte(ADDR.PWD_EXISTS);
  app.store.set({ protected: isPasswordSet(exists) });
  if (!isPasswordSet(exists)) {
    app.log('Password byte @48FF = 0x' + exists.toString(16) + ' — no protection to clear. Skip to “5 · Read program & save”.', 'ok');
    return;
  }
  // Re-read the store so the warning is honest even if "Recover password" wasn't run this session
  // (e.g. after a page refresh) — an all-zero store means this is a bypass, not recovery.
  const pw = await conn.readRegion(ADDR.PWD_MEM, 10, 'password area');
  const pwnz = [...pw].some((b) => b);
  if (!pwnz) {
    app.log('⚠ No password was recovered (0x00000566 is all zero) — this is the EXPERIMENTAL clear-protection write only, NOT password recovery.', 'err');
  }

  // The clear-protection write: 0x00FF4800 = 0 (LSC ADR_CLEAR_PASSWORD_ACTIVE). Reversible with
  // Re-lock (writes 0x00FF4801). This is the CORRECTED register — our old 0x4740 never took.
  app.log('Clearing protection — writing 0x00FF4800 = 0x00 (the address LOGO!Soft Comfort uses).', 'mut');
  await conn.writeByte(ADDR.PL_CLEAR, 0x00);
  app.store.set({ protected: true });
  let opened = false;
  try {
    // Read straight back in the same session — LSC does not re-negotiate between the clear and
    // the program read.
    const pw2 = await conn.readRegion(ADDR.PWD_MEM, 10, 'password area (after clear)');
    const pw2nz = [...pw2].some((b) => b);
    app.log('Password area @0x00000566 (after clear): ' + (pw2nz ? '"' + passwordString(pw2) + '"  raw ' + hex(pw2) : 'still all zero'), pw2nz ? 'ok' : 'err');
    app.log('Verifying read access at several points in the program area…', 'mut');
    // Probe with Read Byte first. A rejected Read Block latches the PLC and recovery renegotiates the
    // session, potentially discarding the unlock we are trying to verify. Separated windows also
    // avoid declaring a valid program locked merely because its first 16 bytes are zero.
    const probeOffsets = [0, 64, 256];
    const samples: Uint8Array[] = [];
    for (const offset of probeOffsets) {
      samples.push(await conn.readRegion(conn.mem.programBase + offset, 16, 'program Read Byte probe +' + offset));
    }
    const test = new Uint8Array(samples.length * 16);
    for (let i = 0; i < samples.length; i++) test.set(samples[i], i * 16);
    let nz = 0;
    let nff = 0;
    for (const d of test) {
      if (d) nz++;
      if (d === 0xff) nff++;
    }
    // "Opened" means the PROGRAM reads back credible data — NOT that the password store was
    // readable (pw2nz). All-0x00 = protected; all-0xFF = erased/unmapped/wrong address.
    const byteReadable = nz > 0 && nff !== test.length;
    if (byteReadable) {
      opened = true;
      app.log('✅ Read access OPEN via Read Byte — sampled data contains ' + nz + '/' + test.length + ' non-zero bytes: ' + hex(test) + '. Run “5 · Read program & save”.', 'ok');
    } else {
      // Read Block is a useful fallback when byte reads remain hidden. It is deliberately last:
      // rejection recovery may renegotiate, but no successful byte-read session remains to lose.
      const blk = await conn.readBlock(conn.mem.programBase, 16, 'program Read Block fallback');
      const blkNz = blk ? [...blk].filter((b) => b).length : 0;
      const blkAllFf = blk ? blk.every((b) => b === 0xff) : false;
      if (blk && blkNz > 0 && !blkAllFf) {
        opened = true;
        app.log('✅ Read access OPEN via Read Block — ' + addr8(conn.mem.programBase) + ' returned real data (' + blkNz + '/16 non-zero: ' + hex(blk) + '). Run “5 · Read program & save”.', 'ok');
      } else {
        app.log('Program read NOT opened after the 0x4800 write — neither Read Byte nor Read Block returned credible data' + (pw2nz ? ', even though the password store was readable' : '') + '.', 'err');
      }
    }
  } finally {
    app.store.set({ unlocked: opened });
    app.log('⚠️ A protection-clear write was sent (0x00FF4800 = 0). Press “6 · Re-lock” to restore protection when done.', 'err');
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
