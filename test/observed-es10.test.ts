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
import { recoverNoReneg, recoverPasswordAndUnlock } from '../src/actions/password.js';
import { FakeDevice } from './helpers/fake-device.js';
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

test('connect: → 21  ← 06 55 .. 45 (IdentNo 0x45 = 0BA6.ES10)', async () => {
  const dev = new FakeDevice(ES10);
  assert.deepEqual(await exchange(dev, [0x21], 4), [0x06, 0x55, 0x00, 0x45]);
});

test('mode query: → 55 17 17 AA  ← 06 42 (STOP)', async () => {
  const dev = new FakeDevice(ES10);
  assert.deepEqual(await exchange(dev, [0x55, 0x17, 0x17, 0xaa], 2), [0x06, 0x42]);
});

test('password exists: Read Byte 0x00FF48FF → 0x40', async () => {
  const dev = new FakeDevice(ES10);
  assert.deepEqual(await exchange(dev, [0x02, 0x00, 0xff, 0x48, 0xff], 7), [0x06, 0x03, 0x00, 0xff, 0x48, 0xff, 0x40]);
});

test('protected program byte reads back 0x00 via Read Byte (no fault)', async () => {
  const dev = new FakeDevice({ ...ES10, program: new Uint8Array([0xab]) });
  // 0x00FF0EE8, would be 0xAB if readable, but protection holds → 0x00.
  assert.deepEqual(await exchange(dev, [0x02, 0x00, 0xff, 0x0e, 0xe8], 7), [0x06, 0x03, 0x00, 0xff, 0x0e, 0xe8, 0x00]);
});

test('Read Block replies 06 THEN 15 03 (pre-parse ACK, then exception) — PROTOCOL.md §3.2', async () => {
  const dev = new FakeDevice(ES10);
  // → 05 00 ff 0e e8 07 d0  (count 0x07D0 = 2000), exactly as recorded.
  assert.deepEqual(await exchange(dev, [0x05, 0x00, 0xff, 0x0e, 0xe8, 0x07, 0xd0], 3), [0x06, 0x15, 0x03]);
});

test('a single exception latches the session until Restart (PROTOCOL.md §3.2a)', async () => {
  const dev = new FakeDevice(ES10);
  // Read Block faults and latches.
  assert.deepEqual(await exchange(dev, [0x05, 0x00, 0xff, 0x0e, 0xe8, 0x07, 0xd0], 3), [0x06, 0x15, 0x03]);
  // Now even a normally-readable Read Byte (ident anchor 1F02) is refused.
  assert.deepEqual(await exchange(dev, [0x02, 0x00, 0xff, 0x1f, 0x02], 7), [0x15, 0x03]);
  // Restart clears it …
  assert.deepEqual(await exchange(dev, [0x22], 1), [0x06]);
  // … and the same read works again.
  assert.deepEqual(await exchange(dev, [0x02, 0x00, 0xff, 0x1f, 0x02], 7), [0x06, 0x03, 0x00, 0xff, 0x1f, 0x02, 0x42]);
});

// ---- tool-level behaviour: the app reaches the documented conclusions ----

function es10Conn(): { c: Connection; l: Logger } {
  const l = new Logger();
  return { c: new Connection(new FakeDevice(ES10), l), l };
}

test('the tool does NOT treat the immediate 0x06 as success (06 then 15 03 → error, not data)', async () => {
  const { c, l } = es10Conn();
  const r = await c.tryBlock(new Uint8Array([0x05, 0x00, 0xff, 0x0e, 0xe8, 0x07, 0xd0]), 2000, '  05 00 ff 0e e8 07 d0');
  assert.equal(r, null);
  assert.ok(l.lines.some((x) => x.includes('06 then NOK')));
});

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
  const region = await h.conn.readRegion(ADDR.PROGRAM, 16, 'prog');
  assert.deepEqual([...region], new Array<number>(16).fill(0));
});

test('unlock (E1b, with re-negotiate) DOES NOT TAKE — write ACKed but reads stay zero', async () => {
  const h = makeHarness(ES10);
  await recoverPasswordAndUnlock(h.app);
  assert.ok(wroteByte(h.device, ADDR.PL_LEVEL1, 0x00)); // the protection write was sent
  assert.ok(logged(h.logger, 'UNLOCK DID NOT TAKE'));
  assert.ok(logged(h.logger, 'still all zero'));
});

test('unlock (E1a, no re-negotiate) also stays zero — firmware genuinely holds', async () => {
  const h = makeHarness(ES10);
  await recoverNoReneg(h.app);
  assert.ok(wroteByte(h.device, ADDR.PL_LEVEL1, 0x00));
  assert.ok(logged(h.logger, 'firmware genuinely holds'));
});

// ---- counterfactual: the SAME flow recovers on a leaking device, proving the fake and the
//      tool distinguish "firmware holds" from "we did something wrong" ----

test('contrast: a leaking (0BA5-style) device DOES yield the cleartext under the same flow', async () => {
  const h = makeHarness({ ...ES10, leaksCleartext: true, password: 'hunter2', program: new Uint8Array(16).fill(0x5a) });
  await recoverPasswordAndUnlock(h.app);
  assert.ok(logged(h.logger, 'hunter2'));
  assert.ok(logged(h.logger, 'Read access OPEN'));
});
