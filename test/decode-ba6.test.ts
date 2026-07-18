// 0BA6 (Logo6) netlist decoder tests. Builds a synthetic full address-span image by hand (matching
// the LSC on-wire layout) and asserts the decode, plus the connector-word encoding against the
// documented reference cases. No real device bytes are embedded.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connector, decode0BA6, decodeTime } from '../src/decode/ba6.js';

test('decodeTime: the four time bases (top 2 bits) and their units', () => {
  assert.equal(decodeTime(0x412c), '3.00s'); // base 01 (seconds), value 300 → 3.00 s (the real capture)
  assert.equal(decodeTime(0x0064), '1.00s'); // base 00 (seconds), value 100 → 1.00 s
  assert.equal(decodeTime(0x04d2), '12.34s'); // base 00, value 1234 → 12.34 s
  assert.equal(decodeTime(0x8000 | 90), '1:30m'); // base 10 (minutes): 90 → 1 min 30 s
  assert.equal(decodeTime(0xc000 | 150), '2:30h'); // base 11 (hours): 150 → 2 h 30 min
});

test('connector: block references, negation, and I/O terminals', () => {
  // Reference cases from the decompiled CompilerFromLogo4.getTarget / getRealCOOpcode.
  assert.equal(connector(0x8019), 'B016'); // block ref: line 0x19=25 → B016
  assert.equal(connector(0x8021), 'B024'); // line 0x21=33 → B024
  assert.equal(connector(0xc00a), '/B001'); // negated block ref: line 10 → /B001
  assert.equal(connector(0x800a), 'B001'); // line 10 → B001
  assert.equal(connector(0xffff), null); // open pin
  assert.equal(connector(0x00fc), null); // NC placeholder
  // I/O terminals via the Logo6 real-CO-opcode ranges.
  assert.equal(connector(0x0000), 'I1');
  assert.equal(connector(0x0017), 'I24');
  assert.equal(connector(0x0030), 'Q1'); // 48 → Q1
  assert.equal(connector(0x0050), 'M1'); // 80 → M1
  assert.equal(connector(0x0080), 'AI1'); // 128 → AI1
  assert.equal(connector(0x0090), 'AQ1'); // 144 → AQ1
  assert.equal(connector(0x0092), 'AM1'); // 146 → AM1
  assert.equal(connector(0x00fd), 'hi'); // 253
  assert.equal(connector(0x00fe), 'lo'); // 254
  assert.equal(connector(0x40fe), '/lo'); // negated constant
  assert.equal(connector(0x4000), '/I1'); // negated input
});

// --- Build a minimal but format-faithful 0BA6 full image (starts at 0x0688). ---
const MIN_BASE = 0x0688;
function setWord(img: Uint8Array, addr: number, w: number): void {
  img[addr - MIN_BASE] = w & 0xff;
  img[addr - MIN_BASE + 1] = (w >> 8) & 0xff;
}

function buildImage(): Uint8Array {
  const img = new Uint8Array(15074).fill(0xff); // 0xFF = unused everywhere (names/offsets/anchors)
  // Offset table @0x2FAA: entry for block n at byte 2*(n+9); value = program offset + 200.
  setWord(img, 0x2faa + 2 * (1 + 9), 200); // B001 at program offset 0
  setWord(img, 0x2faa + 2 * (2 + 9), 212); // B002 at program offset 12
  // Program body @0x3292.
  // B001 = AND, flags hi=0x40 (no remanence, protection off): inputs I1, /B002, open, open.
  setWord(img, 0x3292 + 0, 0x4001); // opcode word: low=0x01 AND, high=0x40
  setWord(img, 0x3292 + 2, 0x0000); // I1
  setWord(img, 0x3292 + 4, 0xc00b); // /B002 (line 11 = B002, negated)
  setWord(img, 0x3292 + 6, 0xffff); // open
  setWord(img, 0x3292 + 8, 0xffff); // open
  // B002 = on-delay, flags hi=0x80 (remanent; 0x40 clear → also protected): input I2, T = 3.00 s.
  setWord(img, 0x3292 + 12, 0x8021); // opcode word: low=0x21 on-delay, high=0x80
  setWord(img, 0x3292 + 14, 0x0001); // I2
  setWord(img, 0x3292 + 16, 0x412c); // time word: base 01 (seconds), value 300 → 3.00 s
  // Anchor Q @0x31CA: row 0, col 0 driver (skip the 2-byte header) = B001 → Q1.
  setWord(img, 0x31ca + 2, 0x800a); // B001
  // Name index @0x0688 (1 byte per slot = the named block's program line), strings @0x0708 (8B slots).
  img[0x0688 - MIN_BASE + 0] = 11; // slot 0 → program line 11 = B002
  const nm = 'TMR';
  for (let i = 0; i < nm.length; i++) img[0x0708 - MIN_BASE + i] = nm.charCodeAt(i);
  img[0x0708 - MIN_BASE + nm.length] = 0x00;
  return img;
}

test('decode0BA6: blocks, inputs, flags, named block, and the Q output', () => {
  const nl = decode0BA6(buildImage());
  assert.ok(nl, 'expected a netlist');
  assert.match(nl, /B001 = AND\(I1, \/B002, ·, ·\)/); // 4 AND pins; the two unwired show as ·
  assert.doesNotMatch(nl.split('\n').find((l) => l.includes('B001 ='))!, /protected/); // basic gate is never "protected"
  assert.match(nl, /B002 "TMR" = on-delay\(I2\)\s+T=3\.00s\s+\[remanent, protected\]/);
  assert.match(nl, /Q1 = B001/);
  assert.match(nl, /=== NAMED BLOCKS ===/);
  assert.match(nl, /B002 = "TMR"/);
  assert.match(nl, /Decoded 2 blocks/);
});

test('decode0BA6: AND with protection off shows no flag tag', () => {
  const nl = decode0BA6(buildImage())!;
  const b001 = nl.split('\n').find((l) => l.includes('B001 ='))!;
  assert.doesNotMatch(b001, /\[/, 'B001 (hi=0x40) has neither remanence nor protection flags');
});

test('decode0BA6: latching-relay and pulse-relay are never [protected] (plain BlockParameter)', () => {
  // Both use a plain BlockParameter, so the protection bit does not apply even with hi=0x00.
  const img = new Uint8Array(15074).fill(0xff);
  setWord(img, 0x2faa + 2 * (1 + 9), 200); // B001 @ program offset 0
  setWord(img, 0x2faa + 2 * (2 + 9), 208); // B002 @ program offset 8
  setWord(img, 0x3292 + 0, 0x0025); // B001 = latching-relay, hi=0x00 (would be "protected" if the bit applied)
  setWord(img, 0x3292 + 8, 0x8023); // B002 = pulse-relay, hi=0x80 (remanent), hi&0x40==0
  const nl = decode0BA6(img)!;
  const b001 = nl.split('\n').find((l) => l.includes('B001 ='))!;
  const b002 = nl.split('\n').find((l) => l.includes('B002 ='))!;
  assert.match(b001, /latching-relay/);
  assert.doesNotMatch(b001, /protected/);
  assert.match(b002, /pulse-relay/);
  assert.match(b002, /\[remanent\]/); // remanence DOES apply (RemanenceObject)
  assert.doesNotMatch(b002, /protected/); // protection does NOT
});

test('decode0BA6: declines an image that is too short to hold the program body', () => {
  assert.equal(decode0BA6(new Uint8Array(100)), null);
});

test('decode0BA6: an all-0xFF image has no blocks and no wired outputs', () => {
  const nl = decode0BA6(new Uint8Array(15074).fill(0xff))!;
  assert.match(nl, /=== BLOCKS \(0\) ===/);
  assert.match(nl, /\(no outputs or markers wired\)/);
});
