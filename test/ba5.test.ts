// 0BA5 support: 2-byte addressing, no 0x21 answer (probed via 0x1F02), no 0xFF page. Exercised
// against the fake in 0BA5 mode (identNo 0x42). No real 0BA5 hardware was available to verify.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Connection } from '../src/pg/connection.js';
import { Logger } from '../src/log.js';
import { ADDR } from '../src/pg/constants.js';
import { FakeDevice } from './helpers/fake-device.js';
import { logged, makeHarness } from './helpers/harness.js';
import { recoverPasswordAndUnlock } from '../src/actions/password.js';

test('0BA5 connect: no 0x21 answer, detected via the 2-byte 0x1F02 probe', async () => {
  const l = new Logger();
  const c = new Connection(new FakeDevice({ identNo: 0x42 }), l);
  const ident = await c.connect();
  assert.equal(ident, 0x42);
  assert.equal(c.deviceName, '0BA5');
  assert.ok(l.lines.some((x) => x.includes('0BA5')));
});

test('0BA5 sends 2-byte addresses on the wire (low 16 bits, no 0xFF page)', async () => {
  const d = new FakeDevice({ identNo: 0x42 });
  const c = new Connection(d, new Logger());
  await c.connect();
  // Canonical 0x00FF48FF → 0BA5 wire 0x48FF (2 bytes).
  assert.equal(await c.readByte(ADDR.PWD_EXISTS), 0x00);
  assert.deepEqual([...d.writes[d.writes.length - 1]], [0x02, 0x48, 0xff]);
});

test('0BA5 reads the program at the bare 2-byte 0x0EE8', async () => {
  const d = new FakeDevice({ identNo: 0x42, program: new Uint8Array([0xaa, 0xbb]) });
  const c = new Connection(d, new Logger());
  await c.connect();
  const data = await c.readRegion(c.mem.programBase, 2, 'p'); // 0BA5 map: 0x00000EE8 → 2-byte wire 0x0EE8
  assert.deepEqual([...data], [0xaa, 0xbb]);
  const readCmd = d.writes.find((w) => w[0] === 0x02 && w[1] === 0x0e);
  assert.ok(readCmd);
  assert.deepEqual([...readCmd.slice(1, 3)], [0x0e, 0xe8]); // 2 address bytes, not 4
});

test('0BA5 leaking device: full unlock recovers the cleartext and opens the program', async () => {
  const h = makeHarness({ identNo: 0x42, passwordExists: true, leaksCleartext: true, clearWriteUnlocks: true, password: 'ba5pw', program: new Uint8Array(8).fill(0x33) });
  await recoverPasswordAndUnlock(h.app);
  assert.equal(h.conn.deviceName, '0BA5');
  assert.ok(logged(h.logger, 'ba5pw'));
  assert.ok(logged(h.logger, 'Read access OPEN'));
  // The clear write went out as a 2-byte address (01 48 00 00), not the 4-byte form.
  assert.ok(h.device.writes.some((w) => w[0] === 0x01 && w[1] === 0x48 && w[2] === 0x00 && w[3] === 0x00 && w.length === 4));
});
