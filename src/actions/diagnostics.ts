// Diagnostic actions: firmware read, the program-name self-test, and a raw region dump.

import type { App } from '../app.js';
import { ADDR, getAdress } from '../pg/constants.js';
import { addr8, ascii } from '../util/hex.js';
import { deviceSlug, ensureStopped } from './common.js';

/** Firmware read: proves single-byte reads work at all, independent of Read Block. */
export async function readFirmware(app: App): Promise<void> {
  const conn = await ensureStopped(app, 'Firmware reads need STOP mode — press “2 · Put in STOP” first.');
  if (!conn) return;
  const ident = await conn.readByte(ADDR.IDENT);
  app.log('Ident byte @1F02 = 0x' + ident.toString(16), 'ok');
  const ch: number[] = [];
  for (let a = ADDR.FW_START; a <= ADDR.FW_END; a++) ch.push(await conn.readByte(a, true));
  const asc = ch.map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '·'));
  const ok = asc[0] === 'V';
  const ver = ok ? 'V' + asc[1] + '.' + asc[2] + asc[3] + '.' + asc[4] + asc[5] : asc.join('');
  app.log('Firmware @1F03..1F08 = "' + asc.join('') + '"  →  ' + ver, ok ? 'ok' : 'err');
  app.log(
    ok
      ? '→ Single-byte reads WORK and return sane data. The memory bus and address map are fine.'
      : '→ Firmware string looks wrong; reads are not returning sane data.',
    ok ? 'ok' : 'err',
  );
}

/** Read the 16-byte program name via Read Byte (a cheap "are reads returning real data" check). */
export async function nameTest(app: App): Promise<void> {
  const conn = await ensureStopped(app);
  if (!conn) return;
  const d = await conn.readRegion(ADDR.PROG_NAME, 16, 'program name');
  app.log('Program name: "' + ascii(d) + '"', 'ok');
}

/**
 * Dump a raw region (address + length from the diagnostics inputs) to a .bin file. The Mode toggle
 * picks the read regime, because the two are NOT interchangeable:
 *   • Register — Read Byte (0x02) with the getAdress page rule (a base 48FF reads paged 0x00FF48FF
 *     on a 0BA6; a 0BA5 drops the page). For the symbolic registers / password store / name.
 *   • Memory   — bare address (never paged), read the program-memory way for this device: Read
 *     Block (0x05) on a 0BA6, byte-wise on a 0BA5. For the program image.
 * Getting this wrong is exactly what read all-zeros on the ES10, so the log states which regime ran.
 */
export async function dumpRegion(app: App): Promise<void> {
  const conn = await ensureStopped(app);
  if (!conn) return;
  const addrStr = app.ui.input('addr');
  const lenStr = app.ui.input('len');
  const register = app.ui.input('dumpmode') === 'register';
  const raw = parseInt(addrStr, 16);
  const len = parseInt(lenStr, 10);
  if (!(raw >= 0) || !(len > 0)) {
    app.log('Bad address or length.', 'err');
    return;
  }
  // Register reads page the address (getAdress); Memory reads keep it bare.
  const addr = register ? getAdress(raw) : raw >>> 0;
  let data: Uint8Array;
  if (register) {
    app.log('Register dump: Read Byte, symbolic addressing — ' + addr8(raw) + ' → wire ' + addr8(addr) + ', ' + len + ' bytes.', 'mut');
    data = await conn.readRegion(addr, len, 'register dump');
  } else if (conn.mem.readMode === 'block') {
    app.log('Memory dump: Read Block, bare addressing — ' + addr8(addr) + ', ' + len + ' bytes.', 'mut');
    data = await conn.readRegionViaBlock(addr, len, 'memory dump');
  } else {
    app.log('Memory dump: Read Byte (this device reads program memory byte-wise), bare addressing — ' + addr8(addr) + ', ' + len + ' bytes.', 'mut');
    data = await conn.readRegion(addr, len, 'memory dump');
  }
  let nz = 0;
  let nff = 0;
  for (const d of data) {
    if (d) nz++;
    if (d === 0xff) nff++;
  }
  // Always save — for investigation, a uniform 0x00 (protected/unmapped) or 0xFF (erased/wrong
  // map) capture is itself evidence, not a failure. Just say clearly what it looks like.
  const tag = (register ? 'reg' : 'mem') + '_' + addr.toString(16).padStart(8, '0');
  app.ui.download('logo_' + deviceSlug(conn.deviceName) + '_' + tag + '_' + len + '.bin', data);
  if (nz === 0) {
    app.log('Saved ' + data.length + ' bytes — ENTIRELY 0x00 (protected/unmapped/empty; unlock via step 3 if protected).', 'err');
  } else if (nff === data.length) {
    app.log('Saved ' + data.length + ' bytes — ENTIRELY 0xFF (erased/empty or the wrong address for this device).', 'err');
  } else {
    app.log('Saved ' + data.length + ' bytes (' + nz + ' non-zero, ' + nff + ' × 0xFF).', 'ok');
  }
}
