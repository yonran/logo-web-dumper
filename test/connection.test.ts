// Connection (the PG protocol) against the fake device, asserting both the exact request bytes
// sent and the values decoded from the device's responses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Connection } from '../src/pg/connection.js';
import { Logger } from '../src/log.js';
import { ADDR, getAdress, isStopMode } from '../src/pg/constants.js';
import { FakeDevice, type FakeDeviceConfig } from './helpers/fake-device.js';

test('getAdress: pages symbolic registers ≥ 0x1F00, leaves lower bases bare', () => {
  // ≥ 0x1F00 → OR the 0x00FF____ page (LSC Logo6.getAdress).
  assert.equal(getAdress(0x1f00), 0x00ff1f00);
  assert.equal(getAdress(0x48ff), 0x00ff48ff);
  assert.equal(getAdress(0x4800), 0x00ff4800);
  assert.equal(getAdress(0x4801), 0x00ff4801);
  // < 0x1F00 → bare.
  assert.equal(getAdress(0x0566), 0x00000566);
  assert.equal(getAdress(0x0570), 0x00000570);
  assert.equal(getAdress(0x1eff), 0x00001eff); // just below the boundary stays bare
  // The whole ADDR table is derived from getAdress, so this is what the constants must equal.
  assert.equal(ADDR.PWD_EXISTS, 0x00ff48ff);
  assert.equal(ADDR.PL_CLEAR, 0x00ff4800);
  assert.equal(ADDR.PWD_MEM, 0x00000566);
});

test('getAdress is NOT applied to the program image — 0x3292 is ≥ 0x1F00 yet stays bare', () => {
  // The critical divergence: the program body address is ≥ 0x1F00, so the naive threshold rule
  // would page it to 0x00FF3292 — but it is a Memory read, so its wire form is bare 0x00003292.
  // The ProgramMap must hold the bare base, i.e. it must NOT have gone through getAdress.
  const c = new Connection(new FakeDevice({ identNo: 0x45 }), new Logger());
  assert.equal(c.mem.programBase, 0x00003292);
  assert.notEqual(c.mem.programBase, getAdress(0x3292)); // getAdress(0x3292) === 0x00FF3292
});

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
  assert.equal(await c.readByte(c.mem.programBase), 0x00);
  await c.writeByte(ADDR.PL_CLEAR, 0x00); // clear protection (0x4800)
  assert.equal(await c.readByte(c.mem.programBase), 0xaa);
  assert.equal(await c.readByte(c.mem.programBase + 1), 0xbb);
});

test('writeByte to 0x00FF4800 is ACKed and sends 01 + address + data', async () => {
  const { c, d } = make();
  await c.writeByte(ADDR.PL_CLEAR, 0x00);
  assert.deepEqual([...d.writes[d.writes.length - 1]], [0x01, 0x00, 0xff, 0x48, 0x00, 0x00]);
});

test('0BA6 map on the wire: password AND program are BARE (0x00000566 / 0x00003292)', async () => {
  // The program is a Memory read (readByteArray on the raw base), so it is NOT paged — bare
  // 0x00003292. Only symbolic register reads get the 0xFF page. If the tool regressed to the paged
  // 0x00FF3292 or the 0BA4 program 0x0EE8, these would read zero.
  const { c, d } = make({ passwordExists: false, password: 'ok', program: new Uint8Array([0xde, 0xad]) });
  assert.deepEqual([...(await c.readRegion(c.mem.programBase, 2, 'p'))], [0xde, 0xad]);
  assert.equal(await c.readByte(ADDR.PWD_MEM), 'o'.charCodeAt(0));
  // The program read goes out as the BARE 4-byte address 00 00 32 92:
  const progRead = d.writes.find((w) => w[0] === 0x02 && w[3] === 0x32 && w[4] === 0x92);
  assert.ok(progRead);
  assert.deepEqual([...progRead.slice(1, 5)], [0x00, 0x00, 0x32, 0x92]);
  // The password read is bare too:
  const pwdRead = d.writes.find((w) => w[0] === 0x02 && w[3] === 0x05 && w[4] === 0x66);
  assert.ok(pwdRead);
  assert.deepEqual([...pwdRead.slice(1, 5)], [0x00, 0x00, 0x05, 0x66]);
});

test('readRegion reads a run of bytes via Read Byte', async () => {
  const prog = new Uint8Array([0x10, 0x20, 0x30, 0x40]);
  const { c } = make({ program: prog }); // no password → readable
  const data = await c.readRegion(c.mem.programBase, 4, 'prog');
  assert.deepEqual([...data], [0x10, 0x20, 0x30, 0x40]);
});

test('readRegion emits progress (start at 0, finish at count) so the UI bar can track it', async () => {
  const { c } = make({ program: new Uint8Array([0x10, 0x20, 0x30, 0x40]) });
  const seen: { done: number; total: number }[] = [];
  c.onProgress = (p) => seen.push({ done: p.done, total: p.total });
  await c.readRegion(c.mem.programBase, 4, 'prog');
  assert.equal(seen[0].done, 0, 'first event is an indeterminate 0/total kick');
  assert.equal(seen[seen.length - 1].done, 4, 'last event reports the full count');
  assert.ok(
    seen.every((p) => p.total === 4 && p.done <= p.total),
    'every event carries the region total and never exceeds it',
  );
});
