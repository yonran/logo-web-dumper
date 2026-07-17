// Diagnostic actions: firmware read, the program-name self-test, and a raw region dump.

import type { App } from '../app.js';
import { ADDR } from '../pg/constants.js';
import { ascii } from '../util/hex.js';
import { downloadBytes } from '../util/dom.js';
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

/** Dump a raw region (address + length from the diagnostics inputs) to a .bin file. */
export async function dumpRegion(app: App): Promise<void> {
  const conn = await ensureStopped(app);
  if (!conn) return;
  const addrStr = app.ui.input('addr');
  const lenStr = app.ui.input('len');
  const addr = parseInt(addrStr, 16);
  const len = parseInt(lenStr, 10);
  if (!(addr >= 0) || !(len > 0)) {
    app.log('Bad address or length.', 'err');
    return;
  }
  const data = await conn.readRegion(addr, len, 'dump');
  let nz = 0;
  for (const d of data) if (d) nz++;
  if (nz === 0) {
    app.log('Region is entirely 0x00 — protected/unmapped/empty. Nothing saved. (Unlock via step 3 if the program is protected.)', 'err');
    return;
  }
  downloadBytes('logo_' + deviceSlug(conn.deviceName) + '_' + addrStr + '_' + len + '.bin', data);
  app.log('Saved ' + data.length + ' bytes (' + nz + ' non-zero).', 'ok');
}
