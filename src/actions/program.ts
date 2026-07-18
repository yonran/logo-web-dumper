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
 *  Tier 2 — reproduce LSC's Memory uploads. In particular, MessageMemoryRTF reads its offset table
 *           and then only populated message-text records, coalescing valid IDs up to three apart.
 *           A fault aborts the composite image; only the already-complete program artifact remains.
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
  const progNz = progData.reduce((n, b) => n + (b ? 1 : 0), 0);
  const progFname = 'logo_' + slug + '_program.bin';
  app.ui.download(progFname, progData);
  app.store.set({ dumped: true });
  if (progNz === 0) {
    app.log('⚠ Program body read back ALL ZERO (' + progData.length + ' bytes) — the program is not unlocked (run step 3 first) or block-read did not open. Saved anyway for diagnosis.', 'err');
  } else {
    app.log('✅ Program body captured: ' + progData.length + ' bytes (' + progNz + ' non-zero) → ' + progFname, 'ok');
  }

  // ---- Tier 2: remaining LSC memories. The normal serial path uses fastUploadMessageText:
  // offset entry byte 0 != 0xFF means the message ID is populated; runs whose next populated ID is
  // at most three IDs away are coalesced. Each ID occupies four 32-byte lines = 128 bytes.
  let messageOffsets: Uint8Array | undefined;
  try {
    for (const r of mem.regions) {
      if (r === progR) continue;
      if (r.name === 'message text') {
        if (!messageOffsets) throw new Error('LSC message offset table was not read before message text');
        const valid: number[] = [];
        for (let id = 0; id < messageOffsets.length / 2; id++) {
          if (messageOffsets[id * 2] !== 0xff) valid.push(id);
        }
        for (let i = 0; i < valid.length; ) {
          const first = valid[i];
          let last = first;
          i++;
          while (i < valid.length && valid[i] - last <= 3) last = valid[i++];
          const addr = r.base + first * 128;
          const len = (last - first + 1) * 128;
          const data = await conn.readRegionViaBlock(addr, len, r.name + ' IDs ' + first + '…' + last);
          full.set(data, (addr - minBase) >>> 0);
        }
        app.log('  message text: LSC fast upload selected ' + valid.length + '/50 populated message IDs.', 'ok');
        continue;
      }
      const data = await conn.readRegionViaBlock(r.base, r.len, r.name);
      full.set(data, (r.base - minBase) >>> 0);
      if (r.name === 'message offset table') messageOffsets = data;
    }
  } catch (e) {
    app.log('Complete LSC image aborted: ' + (e instanceof Error ? e.message : String(e)) + '. The program-body artifact is retained; no partial full image was saved.', 'err');
    return;
  }

  const nz = full.reduce((n, b) => n + (b ? 1 : 0), 0);
  const fname = 'logo_' + slug + '_full.bin';
  app.ui.download(fname, full);
  app.ui.setNetlist(
    '✅ Complete LSC image captured: ' + full.length + ' address-span bytes (' + nz + ' non-zero). Unpopulated message-text slots were skipped exactly as LSC skips them.\n' +
      'Saved ' + fname + '. No 0BA6 netlist decoder yet — the .bin holds the raw device bytes for offline analysis.',
  );
  app.log('Saved complete LSC image ' + fname + ' (' + nz + ' non-zero).', 'ok');
}

/**
 * Read the pointer table, wiring, and program via Read Byte, save the combined dump, and
 * decode it to a netlist. Refuses (before the slow read) if the program is protected and not
 * yet unlocked, since that would only yield zeros.
 */
export async function readAllAndDecode(app: App): Promise<void> {
  // 0BA6 FAST PATH — the block-read window is fragile. Hardware proof: the unlock's 16-byte Read
  // Block at 0x00003292 succeeds, but the very next Read Block fails with NOK 03 after only a mode
  // query (0x55) and a PAGED Read Byte (0x00FF48FF) in between. So on the ES10 a mode query or a
  // paged register read RE-LOCKS the just-opened block window (bare Read Bytes in the unlock probe
  // did not). When we are already unlocked, therefore, do NOT issue getMode or read 0x48FF first —
  // re-assert the clear write (0x00FF4800 = 0, a plain Write Byte) and go STRAIGHT to Read Block
  // with nothing in between.
  if (app.store.get().unlocked && app.conn?.known && app.conn.mem.readMode === 'block') {
    const c = app.requireConn();
    c.abort = false;
    app.log('Unlocked — re-asserting the clear write and reading immediately (no mode/register read in between: those re-lock the Read Block window on the ES10).', 'mut');
    await c.writeByte(ADDR.PL_CLEAR, 0x00);
    await readBlockImage(app, c);
    return;
  }
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
  // 0BA6: program body first, then LSC-faithful Memory uploads (including sparse message text).
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
