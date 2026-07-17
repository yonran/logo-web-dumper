// Raw-region dump: the Mode toggle selects the read regime, and getting it wrong reads zeros.
//   • Register → Read Byte + getAdress paging (a base 48FF reads the paged 0x00FF48FF on a 0BA6).
//   • Memory   → bare address + the device's program method (Read Block on 0BA6, byte on 0BA5).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dumpRegion } from '../src/actions/diagnostics.js';
import { makeHarness } from './helpers/harness.js';

test('register-mode dump: Read Byte with getAdress paging (48FF → wire 0x00FF48FF)', async () => {
  const h = makeHarness({ passwordExists: true });
  h.ui.inputs = { dumpmode: 'register', addr: '48ff', len: '1' };
  await dumpRegion(h.app);
  // The read goes out as a Read Byte at the PAGED wire address 00 ff 48 ff.
  const rd = h.device.writes.find((w) => w[0] === 0x02 && w[1] === 0x00 && w[2] === 0xff && w[3] === 0x48 && w[4] === 0xff);
  assert.ok(rd, 'reads the paged register address via Read Byte');
  assert.equal(h.ui.downloads.length, 1);
  assert.deepEqual([...h.ui.downloads[0].bytes], [0x40]); // password flag
  assert.ok(h.ui.downloads[0].name.includes('reg_00ff48ff'));
});

test('memory-mode dump: Read Block with BARE addressing (0x00003292 is NOT paged)', async () => {
  const h = makeHarness({ passwordExists: false, blockReadsWork: true, program: new Uint8Array(4).fill(0x5a) });
  h.ui.inputs = { dumpmode: 'memory', addr: '00003292', len: '4' };
  await dumpRegion(h.app);
  // Read Block (0x05) at the BARE address 00 00 32 92 — never paged to 00 ff 32 92.
  const blk = h.device.writes.find((w) => w[0] === 0x05 && w[1] === 0x00 && w[2] === 0x00 && w[3] === 0x32 && w[4] === 0x92);
  assert.ok(blk, 'reads bare 0x00003292 via Read Block');
  assert.equal(h.device.writes.some((w) => w[0] === 0x05 && w[2] === 0xff), false, 'must not page a Memory address');
  assert.equal(h.ui.downloads.length, 1);
  assert.deepEqual([...h.ui.downloads[0].bytes], [0x5a, 0x5a, 0x5a, 0x5a]);
  assert.ok(h.ui.downloads[0].name.includes('mem_00003292'));
});

test('memory-mode dump on a 0BA5 reads byte-wise (readMode=byte), bare 2-byte address', async () => {
  const h = makeHarness({ identNo: 0x42, passwordExists: false, program: new Uint8Array([0xaa, 0xbb]) });
  h.ui.inputs = { dumpmode: 'memory', addr: '00000ee8', len: '2' }; // 0BA5 program body base
  await dumpRegion(h.app);
  const rd = h.device.writes.find((w) => w[0] === 0x02 && w[1] === 0x0e && w[2] === 0xe8);
  assert.ok(rd, '0BA5 memory dump reads byte-wise at the bare 2-byte 0x0EE8');
  assert.equal(h.device.writes.some((w) => w[0] === 0x05), false, 'no Read Block on a 0BA5');
  assert.deepEqual([...h.ui.downloads[0].bytes], [0xaa, 0xbb]);
});
