// Program read + decode actions.

import type { App } from '../app.js';
import { ADDR, isPasswordSet } from '../pg/constants.js';
import { decodeCombined } from '../decode/program.js';
import { deviceSlug, ensureStopped } from './common.js';

/**
 * Read the pointer table, wiring, and program via Read Byte, save the combined dump, and
 * decode it to a netlist. Refuses (before the slow read) if the program is protected and not
 * yet unlocked, since that would only yield zeros.
 */
export async function readAllAndDecode(app: App): Promise<void> {
  const conn = await ensureStopped(app);
  if (!conn) return;
  if (!conn.known) {
    app.log('Program read is disabled for ' + conn.deviceName + ' — this tool has no verified memory map for it, so the region addresses would be a guess. Use “Dump raw region” with an explicit address if you know where to read.', 'err');
    return;
  }
  // Pre-flight: if protected and not yet unlocked, reads would be all zeros.
  const prot = await conn.readByte(ADDR.PWD_EXISTS);
  app.store.set({ protected: isPasswordSet(prot) });
  if (isPasswordSet(prot) && !app.store.get().unlocked) {
    app.log('Program is PASSWORD-PROTECTED (0x00FF48FF=0x40) and not unlocked — a read would return all zeros. Press “3 · Recover password & attempt unlock” first. Nothing read or saved.', 'err');
    return;
  }
  // Region addresses/lengths come from the DETECTED device's map (0BA6 reads the high paged image;
  // 0BA5/0BA4 the low legacy layout) — reading the wrong family's addresses returns 0xFF/0x00.
  const mem = conn.mem;
  const total = mem.regions.reduce((n, r) => n + r.len, 0);
  app.log('Reading the program image for ' + conn.deviceName + ' (' + total + ' bytes via Read Byte, ~' + Math.round(total / 30) + 's)…', 'mut');
  app.log('Press “Abort” to stop.', 'mut');
  const parts: Uint8Array[] = [];
  for (const r of mem.regions) parts.push(await conn.readRegion(r.base, r.len, r.name));
  const full = new Uint8Array(total);
  for (let i = 0, o = 0; i < parts.length; o += parts[i].length, i++) full.set(parts[i], o);
  // Post-read guards: never save a bogus file that only looks like a success.
  let nz = 0;
  let nff = 0;
  for (const d of full) {
    if (d) nz++;
    if (d === 0xff) nff++;
  }
  if (nz === 0) {
    app.log('Image is ENTIRELY 0x00 — protected or empty. Nothing saved. (If protected, run step 3; else check a program is actually loaded.)', 'err');
    app.ui.setNetlist('(image is all zero — nothing to decode)');
    return;
  }
  if (nff === full.length) {
    app.log('Image is ENTIRELY 0xFF — this reads like erased/empty flash or the wrong address map for ' + conn.deviceName + '. Saving anyway so you can inspect it.', 'err');
  }
  const fname = 'logo_' + deviceSlug(conn.deviceName) + '_full.bin';
  app.ui.download(fname, full);
  app.store.set({ dumped: true });
  if (mem.decode === 'legacy2460' && full.length === 2460) {
    app.ui.setNetlist(decodeCombined(full));
    app.log('Decoded. Combined dump saved as ' + fname + ' (' + nz + ' non-zero bytes; re-decodable with the file button).', 'ok');
  } else {
    app.ui.setNetlist(
      'Raw program image captured (' + full.length + ' bytes, ' + nz + ' non-zero) and saved as ' + fname + '.\n' +
        'A netlist decoder for ' + conn.deviceName + ' is not implemented yet — the .bin holds the real device bytes for offline analysis.',
    );
    app.log('Saved raw ' + fname + ' (' + nz + '/' + full.length + ' non-zero). No netlist decoder for ' + conn.deviceName + ' yet — the .bin has the real bytes.', 'ok');
  }
}

/** Decode a saved combined dump (.bin) offline. Only the legacy 2460-byte 0BA4/0BA5 layout decodes. */
export function decodeFile(app: App, bytes: Uint8Array, name: string): void {
  if (bytes.length === 2460) {
    app.ui.setNetlist(decodeCombined(bytes));
    app.log('Decoded ' + name + '.', 'ok');
    return;
  }
  app.ui.setNetlist('(' + name + ': ' + bytes.length + ' bytes — not the legacy 2460-byte layout, so it cannot be decoded to a netlist yet.)');
  app.log('File is ' + bytes.length + ' bytes. Only the legacy 2460-byte 0BA4/0BA5 dump can be decoded offline yet; 0BA6 raw images are captured but not decoded.', 'err');
}
