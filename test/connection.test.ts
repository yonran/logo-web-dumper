// Connection (the PG protocol) against the fake device, asserting both the exact request bytes
// sent and the values decoded from the device's responses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Connection } from '../src/pg/connection.js';
import { Logger } from '../src/log.js';
import { ADDR, isStopMode } from '../src/pg/constants.js';
import { FakeDevice, type FakeDeviceConfig } from './helpers/fake-device.js';

function make(cfg: FakeDeviceConfig = {}): { c: Connection; d: FakeDevice; l: Logger } {
  const d = new FakeDevice(cfg);
  const l = new Logger();
  return { c: new Connection(d, l), d, l };
}

test('readByte retries a transient no-response and then succeeds', async () => {
  const { c, d } = make({ flakyReads: 2 }); // first 2 reads glitch, 3rd works
  assert.equal(await c.readByte(ADDR.PWD_MAGIC1), 0x04);
  const reads = d.writes.filter((w) => w[0] === 0x02);
  assert.equal(reads.length, 3); // 2 failed attempts + 1 success (not just 1)
});

test('readByte gives up after 5 attempts of persistent failure', async () => {
  const { c, d } = make({ flakyReads: 99 });
  await assert.rejects(c.readByte(ADDR.PWD_MAGIC1));
  assert.equal(d.writes.filter((w) => w[0] === 0x02).length, 5); // RETRIES
});

test('STOP is detected by the 0x02 bit, not exact 0x42 (e.g. 0x4A = STOP|ERROR|REMOTE)', async () => {
  const { c } = make({ mode: 0x4a }); // 0x42 | 0x08 (error) — still STOP
  await c.connect();
  const m = await c.getMode();
  assert.equal(isStopMode(m), true);
});

test('connect returns the IdentNo and names the device', async () => {
  const { c, l } = make({ identNo: 0x45 });
  assert.equal(await c.connect(), 0x45);
  assert.ok(l.lines.some((x) => x.includes('0BA6.ES10')));
});

test('getMode returns STOP (0x42)', async () => {
  const { c } = make({ mode: 0x42 });
  assert.equal(await c.getMode(), 0x42);
});

test('getMode returns RUN (0x01)', async () => {
  const { c } = make({ mode: 0x01 });
  assert.equal(await c.getMode(), 0x01);
});

test('readByte sends 02 + 4-byte address and returns the mapped value', async () => {
  const { c, d } = make();
  assert.equal(await c.readByte(ADDR.PWD_MAGIC1), 0x04);
  assert.deepEqual([...d.writes[d.writes.length - 1]], [0x02, 0x00, 0xff, 0x1f, 0x00]);
});

test('readByte returns 0x00 for protected secret memory without faulting', async () => {
  const { c } = make({ passwordExists: true, password: 'abc' });
  assert.equal(await c.readByte(ADDR.PWD_MEM), 0x00);
});

test('leaking device: password store reads directly; program needs the 0x4800 clear write', async () => {
  const { c } = make({ passwordExists: true, leaksCleartext: true, clearWriteUnlocks: true, password: 'Kp', program: new Uint8Array([0xaa, 0xbb]) });
  // The password store leaks without any write (LOGO!Soft reads it before clearing).
  assert.equal(await c.readByte(ADDR.PWD_MEM), 'K'.charCodeAt(0));
  assert.equal(await c.readByte(ADDR.PWD_MEM + 1), 'p'.charCodeAt(0));
  // The program is still protected until the clear write.
  assert.equal(await c.readByte(ADDR.PROGRAM), 0x00);
  await c.writeByte(ADDR.PL_CLEAR, 0x00); // clear protection (0x4800)
  assert.equal(await c.readByte(ADDR.PROGRAM), 0xaa);
  assert.equal(await c.readByte(ADDR.PROGRAM + 1), 0xbb);
});

test('writeByte to 0x00FF4800 is ACKed and sends 01 + address + data', async () => {
  const { c, d } = make();
  await c.writeByte(ADDR.PL_CLEAR, 0x00);
  assert.deepEqual([...d.writes[d.writes.length - 1]], [0x01, 0x00, 0xff, 0x48, 0x00, 0x00]);
});

test('program/password are read at the BARE addresses (0x0000____), not the 0x00FF____ page', async () => {
  // The fake responds only at the hardware-verified addresses (bare below 0x1F00). If the tool's
  // ADDR.PROGRAM / ADDR.PWD_MEM regressed to 0x00FF____, these reads would return zeros.
  const { c, d } = make({ passwordExists: false, password: 'ok', program: new Uint8Array([0xde, 0xad]) });
  assert.deepEqual([...(await c.readRegion(ADDR.PROGRAM, 2, 'p'))], [0xde, 0xad]);
  assert.equal(await c.readByte(ADDR.PWD_MEM), 'o'.charCodeAt(0));
  // and the address bytes actually put on the wire are bare:
  const progRead = d.writes.find((w) => w[0] === 0x02 && w[4] === 0xe8);
  assert.ok(progRead);
  assert.deepEqual([...progRead.slice(1, 5)], [0x00, 0x00, 0x0e, 0xe8]);
});

test('readRegion reads a run of bytes via Read Byte', async () => {
  const prog = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
  const { c } = make({ program: prog }); // no password → readable
  const data = await c.readRegion(ADDR.PROGRAM, 4, 'prog');
  assert.deepEqual([...data], [0x10, 0x20, 0x30, 0x40]);
});
