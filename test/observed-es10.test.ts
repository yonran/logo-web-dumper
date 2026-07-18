// Behaviour matched against the documented hardware observations for the 0BA6.ES10
// (fw V1.07.07) recorded in PROTOCOL.md and LAB-NOTEBOOK.md. Two layers:
//   1. byte-level fidelity — the fake reproduces the exact wire exchanges we observed;
//   2. tool-level behaviour — the app, driven over that fake, reaches the same conclusions.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Connection } from '../src/pg/connection.js';
import { Logger } from '../src/log.js';
import { ADDR } from '../src/pg/constants.js';
import { readFirmware } from '../src/actions/diagnostics.js';
import { recoverPassword, clearProtectionAndUnlock } from '../src/actions/password.js';
import { readAllAndDecode } from '../src/actions/program.js';
import { FakeDevice, LSC_0BA6_MEMORY_RANGES } from './helpers/fake-device.js';
import { logged, makeHarness, wroteByte } from './helpers/harness.js';

// The device under test in the notebook: password-protected, does NOT leak the cleartext when
// protection is lowered, and rejects Read Block.
const ES10 = {
  identNo: 0x45,
  mode: 0x42,
  passwordExists: true,
  leaksCleartext: false,
  blockReadsWork: false,
} as const;

async function exchange(dev: FakeDevice, cmd: number[], n: number): Promise<number[]> {
  await dev.write(Uint8Array.from(cmd));
  return [...(await dev.read(n))];
}

// ---- byte-level fidelity: the fake speaks the observed wire protocol ----

test('connect: → 21  ← 06 03 21 45 (IdentNo 0x45 = 0BA6.ES10), exactly as observed', async () => {
  const dev = new FakeDevice(ES10);
  assert.deepEqual(await exchange(dev, [0x21], 4), [0x06, 0x03, 0x21, 0x45]);
});

test('mode query: → 55 17 17 AA  ← 06 42 (STOP)', async () => {
  const dev = new FakeDevice(ES10);
  assert.deepEqual(await exchange(dev, [0x55, 0x17, 0x17, 0xaa], 2), [0x06, 0x42]);
});

test('STOP command on an already-stopped device gets NO response (observed)', async () => {
  const dev = new FakeDevice(ES10); // mode already 0x42
  // → 55 12 12 AA  ← (nothing)
  assert.deepEqual(await exchange(dev, [0x55, 0x12, 0x12, 0xaa], 1), []);
  // …but the device is still in STOP, as the mode query confirms.
  assert.deepEqual(await exchange(dev, [0x55, 0x17, 0x17, 0xaa], 2), [0x06, 0x42]);
});

test('STOP command DOES ack when it actually transitions RUN → STOP', async () => {
  const dev = new FakeDevice({ ...ES10, mode: 0x01 }); // start in RUN
  assert.deepEqual(await exchange(dev, [0x55, 0x12, 0x12, 0xaa], 1), [0x06]);
  assert.deepEqual(await exchange(dev, [0x55, 0x17, 0x17, 0xaa], 2), [0x06, 0x42]);
});

test('password exists: Read Byte 0x00FF48FF → 0x40', async () => {
  const dev = new FakeDevice(ES10);
  assert.deepEqual(await exchange(dev, [0x02, 0x00, 0xff, 0x48, 0xff], 7), [0x06, 0x03, 0x00, 0xff, 0x48, 0xff, 0x40]);
});

test('protected program byte reads back 0x00 via Read Byte (no fault)', async () => {
  const dev = new FakeDevice({ ...ES10, program: new Uint8Array([0xab]) });
  // The 0BA6 program lives at BARE wire 0x00003292 (Memory reads aren't paged): the byte is 0xAB
  // but protection holds → 0x00. (Genuinely exercises protection; the old 0BA4 address 0x0EE8 and
  // the paged 0x00FF3292 are both unmapped on a 0BA6 and would read 0x00 regardless.)
  assert.deepEqual(await exchange(dev, [0x02, 0x00, 0x00, 0x32, 0x92], 7), [0x06, 0x03, 0x00, 0x00, 0x32, 0x92, 0x00]);
});

test('Read Block replies 06 THEN 15 03 (pre-parse ACK, then exception) — PROTOCOL.md §3.2', async () => {
  const dev = new FakeDevice(ES10);
  // → 05 00 00 32 92 07 d0  (0BA6 program BARE 0x00003292, count 0x07D0). The ES10 rejects Read Block
  // before parsing the address, so the 06-then-15-03 rejection is the same at any address.
  assert.deepEqual(await exchange(dev, [0x05, 0x00, 0x00, 0x32, 0x92, 0x07, 0xd0], 3), [0x06, 0x15, 0x03]);
});

test('a single exception latches the session until Restart (PROTOCOL.md §3.2a)', async () => {
  const dev = new FakeDevice(ES10);
  // Read Block faults and latches.
  assert.deepEqual(await exchange(dev, [0x05, 0x00, 0x00, 0x32, 0x92, 0x07, 0xd0], 3), [0x06, 0x15, 0x03]);
  // Now even a normally-readable Read Byte (ident anchor 1F02) is refused.
  assert.deepEqual(await exchange(dev, [0x02, 0x00, 0xff, 0x1f, 0x02], 7), [0x15, 0x03]);
  // Restart clears it …
  assert.deepEqual(await exchange(dev, [0x22], 1), [0x06]);
  // … and the same read works again.
  assert.deepEqual(await exchange(dev, [0x02, 0x00, 0xff, 0x1f, 0x02], 7), [0x06, 0x03, 0x00, 0xff, 0x1f, 0x02, 0x45]);
});

// ---- tool-level behaviour: the app reaches the documented conclusions ----

function es10Conn(): { c: Connection; l: Logger } {
  const l = new Logger();
  return { c: new Connection(new FakeDevice(ES10), l), l };
}

test('identify + mode + protection + firmware match the observations', async () => {
  const { c } = es10Conn();
  assert.equal(await c.connect(), 0x45);
  assert.equal(await c.getMode(), 0x42);
  assert.equal(await c.readByte(ADDR.PWD_EXISTS), 0x40);
  assert.equal(await c.readByte(ADDR.PWD_MAGIC1), 0x04);
  assert.equal(await c.readByte(ADDR.PWD_MAGIC2), 0x00);
});

test('firmware decodes to V1.07.07', async () => {
  const h = makeHarness(ES10);
  await readFirmware(h.app);
  assert.ok(logged(h.logger, 'V1.07.07'));
});

test('reading the protected program area yields all zeros', async () => {
  const h = makeHarness({ ...ES10, program: new Uint8Array(16).fill(0xab) });
  const region = await h.conn.readRegion(h.conn.mem.programBase, 16, 'prog');
  assert.deepEqual([...region], new Array<number>(16).fill(0));
});

test('unlock with the corrected 0x4800 write still does not take on the ES10 model', async () => {
  const h = makeHarness(ES10);
  await clearProtectionAndUnlock(h.app);
  assert.ok(wroteByte(h.device, ADDR.PL_CLEAR, 0x00)); // the CORRECTED clear write (0x4800)
  assert.ok(logged(h.logger, 'Program read NOT opened'));
});

test('regression: after a failed unlock, decode BLOCKS instead of reading a protected device', async () => {
  // Reproduces the observed hardware session: unlock did not take, then the program-read action
  // must not spend a minute reading zeros and save a junk file. The guard depends on `unlocked`
  // reflecting real read access, not merely that a write was attempted.
  const h = makeHarness(ES10);
  await clearProtectionAndUnlock(h.app);
  assert.equal(h.store.get().unlocked, false);
  await readAllAndDecode(h.app);
  assert.ok(logged(h.logger, 'PASSWORD-PROTECTED'));
  assert.equal(h.store.get().dumped, false);
});

test('0BA6 two-tier read: program body FIRST, ≤16-byte blocks within LSC bounds, two artifacts', async () => {
  const h = makeHarness({ ...ES10, passwordExists: false, blockReadsWork: true, program: new Uint8Array(16).fill(0x5a) });
  await readAllAndDecode(h.app);
  const reads = h.device.writes
    .filter((w) => w[0] === 0x05)
    .map((w) => ({ addr: ((w[1] << 24) | (w[2] << 16) | (w[3] << 8) | w[4]) >>> 0, count: (w[5] << 8) | w[6] }));
  assert.ok(reads.every((r) => r.count > 0 && r.count <= 16), 'uses conservative blocks of at most 16 bytes');
  assert.ok(
    reads.every((read) => LSC_0BA6_MEMORY_RANGES.some(([base, len]) => read.addr >= base && read.addr + read.count <= base + len)),
    'no Read Block crosses an LSC Memory boundary',
  );
  // Tier 1: the program body (proven block-readable) is read FIRST, before any metadata region.
  assert.equal(reads[0].addr, h.conn.mem.programBase, 'program body is read first');
  // Two-tier output: a reliable program-body artifact plus the address-preserving full image.
  assert.equal(h.ui.downloads.length, 2);
  const prog = h.ui.downloads.find((d) => d.name.endsWith('_program.bin'));
  const image = h.ui.downloads.find((d) => d.name.endsWith('_full.bin'));
  assert.ok(prog && image, 'saves both a program artifact and a full image');
  assert.equal(prog.bytes[0], 0x5a);
  // Full image spans 0x0688..0x3292+3800 = 15074; the body begins at offset 0x3292-0x0688 = 11274.
  assert.equal(image.bytes.length, 15_074);
  assert.equal(image.bytes[11_274], 0x5a);
  assert.equal(h.store.get().dumped, true);
});

test('unlock keeps the verified byte-read session instead of risking a rejected block probe', async () => {
  const h = makeHarness({ ...ES10, leaksCleartext: true, clearWriteUnlocks: true, blockReadsWork: false, program: new Uint8Array(16).fill(0x33) });
  await clearProtectionAndUnlock(h.app);
  assert.ok(logged(h.logger, 'OPEN via Read Byte'));
  assert.equal(h.device.writes.some((w) => w[0] === 0x05), false);
  assert.equal(h.store.get().unlocked, true);
});

test('full read preserves the session that was successfully unlocked', async () => {
  const h = makeHarness({ ...ES10, leaksCleartext: true, clearWriteUnlocks: true, blockReadsWork: true, program: new Uint8Array(512).fill(0x44) });
  await clearProtectionAndUnlock(h.app);
  assert.equal(h.store.get().unlocked, true);
  const reconnectsBefore = h.device.writes.filter((w) => w[0] === 0x21 || w[0] === 0x22).length;
  await readAllAndDecode(h.app);
  const reconnectsAfter = h.device.writes.filter((w) => w[0] === 0x21 || w[0] === 0x22).length;
  assert.equal(reconnectsAfter, reconnectsBefore, 'must not restart/reconnect after a verified unlock');
  // Two-tier: a program artifact + the full image; a clean read (no fault) needs no Restart.
  assert.equal(h.ui.downloads.length, 2);
  assert.equal(h.ui.downloads.find((d) => d.name.endsWith('_full.bin'))?.bytes.length, 15_074);
});

test('full read aborts and saves nothing on a GENUINE Read Block failure after unlock', async () => {
  // A persistent transient failure (no response) is a real fault, NOT a region border, so the whole
  // read must abort and save nothing rather than leave zeros where content should be. (A border
  // 0x03 is different — it marks a region's real end and is handled; see readRegionViaBlock tests.)
  const h = makeHarness({ ...ES10, leaksCleartext: true, clearWriteUnlocks: true, blockReadsWork: true, flakyBlockReads: 99, program: new Uint8Array(512).fill(0x44) });
  await clearProtectionAndUnlock(h.app);
  assert.equal(h.store.get().unlocked, true);
  await assert.rejects(readAllAndDecode(h.app));
  assert.equal(h.ui.downloads.length, 0, 'must not save a mixed-session or zero-filled partial image');
  assert.equal(h.store.get().dumped, false);
});

test('NOK 03 in a METADATA region keeps the program-body artifact and saves a PARTIAL image', async () => {
  // A metadata region faults, but the program body (read first) is already captured. Per the agreed
  // two-tier model we retain the reliable program artifact and save a clearly-marked partial image —
  // we do NOT throw away the program, and we do NOT represent the faulted region as read zeros.
  const h = makeHarness({ ...ES10, passwordExists: false, blockReadsWork: true, rejectBlockAt: 0x0aae, program: new Uint8Array(3800).fill(0x44) });
  await readAllAndDecode(h.app); // completes (does not reject) — the program is captured
  const prog = h.ui.downloads.find((d) => d.name.endsWith('_program.bin'));
  assert.ok(prog, 'the reliable program-body artifact is saved');
  assert.equal(prog.bytes.length, 3800);
  assert.ok([...prog.bytes].every((b) => b === 0x44), 'program body is complete and real');
  assert.ok(h.ui.downloads.some((d) => d.name.endsWith('_full.bin')), 'a (partial) full image is also saved');
  assert.ok(logged(h.logger, 'INCOMPLETE'), 'the image is reported incomplete');
  assert.equal(h.store.get().dumped, true);
  // preamble Restart + one fault-recovery Restart at the metadata region.
  assert.equal(h.device.writes.filter((w) => w[0] === 0x22).length, 2, 'preamble plus fault recovery');
});

test('uniform program images are saved as diagnostic evidence', async () => {
  const h = makeHarness({ identNo: 0x42, passwordExists: false, program: new Uint8Array(0) });
  await readAllAndDecode(h.app);
  assert.equal(h.ui.downloads.length, 1);
  assert.equal(h.ui.downloads[0].bytes.length, 2460);
  assert.ok(logged(h.logger, 'ENTIRELY 0x00'));
});

test('unlock: ES10 rejects Read Block AND Read Byte stays zero → not opened', async () => {
  // The real ES10 so far: Read Block rejected, Read Byte all-zero. Must NOT report opened.
  const h = makeHarness(ES10); // blockReadsWork:false, clearWriteUnlocks:false
  await clearProtectionAndUnlock(h.app);
  assert.equal(h.store.get().unlocked, false);
  assert.ok(logged(h.logger, 'Program read NOT opened'));
});

// ---- counterfactual: the SAME flow recovers on a leaking device, proving the fake and the
//      tool distinguish "firmware holds" from "we did something wrong" ----

test('contrast: a leaking (0BA5-style) device DOES yield the cleartext under the same flow', async () => {
  // A device that both leaks the password store AND honours the clear write. identNo 0x43 stores
  // cleartext (no XOR), so "hunter2" shows as the primary reading.
  const h = makeHarness({ ...ES10, identNo: 0x43, leaksCleartext: true, clearWriteUnlocks: true, password: 'hunter2', program: new Uint8Array(16).fill(0x5a) });
  await recoverPassword(h.app);
  assert.ok(logged(h.logger, 'hunter2'));
  await clearProtectionAndUnlock(h.app);
  assert.ok(logged(h.logger, 'Read access OPEN'));
});

test('isolates firmware vs tool: password hidden, but a correct 0x4800 write DOES open the program', async () => {
  // The behaviour we hoped for on the ES10: the password store never leaks (leaksCleartext:false),
  // yet the clear-protection write exposes the program. The tool must still unlock and mark it open
  // — proving that when the real ES10 stays zero, it is the FIRMWARE holding, not the tool.
  const h = makeHarness({ ...ES10, leaksCleartext: false, clearWriteUnlocks: true, program: new Uint8Array(16).fill(0x77) });
  await recoverPassword(h.app);
  assert.ok(logged(h.logger, 'all zero')); // the password itself was never recovered
  await clearProtectionAndUnlock(h.app);
  assert.ok(logged(h.logger, 'Read access OPEN'));
  assert.equal(h.store.get().unlocked, true);
});
