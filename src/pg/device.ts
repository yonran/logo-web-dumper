// Device profile: what differs between the LOGO! families this tool speaks to. Two things vary:
//   1. the on-the-wire address WIDTH (2 bytes on 0BA5, 4 on 0BA6) — `addrWidth`;
//   2. WHERE the program lives — both maps are bare Memory bases, but the 0BA6 bases are higher.
// The shared registers (password/name/protection) are the same across families via getAdress and
// stay in constants.ts. Verified against LSC: Logo4.getMemories (0BA4/0BA5) vs Logo6.getMemories
// (0BA6, inherited by ES3/ES10); getAdress pages addresses ≥0x1F00.

import { IDENT_NAMES } from './constants.js';

/** One independently transferred Memory object in the uploaded image. */
export interface ProgramRegion {
  /**
   * Raw Memory base. It never passes through the symbolic-register getAdress paging rule.
   */
  readonly base: number;
  readonly len: number;
  readonly name: string;
}

/**
 * Where the program lives — this is the ONE thing that genuinely differs between the 0BA4/0BA5
 * and the 0BA6 memory maps (the password/name/protection registers are shared via getAdress).
 * Verified by decompiling LSC: `Logo4.getMemories` (0BA4, inherited by 0BA5) vs `Logo6.getMemories`
 * (0BA6, inherited by ES3/ES10 = Logo6Update1/2, which do NOT override it).
 */
export interface ProgramMap {
  /** Region(s) that make up the uploaded image, read in order and concatenated. */
  readonly regions: readonly ProgramRegion[];
  /** Wire address of the program BODY — used for the post-unlock probe and the raw-dump default. */
  readonly programBase: number;
  /**
   * Which command reads the image. The 0BA6 program region is BLOCK-read-only: Read Byte returns
   * 0x00 there, only Read Block (0x05) returns the real bytes (confirmed on ES10 hardware). The
   * legacy 0BA4/0BA5 layout is read byte-wise.
   */
  readonly readMode: 'byte' | 'block';
  /** How to turn the concatenated image into a netlist. */
  readonly decode: 'legacy2460' | 'raw';
}

// 0BA4 / 0BA5 (LSC Logo4.getMemories): low, bare addresses; the legacy 2460-byte combined layout.
const MAP_LEGACY: ProgramMap = {
  regions: [
    { base: 0x00000c14, len: 260, name: 'pointer table' },
    { base: 0x00000e20, len: 200, name: 'output wiring' },
    { base: 0x00000ee8, len: 2000, name: 'program' },
  ],
  programBase: 0x00000ee8,
  readMode: 'byte',
  decode: 'legacy2460',
};

// Exact LSC V8 Logo6 upload map. getMemories() has 11 top-level Memory objects; MessageMemoryRTF
// expands into seven wire reads, for 17 exact ranges in declaration order. getMaxResource is a
// static maxValues lookup: blocks=200 (index 0), program units=3800 (14), block names=100 (15).
// Memory.upload reads size×blockSize bytes. The address gaps are never transferred.
//
// These are BARE 4-byte addresses (0x0000____), NOT paged: the ≥0x1F00 → OR 0xFF0000 rule lives in
// getAdress() (constants.ts), used only for symbolic register reads. Memory reads
// (Memory.upload → readByteArray(rawBase)) never call getAdress, so 0x3292 stays bare even though
// it is ≥ 0x1F00. The ranges transfer 12797 bytes and occupy the address span 0x0688..0x416A.
const MAP_0BA6: ProgramMap = {
  regions: [
    { base: 0x00000688, len: 100, name: 'block-name table' }, // Memory(maxValues[15], 1)
    { base: 0x00000708, len: 800, name: 'block names' }, // Memory(maxValues[15], 8)
    // MessageMemoryRTF sub-memories (unused address capacity between them is deliberately skipped).
    { base: 0x00000aa8, len: 6, name: 'message character sets' },
    { base: 0x00000aae, len: 100, name: 'message offset table' },
    { base: 0x00000b2e, len: 6400, name: 'message text' }, // MessageMemory8(200, 32)
    { base: 0x00002b36, len: 50, name: 'message info' },
    { base: 0x00002b76, len: 25, name: 'message ticker flags' },
    { base: 0x00002c16, len: 256, name: 'message bar graphs' }, // Memory(32, 8)
    { base: 0x00002d2a, len: 640, name: 'message I/O names' }, // Memory(40, 16)
    { base: 0x00002faa, len: 420, name: 'offset table' }, // Memory16 210×2
    { base: 0x000031ca, len: 40, name: 'anchors Q' }, // AnchorMemory16 2×20
    { base: 0x000031f2, len: 60, name: 'markers M' }, // 3×20
    { base: 0x0000322e, len: 20, name: 'analog anchors' }, // 1×20
    { base: 0x00003242, len: 40, name: 'virtual anchors' }, // 2×20
    { base: 0x0000326a, len: 20, name: 'reserved' }, // 1×20
    { base: 0x0000327e, len: 20, name: 'special markers' }, // 1×20
    { base: 0x00003292, len: 3800, name: 'program body' }, // ProgramMemory16 3800×1
  ],
  programBase: 0x00003292,
  readMode: 'block', // the program region only answers Read Block (0x05), not Read Byte — verified on ES10
  decode: 'raw',
};

export interface DeviceProfile {
  readonly identNo: number;
  readonly name: string;
  /** Address bytes on the wire: 4 for 0BA6, 2 for 0BA5. */
  readonly addrWidth: 2 | 4;
  /** Program memory map for this device family. */
  readonly mem: ProgramMap;
  /**
   * True only for the models this tool has an actually-verified map for (0BA5, 0BA6/ES3/ES10).
   * A device that connects with an unrecognised IdentNo gets a best-guess map with known=false;
   * memory-map-dependent operations (program read) refuse rather than read guessed addresses.
   */
  readonly known: boolean;
}

/** 0BA5: 2-byte addressing, no 0xFF page, legacy (0BA4-inherited) program map. */
export const BA5: DeviceProfile = { identNo: 0x42, name: '0BA5', addrWidth: 2, mem: MAP_LEGACY, known: true };

/** 0BA6 family (0BA6 / ES3 / ES10): 4-byte addressing, high but bare program map. */
export function ba6(ident: number): DeviceProfile {
  return { identNo: ident, name: IDENT_NAMES[ident] ?? '0x' + ident.toString(16), addrWidth: 4, mem: MAP_0BA6, known: true };
}

/** Unrecognised 4-byte responder: assume 0BA6-style so diagnostics work, but flag it unverified. */
export function unknown4(ident: number): DeviceProfile {
  return { identNo: ident, name: 'unknown 0x' + ident.toString(16) + ' (4-byte)', addrWidth: 4, mem: MAP_0BA6, known: false };
}

/** Unrecognised device answering only the 2-byte 0x1F02 probe: assume legacy map, flagged unverified. */
export function ba5Like(ident: number): DeviceProfile {
  return { identNo: ident, name: 'unknown 0x' + ident.toString(16) + ' (2-byte)', addrWidth: 2, mem: MAP_LEGACY, known: false };
}

/** Resolve an IdentNo to a KNOWN profile (null = unrecognised / unsupported). */
export function profileForIdent(ident: number): DeviceProfile | null {
  if (ident === 0x42) return BA5;
  if (ident >= 0x43 && ident <= 0x45) return ba6(ident);
  return null;
}

/** The wire address for a device: full 32-bit on 0BA6, low 16 bits on 0BA5. */
export function wireAddr(dev: DeviceProfile, addr: number): number {
  return dev.addrWidth === 2 ? addr & 0xffff : addr >>> 0;
}

/** Encode a wire address as its address bytes (big-endian, `addrWidth` long). */
export function addrBytes(dev: DeviceProfile, addr: number): number[] {
  const a = wireAddr(dev, addr);
  return dev.addrWidth === 4
    ? [(a >>> 24) & 0xff, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff]
    : [(a >>> 8) & 0xff, a & 0xff];
}
