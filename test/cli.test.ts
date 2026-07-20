// CLI render() dispatch tests — the argv/file/stdout wiring is a thin shell around render(), which
// is what carries the logic worth testing. Images are built by hand (no device bytes).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { render } from '../src/cli.js';

const MIN_BASE = 0x0688;
function setWord(img: Uint8Array, addr: number, w: number): void {
  img[addr - MIN_BASE] = w & 0xff;
  img[addr - MIN_BASE + 1] = (w >> 8) & 0xff;
}

/** A minimal but valid 0BA6 full image: one AND block (B001) wired to output Q1. */
function tinyImage(): Uint8Array {
  const img = new Uint8Array(15074).fill(0xff);
  setWord(img, 0x2faa + 2 * (1 + 9), 200); // offset table: B001 at program offset 0
  setWord(img, 0x3292 + 0, 0x4001); // opcode word: AND, flags 0x40 (no remanence/protection)
  setWord(img, 0x3292 + 2, 0x0000); // input I1
  setWord(img, 0x31ca + 2, 0x800a); // anchor Q1 driven by B001
  return img;
}

test('render: 0BA6 netlist', () => {
  const out = render(tinyImage(), 'netlist');
  assert.match(out, /=== BLOCKS \(1\) ===/);
  assert.match(out, /B001 = AND\(I1/);
  assert.match(out, /Q1 = B001/);
});

test('render: 0BA6 mermaid', () => {
  const out = render(tinyImage(), 'mermaid');
  assert.match(out, /^flowchart LR/);
  assert.match(out, /B001\["B001<br\/>& AND"\]/);
  assert.match(out, /B001 --> Q1/);
});

test('render: legacy 2460-byte dump goes through the legacy decoder', () => {
  const out = render(new Uint8Array(2460), 'netlist'); // all-zero legacy image decodes (to "no blocks")
  assert.match(out, /OUTPUTS|BLOCKS|pointer table/);
});

test('render: a too-short buffer throws a helpful error for both formats', () => {
  assert.throws(() => render(new Uint8Array(100), 'netlist'), /full 0BA6 image/);
  assert.throws(() => render(new Uint8Array(100), 'mermaid'), /Mermaid is 0BA6-only/);
});
