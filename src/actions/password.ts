// Password / protection actions. These are the only operations that WRITE to the PLC.
// See PROTOCOL.md §3.4 and LAB-NOTEBOOK.md for why the unlock behaves as it does on the ES10.

import type { App } from '../app.js';
import { ADDR, PWD_EXISTS_YES } from '../pg/constants.js';
import { ascii, hex } from '../util/hex.js';
import { ensureStopped } from './common.js';

/**
 * Documented recovery: lower protection (write 0x00FF4740=0), re-negotiate, then read the
 * cleartext password back. On the 0BA6.ES10 (fw V1.07.07) this returns all-zero — see the
 * lab notebook. Inserts a Restart between the write and the read (the deviation the no-reneg
 * variant below tests).
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
  // Confirm the magic bytes BEFORE writing anything, as the reference does — this proves we
  // are really looking at a password state and not misreading the device.
  const g1 = await conn.readByte(ADDR.PWD_MAGIC1);
  const g2 = await conn.readByte(ADDR.PWD_MAGIC2);
  if (g1 !== 0x04 || g2 !== 0x00) {
    app.log('Magic bytes unexpected (0x' + g1.toString(16) + '/0x' + g2.toString(16) + '); aborting BEFORE any write.', 'err');
    return;
  }
  app.log('Password is set (magic bytes OK). Beginning documented unlock — THIS WRITES to the PLC protection register 0x00FF4740.', 'mut');
  // The single write: lower protection to level 1 (no protection). Reversible with Re-lock.
  await conn.writeByte(ADDR.PL_LEVEL1, 0x00);
  // Record unprotected state immediately so the Re-lock warning prints no matter what fails.
  app.store.set({ unlocked: true, protected: true });
  try {
    // The device appears to latch its protection level at connection (0x21) time, so a
    // mid-session level change may not take effect until we re-negotiate. Reconnect.
    app.log('Re-negotiating the session so the new protection level takes effect…', 'mut');
    await conn.restart();
    await conn.connect();
    await conn.getMode();
    // Read the 10-byte password area with Read Byte (proven on this hardware; Read Block
    // faults here). If protection truly lifted, real bytes appear; if still 0x00, it didn't.
    const pw = await conn.readRegion(ADDR.PWD_MEM, 10, 'password area');
    const pwnz = [...pw].some((b) => b);
    app.log(
      'Password area @0x00FF0566: ' + (pwnz ? '"' + ascii(pw).replace(/·+$/, '') + '"  raw ' + hex(pw) : 'still all zero — password NOT readable'),
      pwnz ? 'ok' : 'err',
    );
    app.log('Verifying read access to the program area…', 'mut');
    const test = await conn.readRegion(ADDR.PROGRAM, 16, 'program probe');
    let nz = 0;
    for (const d of test) if (d) nz++;
    if (nz > 0) {
      app.log('Read access OPEN — 0x00FF0EE8 returns real data now (' + nz + '/16 non-zero: ' + hex(test) + '). Run “4 · Read program & decode”.', 'ok');
    } else {
      app.log('UNLOCK DID NOT TAKE: the program and password areas still read all-zero after the protection write + reconnect.', 'err');
      app.log('This 0BA6.ES10 (firmware V1.07.07) is not giving up read access the way the 0BA5 cleartext-password trick assumes — its read protection appears to actually hold.', 'err');
      app.log('Options: (a) power-cycle the LOGO, reconnect, and try step 3 again (some protection changes need a reboot); (b) if you KNOW the password, that opens other routes; (c) otherwise the protected program may not be dumpable without LOGO!Soft + the password.', 'mut');
    }
  } finally {
    app.log('⚠️ A protection-level write was sent (level 1). Press “5 · Re-lock” to restore protection when done.', 'err');
  }
}

/**
 * EXPERIMENT (2026-07-16): mirror the reference SetSessionPassword() literally — write
 * 0x4740=0 and read 0x0566 back-to-back in the SAME session, with NO Restart in between, to
 * test whether the re-negotiate in recoverPasswordAndUnlock is what defeats the unlock.
 */
export async function recoverNoReneg(app: App): Promise<void> {
  app.log('— EXPERIMENT: write 0x4740=0 then read 0x0566 in the SAME session (no re-negotiate), mirroring SetSessionPassword() exactly. —', 'mut');
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
  app.log('Magic OK. Writing 0x00FF4740=0x00 and reading 0x00FF0566 back-to-back — NO restart in between.', 'mut');
  await conn.writeByte(ADDR.PL_LEVEL1, 0x00);
  app.store.set({ unlocked: true, protected: true });
  try {
    // The crux: NO restart / connect here. Read straight away in the same session.
    const pw = await conn.readRegion(ADDR.PWD_MEM, 10, 'password area (no-reneg)');
    const pwnz = [...pw].some((b) => b);
    app.log('Password area @0x00FF0566 (same session): ' + (pwnz ? '"' + ascii(pw).replace(/·+$/, '') + '"  raw ' + hex(pw) : 'still all zero'), pwnz ? 'ok' : 'err');
    app.log('Reading program area 0x00FF0EE8 in the same session…', 'mut');
    const test = await conn.readRegion(ADDR.PROGRAM, 16, 'program probe (no-reneg)');
    let nz = 0;
    for (const d of test) if (d) nz++;
    if (pwnz || nz > 0) {
      app.log('RESULT: reads returned real data WITHOUT a re-negotiate (' + nz + '/16 program bytes non-zero: ' + hex(test) + '). The inserted Restart in step 3 was defeating the unlock. Use step 4 to dump.', 'ok');
    } else {
      app.log('RESULT: still all zero even back-to-back in the same session. The re-negotiate was NOT the cause — this firmware genuinely holds read protection after a level-1 write.', 'err');
    }
  } finally {
    app.log('⚠️ A protection-level write was sent (level 1). Press “5 · Re-lock” to restore protection when done.', 'err');
  }
}

/** Restore read/write protection (level 3). The stored password is untouched. */
export async function relock(app: App): Promise<void> {
  const conn = await ensureStopped(app, 'Needs STOP mode.');
  if (!conn) return;
  await conn.writeByte(ADDR.PL_LEVEL3, 0x00);
  const chk = await conn.readByte(ADDR.PWD_EXISTS);
  app.log(
    'Re-locked. Password byte @48FF = 0x' + chk.toString(16) + (chk === PWD_EXISTS_YES ? ' (password protection restored).' : ' (unexpected).'),
    chk === PWD_EXISTS_YES ? 'ok' : 'err',
  );
  app.log('Note: this restores level 3 (read+write protection) with your existing password. If your device was originally level 2 (read-only protection), it is now slightly more locked; reset the exact level in LOGO!Soft if it matters.', 'mut');
  app.store.set({ unlocked: false, protected: chk === PWD_EXISTS_YES });
}
