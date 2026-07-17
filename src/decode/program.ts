// Program decoder. Pure functions over a combined dump buffer — no I/O, no DOM — so the same
// code decodes a live read and a saved .bin file.

import { hexb, w16 } from '../util/hex.js';
import { GF, SF, WIRING_GROUPS } from './constants.js';

/**
 * Connector word (little-endian) → signal name, or null for unused (`FFFF`). See PROTOCOL.md
 * §5.2 for the encoding.
 */
export function co(w: number): string | null {
  if (w === 0xffff) return null;
  const hi = w >> 8;
  const lo = w & 0xff;
  const neg = (hi & 0x40) !== 0;
  const p = neg ? '/' : '';
  if (hi & 0x80) {
    // block reference: LoByte 0x0A..0x8C => B001..B130
    if (lo >= 0x0a && lo <= 0x8c) return p + 'B' + String(lo - 9).padStart(3, '0');
    return p + 'B?(' + w.toString(16).padStart(4, '0') + ')';
  }
  if (hi === 0x00 || hi === 0x40) {
    // terminal / constant
    if (lo <= 0x17) return p + 'I' + (lo + 1);
    if (lo >= 0x30 && lo <= 0x3f) return p + 'Q' + (lo - 0x30 + 1);
    if (lo >= 0x50 && lo <= 0x67) return p + 'M' + (lo - 0x50 + 1);
    if (lo >= 0x80 && lo <= 0x87) return p + 'AI' + (lo - 0x80 + 1);
    if (lo >= 0x92 && lo <= 0x97) return p + 'AM' + (lo - 0x92 + 1);
    if (lo >= 0xa0 && lo <= 0xa3) return p + ['C-up', 'C-dn', 'C-lt', 'C-rt'][lo - 0xa0];
    if (lo >= 0xb0 && lo <= 0xb7) return p + 'S' + (lo - 0xb0 + 1);
    if (lo === 0xfc) return p + 'Float';
    if (lo === 0xfd) return p + 'hi';
    if (lo === 0xfe) return p + 'lo';
  }
  return '?' + w.toString(16).padStart(4, '0');
}

/**
 * Decode a combined dump laid out as
 * `[260 ptr @0C14][200 term @0E20][2000 prog @0EE8]` into a human-readable netlist.
 */
export function decodeCombined(bytes: Uint8Array): string {
  const ptr = bytes.slice(0, 260);
  const term = bytes.slice(260, 460);
  const prog = bytes.slice(460, 2460);
  const out: string[] = [];

  out.push('=== OUTPUTS / MARKERS (from 0x0E20 wiring) ===');
  for (const [lbl, addr, cnt] of WIRING_GROUPS) {
    for (let i = 0; i < cnt; i++) {
      const rec = Math.floor(i / 8);
      const slot = i % 8;
      const off = addr - 0x0e20 + rec * 20 + 2 + slot * 2;
      if (off + 1 >= term.length) continue;
      const src = co(w16(term, off));
      if (src) out.push('  ' + lbl + (i + 1) + ' = ' + src);
    }
  }

  out.push('');
  out.push('=== BLOCKS (via pointer table 0x0C14 → program mem 0x0EE8) ===');
  out.push('  (basic gates decoded exactly; special-function params shown raw)');
  let nBlocks = 0;
  for (let i = 0; i < 130; i++) {
    const P = w16(ptr, i * 2);
    if (P === 0xffff) continue;
    const boff = P - 0xc8; // 0x0E20+P - 0x0EE8
    if (boff < 0 || boff + 2 > prog.length) continue;
    nBlocks++;
    const op = prog[boff];
    const bn = 'B' + String(i + 1).padStart(3, '0');
    const gf = GF[op];
    const sf = SF[op];
    if (gf) {
      const [nm, len] = gf;
      const inputs: string[] = [];
      for (let o = boff + 2; o < boff + len && o + 1 < prog.length; o += 2) {
        const c = co(w16(prog, o));
        if (c) inputs.push(c);
      }
      out.push('  ' + bn + ' = ' + nm + '(' + inputs.join(', ') + ')');
    } else if (sf) {
      const [nm, len] = sf;
      out.push('  ' + bn + ' = ' + nm.padEnd(16) + ' raw: ' + hexb(prog, boff, Math.min(len, prog.length - boff)));
    } else {
      out.push('  ' + bn + ' = ??? opcode 0x' + op.toString(16).padStart(2, '0') + '  raw: ' + hexb(prog, boff, 12));
    }
  }
  if (!nBlocks) {
    out.push('  (no blocks found — pointer table is all FFFF. Wrong address page, or program empty/password-protected.)');
  }
  out.push('');
  out.push(
    'Blocks found: ' + nBlocks + '. Basic gates are exact; send me the .bin and I can decode the special-function parameters (timer values, counter limits, etc.).',
  );
  return out.join('\n');
}
