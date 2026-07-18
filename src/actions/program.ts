// Program read + decode actions.

import type { App } from '../app.js';
import { ADDR, isPasswordSet } from '../pg/constants.js';
import { decodeCombined } from '../decode/program.js';
import { confirmStoppedInCurrentSession, deviceSlug, ensureStopped } from './common.js';

/**
 * Read the pointer table, wiring, and program via Read Byte, save the combined dump, and
 * decode it to a netlist. Refuses (before the slow read) if the program is protected and not
 * yet unlocked, since that would only yield zeros.
 */
export async function readAllAndDecode(app: App): Promise<void> {
  // LSC reads the program in the same session in which it clears protection. Do not throw away a
  // verified unlock with Restart → Connect; locked/ordinary reads still use the recovery preamble.
  const conn = app.store.get().unlocked ? await confirmStoppedInCurrentSession(app) : await ensureStopped(app);
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
  const via = mem.readMode === 'block' ? 'Read Block (0x05)' : 'Read Byte (0x02)';
  const est = mem.readMode === 'block' ? Math.round(total / 900) : Math.round(total / 30);
  app.log('Reading the program image for ' + conn.deviceName + ' (' + total + ' bytes via ' + via + ', ~' + est + 's)…', 'mut');
  app.log('Press “Abort” to stop.', 'mut');
  const full = new Uint8Array(total);
  if (mem.readMode === 'block') {
    // Block mode (0BA6): read each Memory region SEPARATELY (Read Block cannot cross a region
    // border) and place it at its address offset. Read the big program-BODY region FIRST — it reads
    // cleanly, whereas the small metadata regions back off at their borders (a few Restarts each);
    // reading the body first banks it before any of that churn can disturb the session.
    const minBase = Math.min(...mem.regions.map((r) => r.base));
    const order = [...mem.regions].sort((a, b) => b.len - a.len);
    for (const r of order) {
      const data = await conn.readRegionViaBlock(r.base, r.len, r.name);
      full.set(data, (r.base - minBase) >>> 0);
    }
  } else {
    // Byte mode (legacy 0BA4/0BA5): the artificial 2460-byte combined layout, read in order.
    let o = 0;
    for (const r of mem.regions) {
      const data = await conn.readRegion(r.base, r.len, r.name);
      full.set(data, o);
      o += data.length;
    }
  }
  // Classify suspicious captures, but save them: uniform data is useful diagnostic evidence.
  let nz = 0;
  let nff = 0;
  for (const d of full) {
    if (d) nz++;
    if (d === 0xff) nff++;
  }
  if (nz === 0) {
    app.log('Image is ENTIRELY 0x00 — protected, empty, or unmapped. Saving the diagnostic capture anyway.', 'err');
    app.ui.setNetlist('(image is all zero — saved for diagnosis, nothing to decode)');
  }
  if (nff === full.length) {
    app.log('Image is ENTIRELY 0xFF — this reads like erased/empty flash or the wrong address map for ' + conn.deviceName + '. Saving anyway so you can inspect it.', 'err');
  }
  const fname = 'logo_' + deviceSlug(conn.deviceName) + '_full.bin';
  app.ui.download(fname, full);
  app.store.set({ dumped: true });
  if (mem.decode === 'legacy2460' && full.length === 2460) {
    if (nz > 0 && nff !== full.length) {
      app.ui.setNetlist(decodeCombined(full));
      app.log('Decoded. Combined dump saved as ' + fname + ' (' + nz + ' non-zero bytes; re-decodable with the file button).', 'ok');
    } else {
      app.ui.setNetlist('(uniform legacy image saved for diagnosis; decoding would not be meaningful)');
      app.log('Saved uniform legacy capture as ' + fname + '; skipped netlist decoding because it contains no credible program data.', 'err');
    }
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
