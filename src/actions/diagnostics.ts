// Diagnostic actions: firmware, address-space probing, Read Block characterisation, the
// program-name self-test, and a raw region dump.

import type { App } from '../app.js';
import { ADDR, OP, isPasswordSet } from '../pg/constants.js';
import { ascii } from '../util/hex.js';
import { downloadBytes } from '../util/dom.js';
import { ensureStopped } from './common.js';

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

/** Program-protection check. Updates `store.protected`. Returns the 0x48FF byte. */
export async function checkPassword(app: App): Promise<number> {
  const conn = app.requireConn();
  const p = await conn.readByte(ADDR.PWD_EXISTS);
  app.log(
    'Password byte @0x00FF48FF = 0x' +
      p.toString(16).padStart(2, '0') +
      (isPasswordSet(p)
        ? '  → A PASSWORD IS SET. Read protection would explain empty/blocked program reads.'
        : p === 0x00
          ? '  → no password set.'
          : '  → unexpected value.'),
    p === 0x00 ? 'ok' : 'err',
  );
  const m1 = await conn.readByte(ADDR.PWD_MAGIC1);
  const m2 = await conn.readByte(ADDR.PWD_MAGIC2);
  app.log('Password magic @1F00/1F01 = 0x' + m1.toString(16) + '/0x' + m2.toString(16) + '  (expected 0x04/0x00 per PROTOCOL.md §3.4)', m1 === 0x04 && m2 === 0x00 ? 'ok' : 'mut');
  app.store.set({ protected: isPasswordSet(p) });
  return p;
}

/** Empirically map which addresses answer a Read Byte across the 0x00FF window. */
export async function probeAddressSpace(app: App): Promise<void> {
  const conn = await ensureStopped(app, 'Probe needs STOP mode — press “2 · Put in STOP” first.');
  if (!conn) return;
  app.log('Anchor check: reading the known-good ident byte at 0x00FF1F02…', 'mut');
  try {
    const id = await conn.readByte(ADDR.IDENT);
    app.log('Anchor OK — 0x00FF1F02 = 0x' + id.toString(16) + '. Read Byte works, so misses below are real.', 'ok');
  } catch (e) {
    app.log('Anchor FAILED: ' + (e instanceof Error ? e.message : String(e)), 'err');
    app.log('If the one address known to work is unreadable, the problem is not the address map.', 'err');
    return;
  }
  await conn.probePages(0x00ff0000, 256, 0x100);
}

/** Map the program memory with Read Block, which (unlike Read Byte) faults on unmapped ranges. */
export async function findMemoryMap(app: App): Promise<void> {
  const conn = await ensureStopped(app);
  if (!conn) return;
  await checkPassword(app);
  app.log('— Read Byte says every page is readable, but the 0BA5 program offsets dumped 2460 zeros. —', 'mut');
  app.log('— Read Byte returns 0x00 for unmapped memory; Read Block faults. Trusting Read Block. —', 'mut');
  await conn.probeBlocks(0x00ff0000, 256, 0x100, 16);
}

/** Characterise Read Block: is it the address, the count, or the address width? */
export async function blockDiag(app: App): Promise<void> {
  const conn = await ensureStopped(app, 'Needs STOP mode.');
  if (!conn) return;
  app.log('— Test 1: the ONE Read Block proven in the reference library (10 bytes @ 0x00FF0566) —', 'mut');
  const t1 = await conn.tryBlock(new Uint8Array([OP.READ_BLOCK, 0x00, 0xff, 0x05, 0x66, 0x00, 0x0a]), 10, '  05 00 ff 05 66 00 0a');
  app.log("— Test 2: 0BA5-style 2-byte address (the wiki's own Read Block examples use this form) —", 'mut');
  const t2 = await conn.tryBlock(new Uint8Array([OP.READ_BLOCK, 0x05, 0x66, 0x00, 0x0a]), 10, '  05 05 66 00 0a');
  app.log('— Test 3: count ladder at 0x00FF0000 (probe says every page is Read Byte-readable) —', 'mut');
  let maxOk = 0;
  for (const n of [1, 2, 4, 8, 10, 16, 32, 64, 80, 128, 256]) {
    const r = await conn.tryBlock(new Uint8Array([OP.READ_BLOCK, 0x00, 0xff, 0x00, 0x00, (n >> 8) & 0xff, n & 0xff]), n, '  count ' + n);
    if (r) maxOk = n;
    else break;
  }
  app.log('— Verdict —', 'mut');
  if (t1) {
    app.log('Read Block works for the proven case. Largest count that succeeded: ' + maxOk + '. The failures are a count/range limit, not the address.', 'ok');
  } else if (t2) {
    app.log("Read Block needs a 2-BYTE address on this device, despite the 4-byte Read Byte. The 0BA6 param table's query column is unreliable (its Read Byte row is provably wrong too).", 'ok');
  } else {
    app.log('Read Block fails even for the one case the reference library performs on real hardware. Read Byte works at every address, so dumping byte-by-byte is the reliable path.', 'err');
  }
}

/** Read the 16-byte program name via Read Byte (Read Block is rejected on this hardware). */
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
  downloadBytes('logo_0ba6_' + addrStr + '_' + len + '.bin', data);
  app.log('Saved ' + data.length + ' bytes (' + nz + ' non-zero).', 'ok');
}
