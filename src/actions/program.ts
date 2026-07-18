// Program read + decode actions.

import type { App } from '../app.js';
import type { Connection } from '../pg/connection.js';
import { ADDR, isPasswordSet } from '../pg/constants.js';
import { decodeCombined } from '../decode/program.js';
import { confirmStoppedInCurrentSession, deviceSlug, ensureStopped } from './common.js';

/**
 * 0BA6 two-tier Read Block capture. Read Block latches on ANY illegal-access, and the Restart that
 * clears the latch RE-LOCKS the just-unlocked program (proven on ES10 hardware). So:
 *  Tier 1 — read the PROGRAM BODY first (the one region proven block-readable) and save it as its
 *           own reliable artifact, capturing exactly the bytes returned (never zero-padded).
 *  Tier 2 — only if the program read cleanly (no fault → no re-locking Restart), attempt the other
 *           LSC Memory regions for a complete image; stop at the first that faults and clearly mark
 *           the image partial. A faulted region is NEVER represented as successfully-read zeros.
 */
async function readBlockImage(app: App, conn: Connection): Promise<void> {
  const mem = conn.mem;
  const slug = deviceSlug(conn.deviceName);
  const minBase = Math.min(...mem.regions.map((r) => r.base));
  const span = Math.max(...mem.regions.map((r) => r.base + r.len)) - minBase;
  const full = new Uint8Array(span);
  const progR = mem.regions.find((r) => r.base === mem.programBase);
  if (!progR) {
    app.log('Internal error: the device map has no program-body region.', 'err');
    return;
  }

  // ---- Tier 1: the program body, first and independent.
  app.log('Reading the PROGRAM BODY first (' + progR.len + ' bytes via Read Block, ~' + Math.round(progR.len / 300) + 's) — the primary artifact. Press “Abort” to stop.', 'mut');
  const progData = await conn.readRegionViaBlock(progR.base, progR.len, progR.name);
  full.set(progData, (progR.base - minBase) >>> 0);
  const progComplete = progData.length === progR.len;
  const progNz = progData.reduce((n, b) => n + (b ? 1 : 0), 0);
  const progFname = 'logo_' + slug + '_program.bin';
  app.ui.download(progFname, progData);
  app.store.set({ dumped: true });
  if (progNz === 0) {
    app.log('⚠ Program body read back ALL ZERO (' + progData.length + ' bytes) — the program is not unlocked (run step 3 first) or block-read did not open. Saved anyway for diagnosis.', 'err');
  } else if (progComplete) {
    app.log('✅ Program body captured: ' + progData.length + ' bytes (' + progNz + ' non-zero) → ' + progFname, 'ok');
  } else {
    app.log('✅ Program body captured (PARTIAL): ' + progData.length + '/' + progR.len + ' bytes (' + progNz + ' non-zero) up to a boundary → ' + progFname + '. That is the reliable artifact; the Restart re-locked the session, so the rest of the image is not attempted.', 'ok');
  }

  // ---- Tier 2: the remaining LSC regions, best-effort, only if the program read left the session
  // usable (progComplete ⇒ no fault ⇒ no re-locking Restart happened).
  let imageComplete = progComplete;
  let regionsOk = progComplete ? 1 : 0;
  if (progComplete) {
    try {
      for (const r of mem.regions) {
        if (r === progR) continue;
        const data = await conn.readRegionViaBlock(r.base, r.len, r.name);
        full.set(data, (r.base - minBase) >>> 0);
        if (data.length < r.len) {
          imageComplete = false;
          app.log('Full LSC image INCOMPLETE — region "' + r.name + '" ended at ' + data.length + '/' + r.len + '; the Restart re-locked the session, so no further regions are read. Program-body artifact is unaffected.', 'err');
          break;
        }
        regionsOk++;
      }
    } catch (e) {
      imageComplete = false;
      app.log('Full LSC image read stopped: ' + (e instanceof Error ? e.message : String(e)) + '. Program-body artifact is retained.', 'err');
    }
  }

  const nz = full.reduce((n, b) => n + (b ? 1 : 0), 0);
  const fname = 'logo_' + slug + '_full.bin';
  app.ui.download(fname, full);
  app.ui.setNetlist(
    (imageComplete
      ? '✅ Complete LSC image captured: ' + full.length + ' bytes, all ' + mem.regions.length + ' regions (' + nz + ' non-zero).\n'
      : '⚠ PARTIAL image: the program body (' + progFname + ') is the reliable part. The full ' + mem.regions.length + '-region image is incomplete (' + regionsOk + ' region(s) read); UNREAD regions are zero in this file and must NOT be trusted.\n') +
      'Saved ' + fname + '. No 0BA6 netlist decoder yet — the .bin holds the raw device bytes for offline analysis.',
  );
  app.log(
    imageComplete ? 'Saved complete image ' + fname + ' (' + nz + ' non-zero).' : 'Saved partial image ' + fname + ' (' + nz + ' non-zero); the program body is the reliable artifact.',
    imageComplete ? 'ok' : 'err',
  );
}

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
  // Region addresses/lengths come from the DETECTED device's map (0BA6 reads the high bare image;
  // 0BA5/0BA4 the low legacy layout) — reading the wrong family's addresses returns 0xFF/0x00.
  const mem = conn.mem;
  // 0BA6: two-tier Read Block capture (program body first, best-effort full image). See below.
  if (mem.readMode === 'block') {
    await readBlockImage(app, conn);
    return;
  }
  const total = mem.regions.reduce((n, r) => n + r.len, 0);
  app.log('Reading the program image for ' + conn.deviceName + ' (' + total + ' bytes via Read Byte (0x02), ~' + Math.round(total / 30) + 's)…', 'mut');
  app.log('Press “Abort” to stop.', 'mut');
  // Byte mode (legacy 0BA4/0BA5): the artificial 2460-byte combined layout, read in order.
  const full = new Uint8Array(total);
  {
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
