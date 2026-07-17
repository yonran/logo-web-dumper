// Program read + decode actions.

import type { App } from '../app.js';
import { ADDR, isPasswordSet } from '../pg/constants.js';
import { decodeCombined } from '../decode/program.js';
import { downloadBytes } from '../util/dom.js';
import { ensureStopped } from './common.js';

/**
 * Read the pointer table, wiring, and program via Read Byte, save the combined dump, and
 * decode it to a netlist. Refuses (before the slow read) if the program is protected and not
 * yet unlocked, since that would only yield zeros.
 */
export async function readAllAndDecode(app: App): Promise<void> {
  const conn = await ensureStopped(app);
  if (!conn) return;
  // Pre-flight: if protected and not yet unlocked, reads would be all zeros.
  const prot = await conn.readByte(ADDR.PWD_EXISTS);
  app.store.set({ protected: isPasswordSet(prot) });
  if (isPasswordSet(prot) && !app.store.get().unlocked) {
    app.log('Program is PASSWORD-PROTECTED (0x00FF48FF=0x40) and not unlocked — a read would return all zeros. Press “3 · Recover password & unlock” first. Nothing read or saved.', 'err');
    return;
  }
  app.log('Reading pointer table, wiring, and program via Read Byte (~2460 bytes, ~30-60s)…', 'mut');
  app.log('Press “Stop” to abort.', 'mut');
  const ptr = await conn.readRegion(ADDR.PTR_TABLE, 260, 'pointer table');
  const term = await conn.readRegion(ADDR.OUT_WIRING, 200, 'output wiring');
  const prog = await conn.readRegion(ADDR.PROGRAM, 2000, 'program');
  // Post-read guard: never save a bogus all-zero file that only looks like a success.
  let nz = 0;
  for (const d of prog) if (d) nz++;
  if (nz === 0) {
    app.log('Program region is ENTIRELY 0x00 — device is protected or the program is empty. Nothing saved. (If protected, run step 3; if you expected a program, check it is actually loaded on the device.)', 'err');
    app.ui.setNetlist('(program region is all zero — nothing to decode)');
    return;
  }
  if (nz < 16) app.log('Only ' + nz + '/2000 non-zero program bytes — this looks nearly empty, but saving anyway.', 'err');
  const full = new Uint8Array(2460);
  full.set(ptr, 0);
  full.set(term, 260);
  full.set(prog, 460);
  downloadBytes('logo_0ba6_full.bin', full);
  app.ui.setNetlist(decodeCombined(full));
  app.store.set({ dumped: true });
  app.log('Decoded. Combined dump saved as logo_0ba6_full.bin (' + nz + ' non-zero program bytes; re-decodable with the file button).', 'ok');
}

/** Decode a saved combined dump (.bin) offline. */
export function decodeFile(app: App, bytes: Uint8Array, name: string): void {
  if (bytes.length < 2460) {
    app.log('File is ' + bytes.length + ' bytes; expected a 2460-byte combined dump (from button 4).', 'err');
    return;
  }
  app.ui.setNetlist(decodeCombined(bytes));
  app.log('Decoded ' + name + '.', 'ok');
}
