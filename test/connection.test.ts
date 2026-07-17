// Connection (the PG protocol) against the fake device, asserting both the exact request bytes
// sent and the values decoded from the device's responses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Connection } from '../src/pg/connection.js';
import { Logger } from '../src/log.js';
import { ADDR } from '../src/pg/constants.js';
import { FakeDevice, type FakeDeviceConfig } from './helpers/fake-device.js';

function make(cfg: FakeDeviceConfig = {}): { c: Connection; d: FakeDevice; l: Logger } {
  const d = new FakeDevice(cfg);
  const l = new Logger();
  return { c: new Connection(d, l), d, l };
}

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
  const { c } = make({ passwordExists: true, leaksCleartext: true, password: 'Kp', program: new Uint8Array([0xaa, 0xbb]) });
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

test('Read Block is rejected on the ES10 model (tryBlock → null)', async () => {
  const { c } = make({ blockReadsWork: false });
  const r = await c.tryBlock(new Uint8Array([0x05, 0x00, 0xff, 0x05, 0x66, 0x00, 0x0a]), 10, 'blk');
  assert.equal(r, null);
});

test('Read Block returns data (with valid XOR) when the device supports it', async () => {
  const prog = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  const { c } = make({ blockReadsWork: true, program: prog });
  const r = await c.tryBlock(new Uint8Array([0x05, 0x00, 0x00, 0x0e, 0xe8, 0x00, 0x0a]), 10, 'blk'); // bare 0x0EE8
  assert.ok(r);
  assert.deepEqual([...r], [...prog]);
});

test('readRegion reads a run of bytes via Read Byte', async () => {
  const prog = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
  const { c } = make({ program: prog }); // no password → readable
  const data = await c.readRegion(ADDR.PROGRAM, 4, 'prog');
  assert.deepEqual([...data], [0x10, 0x20, 0x30, 0x40]);
});
