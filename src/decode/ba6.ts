// 0BA6 (Logo6) netlist decoder. Pure functions over a full address-span image (the bytes saved as
// logo_<slug>_full.bin, which begins at 0x0688). Turns the captured program into a human-readable
// netlist: each block's function and wiring, the output/marker drivers, and any user block names.
//
// Format authority: decompiled LOGO!Soft Comfort — CompilerFromLogo4.compileProgramMemory /
// compileAnchors / connect / getTarget, and Logo6.getMemories / Logo6$BlockMemoryUsage. The rules
// below are the distilled spec. Verified end-to-end against a real ES10 capture (password RHOMBUS):
// 21 blocks, two named on-delay timers, Q1←B008 / Q2←B009.
//
//   - Offset table @0x2FAA: for block n (1..200), V = LE-u16 at byte 2*(n+9); 0xFFFF = absent;
//     the record sits at program-body offset (V − 200). Record length = next block's offset − this.
//   - Record: word0 = opcode (LOW byte = function code; HIGH byte = flags: 0x80 remanence,
//     0x40==0 protection, 0x20>>k = parameter k is a block reference). Input connectors follow as
//     consecutive LE-u16 words; how many is fixed per function code.
//   - Connector word: 0xFF/0xFC low byte = open; 0x4000 = negated; 0x8000 = reference to a logic
//     block (block# = (word & 0x3FF) − 9); else an I/O terminal (number = word & 0x3FF).
//   - Output anchors (Q/M/AQ/…): rows of 20 bytes = [header][8 driver words][trailer], each driver
//     the same connector encoding.

import { w16 } from '../util/hex.js';

const MIN_BASE = 0x0688; // the full image begins here (lowest region base)
const OFFSET_TABLE = 0x2faa; // block-index → program offset (LE u16, +200 bias)
const PROGRAM_BODY = 0x3292;
const NAME_INDEX = 0x0688; // 1 byte per name slot: the program line of the named block
const NAME_STRINGS = 0x0708; // 8-byte name slots
const OFFSET_BIAS = 200;
const MAX_BLOCKS = 200;

/** Function code (opcode low byte) → [name, record length incl. opcode word, number of input pins]. */
const OPCODES: Record<number, readonly [string, number, number]> = {
  0x01: ['AND', 12, 4],
  0x02: ['OR', 12, 4],
  0x03: ['NOT', 4, 1],
  0x04: ['NAND', 12, 4],
  0x05: ['NOR', 12, 4],
  0x06: ['XOR', 8, 2],
  0x07: ['AND-edge', 12, 4],
  0x08: ['NAND-edge', 12, 4],
  0x21: ['on-delay', 8, 1],
  0x22: ['off-delay', 12, 2],
  0x23: ['pulse-relay', 12, 3],
  0x24: ['weekly-timer', 20, 3],
  0x25: ['latching-relay', 8, 2],
  0x27: ['ret-on-delay', 12, 2],
  0x29: ['hours-counter', 28, 3],
  0x2a: ['wiping-relay', 8, 1],
  0x2b: ['up/down-counter', 28, 3],
  0x2c: ['freq-trigger', 16, 1],
  0x2d: ['async-pulse-gen', 12, 2],
  0x2e: ['year-clock', 12, 0],
  0x2f: ['on/off-delay', 12, 1],
  0x30: ['random', 12, 1],
  0x31: ['stairwell-switch', 12, 1],
  0x32: ['comfort-switch', 16, 2],
  0x33: ['wiping-relay-pec', 16, 2],
  0x34: ['message-text', 8, 1],
  0x35: ['analog-threshold', 16, 1],
  0x36: ['analog-comparator', 24, 2],
  0x37: ['softkey', 8, 1],
  0x38: ['shift-register', 12, 3],
  0x39: ['analog-watchdog', 20, 2],
  0x3a: ['analog-delta-trigger', 16, 1],
  0x3b: ['PWM', 24, 2],
  0x3c: ['math-detection', 12, 2],
  0x40: ['analog-mux', 20, 3],
  0x41: ['ramp-control', 36, 3],
  0x42: ['amplifier', 12, 1],
  0x43: ['PID', 40, 3],
  0x44: ['analog-maths', 20, 1],
};

/**
 * Decode a single 16-bit connector word to a signal name, or null if the pin is open/unwired.
 * `0xFF`/`0xFC` low byte = open; `0x4000` = negated; `0x8000` = logic-block reference; otherwise an
 * I/O terminal whose number is the low 10 bits, mapped through the Logo6 real-CO-opcode ranges.
 */
export function connector(word: number): string | null {
  const p = connectorParts(word);
  return p ? (p.neg ? '/' : '') + p.sig : null;
}

/** The connector split into its signal name and its inversion flag (null if the pin is open). */
export function connectorParts(word: number): { sig: string; neg: boolean } | null {
  const low = word & 0xff;
  if (low === 0xff || low === 0xfc) return null; // open / not-connected
  const neg = !!(word & 0x4000);
  if (word & 0x8000) return { sig: 'B' + String((word & 0x3ff) - 9).padStart(3, '0'), neg };
  const v = word & 0x3ff;
  let sig: string;
  if (v === 253) sig = 'hi';
  else if (v === 254) sig = 'lo';
  else if (v >= 192) sig = 'V' + (v - 192 + 1); // virtual output
  else if (v >= 176) sig = 'S' + (v - 176 + 1); // shift-register bit
  else if (v >= 164) sig = 'F' + (v - 164 + 1); // TD function key
  else if (v >= 160) sig = ['C↑', 'C↓', 'C←', 'C→'][v - 160];
  else if (v >= 146) sig = 'AM' + (v - 146 + 1); // analog marker
  else if (v >= 144) sig = 'AQ' + (v - 144 + 1); // analog output
  else if (v >= 128) sig = 'AI' + (v - 128 + 1); // analog input
  else if (v >= 104 && v < 128) sig = 'X' + (v - 104 + 1); // special marker
  else if (v >= 80) sig = 'M' + (v - 80 + 1);
  else if (v >= 48) sig = 'Q' + (v - 48 + 1);
  else sig = 'I' + (v + 1);
  return { sig, neg };
}

/** Basic functions (0x01–0x08) have NO BlockParameter, so LSC never applies the flag bits to them. */
function isBasicGate(op: number): boolean {
  return op >= 0x01 && op <= 0x08;
}

/**
 * Special-function opcodes whose parameter is a `ProtectionParameter` subclass — the ONLY blocks for
 * which the protection flag (opcode high-byte bit 0x40 == 0) is meaningful. From the LSC parameter
 * class hierarchy: PulseRelay (0x23), LatchingRelay (0x25) and ShiftRegister (0x38) use a plain
 * BlockParameter and are therefore NEVER protected; every other SF here extends ProtectionParameter.
 */
const PROTECTION = new Set([
  0x21, 0x22, 0x24, 0x27, 0x29, 0x2a, 0x2b, 0x2c, 0x2d, 0x2e, 0x2f, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x39,
  0x3a, 0x3b, 0x3c, 0x40, 0x41, 0x42, 0x43, 0x44,
]);

/**
 * Timer blocks whose record stores plain time words immediately after the input connectors, in this
 * order. (Blocks with cam/analog/counter parameters instead of plain times are omitted — their
 * parameter bytes are shown raw rather than mis-decoded as times.)
 */
const TIME_PARAMS: Record<number, readonly string[]> = {
  0x21: ['T'], // on-delay
  0x22: ['T'], // off-delay
  0x27: ['T'], // ret-on-delay
  0x2a: ['T'], // wiping-relay (pulse width)
  0x2d: ['TH', 'TL'], // async-pulse-gen
  0x2f: ['TH', 'TL'], // on/off-delay
  0x30: ['TH', 'TL'], // random
};

/**
 * Decode a LOGO! time word: the top 2 bits select the base, the low 14 bits the value.
 * base 0/1 = seconds (value = hundredths, shown S.cc s); 2 = minutes (mm:ss); 3 = hours (hh:mm).
 * Matches CompilerFromLogo(4).getNewTimeObject.
 */
export function decodeTime(word: number): string {
  const base = word & 0xc000;
  const v = word & 0x3fff;
  if (base === 0x0000 || base === 0x4000) return (v / 100).toFixed(2) + 's';
  const a = Math.floor(v / 60);
  const b = String(v % 60).padStart(2, '0');
  return base === 0x8000 ? a + ':' + b + 'm' : a + ':' + b + 'h';
}

/** Read user block names: name-index @0x0688 holds the program line, strings @0x0708 are 8-byte slots. */
function readNames(img: Uint8Array): Map<number, string> {
  const names = new Map<number, string>();
  const idxOff = NAME_INDEX - MIN_BASE;
  const strOff = NAME_STRINGS - MIN_BASE;
  for (let i = 0; i < 100; i++) {
    const line = img[idxOff + i];
    if (line === undefined || line === 0xff) continue;
    const block = line - 9;
    let s = '';
    for (let j = 0; j < 8; j++) {
      const c = img[strOff + i * 8 + j];
      if (c === 0x00 || c === 0xff || c === undefined) break;
      if (c >= 32 && c < 127) s += String.fromCharCode(c);
    }
    if (s) names.set(block, s);
  }
  return names;
}

/** Output/marker anchor tables: [label, base, rows, first-anchor-number]. 20-byte rows, 8 drivers each. */
const ANCHORS: readonly (readonly [string, number, number, number])[] = [
  ['Q', 0x31ca, 2, 1],
  ['M', 0x31f2, 3, 1],
  ['AQ', 0x322e, 1, 1],
  ['V', 0x3242, 2, 1],
  ['X', 0x327e, 1, 25], // special markers are numbered from 25
];

/**
 * Decode a full 0BA6 address-span image (the bytes of logo_<slug>_full.bin, starting at 0x0688)
 * into a netlist. Returns null if the image is not a plausible 0BA6 image (wrong size / empty).
 */
export function decode0BA6(img: Uint8Array): string | null {
  // The image must at least span through the program body for the offset table to resolve.
  if (img.length < PROGRAM_BODY - MIN_BASE + 4) return null;
  const ot = OFFSET_TABLE - MIN_BASE;
  const prog = PROGRAM_BODY - MIN_BASE;

  // First pass: collect present blocks (number → program-body offset) so we can size records by the
  // gap to the next block, matching how LSC lays them out contiguously.
  const present: { n: number; off: number }[] = [];
  for (let n = 1; n <= MAX_BLOCKS; n++) {
    const v = w16(img, ot + 2 * (n + 9));
    if (v === 0xffff) continue;
    present.push({ n, off: v - OFFSET_BIAS });
  }
  present.sort((a, b) => a.off - b.off);

  const names = readNames(img);
  const out: string[] = [];
  out.push('=== BLOCKS (' + present.length + ') ===');
  for (let i = 0; i < present.length; i++) {
    const { n, off } = present[i];
    const base = prog + off;
    const bn = 'B' + String(n).padStart(3, '0');
    const label = names.has(n) ? bn + ' "' + names.get(n) + '"' : bn;
    if (off < 0 || base + 2 > img.length) {
      out.push('  ' + label + ' = <offset out of range>');
      continue;
    }
    const op = img[base];
    const hi = img[base + 1];
    const spec = OPCODES[op];
    // Flags apply only where LSC applies them: never to a basic gate (no parameter), and the
    // protection flag only to blocks whose parameter is a ProtectionParameter (see compileOpcode).
    const flags: string[] = [];
    if (!isBasicGate(op)) {
      if (hi & 0x80) flags.push('remanent');
      if (PROTECTION.has(op) && !(hi & 0x40)) flags.push('protected');
    }
    const flagStr = flags.length ? '  [' + flags.join(', ') + ']' : '';
    if (!spec) {
      out.push('  ' + label + ' = ??? function 0x' + op.toString(16).padStart(2, '0') + flagStr);
      continue;
    }
    const [name, , nIn] = spec;
    const inputs: string[] = [];
    for (let k = 0; k < nIn; k++) {
      const wo = base + 2 + k * 2;
      if (wo + 1 >= img.length) break;
      inputs.push(connector(w16(img, wo)) ?? '·');
    }
    // Time parameters (for timer blocks) sit as plain words right after the input connectors.
    const params: string[] = [];
    for (const [k, plabel] of (TIME_PARAMS[op] ?? []).entries()) {
      const wo = base + 2 + nIn * 2 + k * 2;
      if (wo + 1 < img.length) params.push(plabel + '=' + decodeTime(w16(img, wo)));
    }
    const paramStr = params.length ? '  ' + params.join(' ') : '';
    out.push('  ' + label + ' = ' + name + '(' + inputs.join(', ') + ')' + paramStr + flagStr);
  }

  out.push('');
  out.push('=== OUTPUTS & MARKERS ===');
  let anyOut = false;
  for (const [lbl, addrBase, rows, firstNum] of ANCHORS) {
    const rb = addrBase - MIN_BASE;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < 8; col++) {
        const wo = rb + row * 20 + 2 + col * 2; // skip the 2-byte row header
        if (wo + 1 >= img.length) continue;
        const src = connector(w16(img, wo));
        if (src) {
          out.push('  ' + lbl + (firstNum + row * 8 + col) + ' = ' + src);
          anyOut = true;
        }
      }
    }
  }
  if (!anyOut) out.push('  (no outputs or markers wired)');

  if (names.size) {
    out.push('');
    out.push('=== NAMED BLOCKS ===');
    for (const { n } of present) if (names.has(n)) out.push('  B' + String(n).padStart(3, '0') + ' = "' + names.get(n) + '"');
  }

  out.push('');
  out.push(
    'Decoded ' + present.length + ' blocks from the 0BA6 program. Basic gates, wiring, and timer ' +
      'values are exact. `/X` marks an inverted input; [remanent]/[protected] are per-block flags. ' +
      'Non-timer special-function parameters (counter limits, analog gains) are not decoded yet.',
  );
  return out.join('\n');
}

/** Mermaid node shape for a block: hexagon for timers, rounded for latches/pulse, rectangle otherwise. */
function nodeShape(op: number, text: string): string {
  const q = '"' + text + '"';
  if (op in TIME_PARAMS) return '{{' + q + '}}';
  if (op === 0x25 || op === 0x23) return '(' + q + ')';
  return '[' + q + ']';
}

/**
 * The IEC 60617 qualifying symbol LSC draws inside a basic-gate box: `&` for AND-family, `≥1` for
 * OR-family, `=1` for XOR, `1` for a buffer/NOT. NAND/NOR/edge variants share the base symbol (LSC
 * adds an output bubble / edge mark); the block name still spells out the exact variant.
 */
const GATE_SYMBOL: Record<number, string> = {
  0x01: '&',
  0x02: '≥1',
  0x03: '1',
  0x04: '&',
  0x05: '≥1',
  0x06: '=1',
  0x07: '&',
  0x08: '&',
};

/**
 * Render the decoded 0BA6 program as a Mermaid `flowchart LR`: inputs on the left flowing through
 * the blocks to the outputs. Basic gates carry LSC's IEC symbol (`&`, `≥1`, `=1`), and an inverted
 * input is a circle-ending link (the LSC negation bubble). Returns null for a non-0BA6 image. The
 * output is Mermaid source text — the caller decides how to render/link it.
 */
export function toMermaid(img: Uint8Array): string | null {
  if (img.length < PROGRAM_BODY - MIN_BASE + 4) return null;
  const ot = OFFSET_TABLE - MIN_BASE;
  const prog = PROGRAM_BODY - MIN_BASE;
  const names = readNames(img);

  const present: { n: number; off: number }[] = [];
  for (let n = 1; n <= MAX_BLOCKS; n++) {
    const v = w16(img, ot + 2 * (n + 9));
    if (v !== 0xffff) present.push({ n, off: v - OFFSET_BIAS });
  }
  present.sort((a, b) => a.off - b.off);

  const nodeLines: string[] = [];
  const edges: string[] = [];
  const inputTerms = new Set<string>(); // I*/AI* terminals referenced as sources
  // A negated input uses Mermaid's circle-ending link (`--o`), which draws a bubble at the block's
  // input pin — the same inversion mark LSC puts there. A normal input is a plain arrow.
  const addEdge = (from: string, to: string, neg: boolean): void => {
    edges.push('  ' + from + (neg ? ' --o ' : ' --> ') + to);
    if (/^A?I\d+$/.test(from)) inputTerms.add(from);
  };

  for (const { n, off } of present) {
    const base = prog + off;
    if (off < 0 || base + 2 > img.length) continue;
    const op = img[base];
    const id = 'B' + String(n).padStart(3, '0');
    const spec = OPCODES[op];
    const type = spec ? spec[0] : 'op' + op.toString(16).padStart(2, '0');
    let text = id;
    if (names.has(n)) text += " '" + names.get(n) + "'";
    text += '<br/>' + (GATE_SYMBOL[op] ? GATE_SYMBOL[op] + ' ' : '') + type;
    for (const [k, plabel] of (TIME_PARAMS[op] ?? []).entries()) {
      const wo = base + 2 + (spec ? spec[2] : 0) * 2 + k * 2;
      if (wo + 1 < img.length) text += ' ' + plabel + '=' + decodeTime(w16(img, wo));
    }
    nodeLines.push('  ' + id + nodeShape(op, text));
    const nIn = spec ? spec[2] : 0;
    for (let k = 0; k < nIn; k++) {
      const wo = base + 2 + k * 2;
      if (wo + 1 >= img.length) break;
      const p = connectorParts(w16(img, wo));
      if (p) addEdge(p.sig, id, p.neg);
    }
  }

  // Output anchors → their driver.
  const outNodes: string[] = [];
  for (const [lbl, addrBase, rows, firstNum] of ANCHORS) {
    const rb = addrBase - MIN_BASE;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < 8; col++) {
        const wo = rb + row * 20 + 2 + col * 2;
        if (wo + 1 >= img.length) continue;
        const p = connectorParts(w16(img, wo));
        if (p) {
          const term = lbl + (firstNum + row * 8 + col);
          outNodes.push('    ' + term + '(["' + term + '"])');
          addEdge(p.sig, term, p.neg);
        }
      }
    }
  }

  if (!nodeLines.length && !outNodes.length) return null;

  const lines = ['flowchart LR'];
  if (inputTerms.size) {
    lines.push('  subgraph IN[inputs]');
    for (const t of [...inputTerms].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })))
      lines.push('    ' + t + '(["' + t + '"])');
    lines.push('  end');
  }
  lines.push(...nodeLines);
  if (outNodes.length) {
    lines.push('  subgraph OUT[outputs]');
    lines.push(...outNodes);
    lines.push('  end');
  }
  lines.push(...edges);
  return lines.join('\n');
}
