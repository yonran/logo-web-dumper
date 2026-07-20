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
  0x24: ['weekly-timer', 20, 0], // the 3 cams are PARAMETERS, not wired inputs — no digital pins
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
 * Ordered names of a special-function block's WIRED input pins (from the LSC block classes'
 * initInConnectors, taking the connectors before the parameter connector). Basic gates and NOT/XOR
 * have only numbered, commutative inputs, so they are omitted (labels would add nothing). The order
 * matches the byte order the compiler reads (connect(block, 0), (1), …), so pin k = names[k].
 */
const INPUT_NAMES: Record<number, readonly string[]> = {
  0x21: ['Trg'], // on-delay
  0x22: ['Trg', 'R'], // off-delay
  0x23: ['Trg', 'S', 'R'], // pulse-relay
  0x25: ['S', 'R'], // latching-relay (RS)
  0x27: ['Trg', 'R'], // ret-on-delay
  0x29: ['R', 'En', 'Ral'], // hours-counter
  0x2a: ['Trg'], // wiping-relay
  0x2b: ['R', 'Cnt', 'Dir'], // up/down-counter
  0x2c: ['Fre'], // freq-trigger
  0x2d: ['En', 'Inv'], // async-pulse-gen
  0x2f: ['Trg'], // on/off-delay
  0x30: ['En'], // random
  0x31: ['Trg'], // stairwell-switch
  0x32: ['Trg', 'R'], // comfort-switch
  0x33: ['Trg', 'R'], // wiping-relay-pec
  0x34: ['En'], // message-text
  0x35: ['Ax'], // analog-threshold
  0x36: ['Ax', 'Ay'], // analog-comparator
  0x37: ['En'], // softkey
  0x38: ['In', 'Trg', 'Dir'], // shift-register
  0x39: ['En', 'Ax'], // analog-watchdog
  0x3a: ['Ax'], // analog-delta-trigger
  0x3b: ['En', 'Ax'], // PWM
  0x3c: ['En', 'R'], // math-detection
  0x40: ['En', 'S1', 'S2'], // analog-mux
  0x41: ['En', 'Sel', 'St'], // ramp-control
  0x42: ['Ax'], // amplifier
  0x43: ['A/M', 'R', 'PV'], // PID
  0x44: ['En'], // analog-maths
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

/** Timer/timing blocks drawn as a hexagon in the diagram (delays, generators, freq trigger). */
const HEX_OPS = new Set([0x21, 0x22, 0x27, 0x2a, 0x2c, 0x2d, 0x2f, 0x30, 0x31, 0x32, 0x33]);

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

/** Signed analog value shown with `dp` implied decimal places (displayed = raw / 10^dp). */
function analog(raw: number, dp: number): string {
  const neg = raw < 0;
  let s = String(Math.abs(raw));
  if (dp > 0) {
    while (s.length <= dp) s = '0' + s;
    s = s.slice(0, s.length - dp) + '.' + s.slice(s.length - dp);
  }
  return (neg ? '-' : '') + s;
}

/** Weekday bitmask (bit0=Sun … bit6=Sat) → a compact label. */
function weekdays(mask: number): string {
  if (mask === 0x7f) return 'daily';
  if (mask === 0x3e) return 'Mo-Fr';
  if (mask === 0x7e) return 'Mo-Sa';
  const names = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
  const on: string[] = [];
  for (let i = 0; i < 7; i++) if (mask & (1 << i)) on.push(names[i]);
  return on.join(',') || 'never';
}

/** A weekly-timer cam time word → "hh:mm", or null when the cam slot is inactive. */
function camTime(word: number): string | null {
  if (word === 0xffff || (word & 0x3fff) === 0x3fff) return null;
  const v = word & 0x3fff;
  return String(Math.floor(v / 60)).padStart(2, '0') + ':' + String(v % 60).padStart(2, '0');
}

/**
 * Decode the configured PARAMETERS of a block (everything after the input connectors) to a list of
 * "Name=value" strings. Layouts and encodings are from the LSC compile() methods (CompilerFromLogo4/
 * 5/6) — see PROTOCOL notes / scratchpad ba6-params-findings. `hi` is the opcode high byte, whose
 * bits 0x20>>k mark parameter k as a reference to another block rather than a literal.
 */
function blockParams(op: number, img: Uint8Array, pBase: number, hi: number): string[] {
  const uw = (o: number): number => (pBase + o + 1 < img.length ? w16(img, pBase + o) : 0);
  const sw = (o: number): number => {
    const v = uw(o);
    return v >= 0x8000 ? v - 0x10000 : v;
  };
  const dw = (o: number): number => (uw(o) | (uw(o + 2) << 16)) >>> 0;
  const bt = (o: number): number => img[pBase + o] ?? 0;
  const ref = (bit: number): boolean => (hi & bit) !== 0;
  const refB = (o: number): string => '→B' + String(bt(o) - 9).padStart(3, '0'); // ref target = low byte
  const t = (o: number): string => decodeTime(uw(o));
  const gain = (o: number): string => (sw(o) / 100).toFixed(2);
  const out: string[] = [];
  switch (op) {
    case 0x21: // on-delay
    case 0x22: // off-delay
    case 0x27: // ret-on-delay
    case 0x2a: // wiping-relay
      out.push('T=' + (ref(0x20) ? refB(0) : t(0)));
      break;
    case 0x2d: // async-pulse-gen
    case 0x2f: // on/off-delay
    case 0x30: // random
      out.push('TH=' + (ref(0x20) ? refB(0) : t(0)), 'TL=' + (ref(0x10) ? refB(2) : t(2)));
      break;
    case 0x31: // stairwell-switch
      out.push('T=' + (ref(0x20) ? refB(0) : t(0)), 'T!=' + (ref(0x10) ? refB(2) : t(2)), 'T!L=' + (ref(0x08) ? refB(4) : t(4)));
      break;
    case 0x32: // comfort-switch (TL before TH in memory)
      out.push(
        'TH=' + (ref(0x20) ? refB(2) : t(2)),
        'TL=' + (ref(0x10) ? refB(0) : t(0)),
        'T!=' + (ref(0x08) ? refB(4) : t(4)),
        'T!L=' + (ref(0x04) ? refB(6) : t(6)),
      );
      break;
    case 0x33: // wiping-relay-pec
      out.push('TH=' + (ref(0x20) ? refB(0) : t(0)), 'TL=' + (ref(0x10) ? refB(2) : t(2)), 'cycles=' + bt(4));
      break;
    case 0x23: // pulse-relay
      out.push(bt(0) === 1 ? 'Set-priority' : 'Reset-priority');
      break;
    case 0x2c: // freq-trigger
      out.push('On=' + uw(0), 'Off=' + uw(2), 'G_T=' + (ref(0x20) ? refB(4) : t(4)));
      break;
    case 0x2b: // up/down-counter
      out.push('On=' + (ref(0x20) ? refB(0) : dw(0)), 'Off=' + (ref(0x10) ? refB(4) : dw(4)), 'Start=' + dw(8));
      break;
    case 0x29: // hours-counter
      out.push('OT=' + dw(0));
      if (ref(0x20)) out.push('MI=' + refB(4));
      else if ((bt(7) & 0xc0) === 0) out.push('MI=' + (((bt(7) & 0x3f) << 24) | (bt(6) << 16) | (bt(5) << 8) | bt(4)) + 'h');
      else out.push('MI=' + decodeTime((bt(6) << 8) | bt(7)));
      if (bt(10) === 1) out.push('Q-indep-of-En');
      break;
    case 0x24: {
      // weekly timer: 3 cams (on/off time words, then day masks, then pulse)
      for (let c = 0; c < 3; c++) {
        const on = camTime(uw(c * 4));
        const off = camTime(uw(c * 4 + 2));
        if (on === null && off === null) continue;
        out.push('Cam' + (c + 1) + '=' + (on ?? '--:--') + '→' + (off ?? '--:--') + '[' + weekdays(bt(12 + c)) + ']');
      }
      if (bt(15) > 0) out.push('pulse');
      break;
    }
    case 0x2e: {
      // year clock: On/Off dates + mode
      const date = (o: number): string => 2000 + bt(o + 2) + '-' + String(bt(o + 1)).padStart(2, '0') + '-' + String(bt(o)).padStart(2, '0');
      out.push('On=' + date(0), 'Off=' + date(3));
      const m = bt(6);
      const f: string[] = [];
      if (m & 0x01) f.push('pulse');
      if (m & 0x40) f.push('yearly');
      if (m & 0x80) f.push('monthly');
      if (f.length) out.push(f.join(','));
      break;
    }
    case 0x34: // message-text
      out.push('prio=' + (bt(0) & 0x7f));
      if (bt(0) & 0x80) out.push('ack');
      out.push('msg#=' + bt(1), bt(3) & 0x80 ? 'RTF' : 'text');
      break;
    case 0x37: // softkey
      out.push(bt(0) & 0x01 ? 'switch' : 'momentary');
      if (bt(0) & 0x80) out.push('on@start');
      break;
    case 0x38: {
      // shift-register: output bit = index of the lowest set bit
      const mask = bt(0);
      let bit = 0;
      while (bit < 8 && !(mask & (1 << bit))) bit++;
      out.push('out=bit' + (mask ? bit + 1 : '?'));
      break;
    }
    case 0x3c: // math-detection
      if (bt(0) !== 0xff) out.push('ref=B' + String(bt(0) - 9).padStart(3, '0'));
      if (bt(1) !== 0) out.push('auto-reset');
      {
        const df: string[] = [];
        if (bt(4) & 0x01) df.push('overflow');
        if (bt(4) & 0x02) df.push('div0');
        if (df.length) out.push('detect=' + df.join('+'));
      }
      break;
    case 0x42: {
      // amplifier
      const dp = bt(4);
      out.push('Gain=' + gain(0), 'Offset=' + sw(2));
      if (dp) out.push('dp=' + dp);
      break;
    }
    case 0x35: // analog-threshold
    case 0x36: // analog-comparator
    case 0x39: {
      // analog-watchdog
      const dp = bt(8);
      const n1 = op === 0x39 ? 'D1' : 'On';
      const n2 = op === 0x39 ? 'D2' : 'Off';
      out.push(
        n1 + '=' + (ref(0x20) ? refB(0) : analog(sw(0), dp)),
        n2 + '=' + (ref(0x10) ? refB(2) : analog(sw(2), dp)),
        'Gain=' + gain(4),
        'Offset=' + sw(6),
      );
      if (dp) out.push('dp=' + dp);
      break;
    }
    case 0x3a: {
      // analog-delta-trigger: Off is stored as delta = off − on
      const dp = bt(8);
      const on = sw(0);
      out.push('On=' + analog(on, dp), 'Off=' + analog(on + sw(2), dp), 'Gain=' + gain(4), 'Offset=' + sw(6));
      if (dp) out.push('dp=' + dp);
      break;
    }
    case 0x40: {
      // analog-mux: 4 selectable values, no gain/offset
      const dp = bt(8);
      const flags = [0x20, 0x10, 0x08, 0x04];
      for (let i = 0; i < 4; i++) out.push('V' + (i + 1) + '=' + (ref(flags[i]) ? refB(i * 2) : analog(sw(i * 2), dp)));
      if (dp) out.push('dp=' + dp);
      break;
    }
    case 0x44: {
      // analog-maths: V1 op1 V2 op2 V3 op3 V4
      const dp = bt(12);
      const flags = [0x20, 0x10, 0x08, 0x04];
      const ops = '+-*/';
      const parts: string[] = [];
      for (let i = 0; i < 4; i++) {
        parts.push(ref(flags[i]) ? refB(i * 2) : analog(sw(i * 2), dp));
        if (i < 3) parts.push(ops[bt(8 + i)] ?? '?');
      }
      out.push('f=' + parts.join(' '));
      if (dp) out.push('dp=' + dp);
      break;
    }
    case 0x41: {
      // ramp-control
      const dp = bt(14);
      out.push(
        'L1=' + (ref(0x20) ? refB(0) : analog(sw(0), dp)),
        'L2=' + (ref(0x10) ? refB(2) : analog(sw(2), dp)),
        'MaxL=' + analog(sw(4), dp),
        'StSp=' + analog(sw(6), dp),
        'Rate=' + uw(8),
        'Gain=' + gain(10),
        'Offset=' + sw(12),
      );
      if (dp) out.push('dp=' + dp);
      break;
    }
    case 0x43: {
      // PID
      const dp = bt(17);
      out.push(
        'SP=' + (ref(0x20) ? refB(0) : analog(sw(0), dp)),
        'Mq=' + (ref(0x10) ? refB(2) : uw(2)),
        'KC=' + (sw(4) / 100).toFixed(2),
        'TI=' + t(6),
        'Gain=' + gain(12),
        'Offset=' + sw(14),
        'Dir=' + (bt(16) === 0x2d ? '-' : '+'),
      );
      if (dp) out.push('dp=' + dp);
      break;
    }
    case 0x3b: {
      // PWM
      const dp = bt(12);
      out.push('P=' + (ref(0x20) ? refB(0) : t(0)), 'Gain=' + gain(2), 'Offset=' + sw(4), 'min=' + analog(sw(6), dp), 'max=' + analog(sw(8), dp), 'sensor=' + bt(11));
      if (dp) out.push('dp=' + dp);
      break;
    }
    default:
      break; // GF gates, latching-relay: no parameters
  }
  return out;
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
    const pinNames = INPUT_NAMES[op];
    const inputs: string[] = [];
    for (let k = 0; k < nIn; k++) {
      const wo = base + 2 + k * 2;
      if (wo + 1 >= img.length) break;
      const sig = connector(w16(img, wo)) ?? '·';
      inputs.push(pinNames?.[k] ? pinNames[k] + '=' + sig : sig); // role label for SF pins; positional for gates
    }
    // Configured parameters (timer values, thresholds, counter limits, …) follow the inputs.
    const params = blockParams(op, img, base + 2 + nIn * 2, hi);
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
    'Decoded ' + present.length + ' blocks from the 0BA6 program. Gates, wiring, pin roles, and block ' +
      'parameters are decoded. `/X` marks an inverted input; `→Bxxx` a parameter wired from another ' +
      'block; [remanent]/[protected] are per-block flags.',
  );
  return out.join('\n');
}

/** Mermaid node shape for a block: hexagon for timers, rounded for latches/pulse, rectangle otherwise. */
function nodeShape(op: number, text: string): string {
  const q = '"' + text + '"';
  if (HEX_OPS.has(op)) return '{{' + q + '}}';
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
  // input pin — the same inversion mark LSC puts there. A normal input is a plain arrow. Special-
  // function pins carry their role name as an edge label (Trg/S/R/Cnt/…).
  const addEdge = (from: string, to: string, neg: boolean, label?: string): void => {
    const arrow = neg ? '--o' : '-->';
    edges.push('  ' + from + ' ' + arrow + (label ? '|' + label + '|' : '') + ' ' + to);
    if (/^A?I\d+$/.test(from)) inputTerms.add(from);
  };

  for (const { n, off } of present) {
    const base = prog + off;
    if (off < 0 || base + 2 > img.length) continue;
    const op = img[base];
    const hi = img[base + 1];
    const id = 'B' + String(n).padStart(3, '0');
    const spec = OPCODES[op];
    const type = spec ? spec[0] : 'op' + op.toString(16).padStart(2, '0');
    let text = id;
    if (names.has(n)) text += " '" + names.get(n) + "'";
    text += '<br/>' + (GATE_SYMBOL[op] ? GATE_SYMBOL[op] + ' ' : '') + type;
    const nIn = spec ? spec[2] : 0;
    const params = blockParams(op, img, base + 2 + nIn * 2, hi);
    if (params.length) text += '<br/>' + params.join(' ');
    nodeLines.push('  ' + id + nodeShape(op, text));
    const pinNames = INPUT_NAMES[op];
    for (let k = 0; k < nIn; k++) {
      const wo = base + 2 + k * 2;
      if (wo + 1 >= img.length) break;
      const p = connectorParts(w16(img, wo));
      if (p) addEdge(p.sig, id, p.neg, pinNames?.[k]);
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
