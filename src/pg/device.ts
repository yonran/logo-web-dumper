// Device profile: what differs between the LOGO! families this tool speaks to. Two things vary:
//   1. the on-the-wire address WIDTH (2 bytes on 0BA5, 4 on 0BA6) — `addrWidth`;
//   2. WHERE the program lives — the 0BA4/0BA5 map is low and bare, the 0BA6 map is high and paged
//      (0x00FF____). This is NOT captured by addrWidth alone, so it lives in `mem` (ProgramMap).
// The shared registers (password/name/protection) are the same across families via getAdress and
// stay in constants.ts. Verified against LSC: Logo4.getMemories (0BA4/0BA5) vs Logo6.getMemories
// (0BA6, inherited by ES3/ES10); getAdress pages addresses ≥0x1F00.

import { IDENT_NAMES } from './constants.js';

/** One contiguous span of the uploaded program image, in read order. */
export interface ProgramRegion {
  /**
   * Wire address in this device's final form: the 0BA6 map stores it already paged (0x00FF____),
   * the low legacy map stores it bare — a 2-byte device just masks to the low 16 bits at encode time.
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

// 0BA6 (LSC Logo6.getMemories): ProgOffsetTabelle 0x2FAA, Anchors 0x31CA, Program 0x3292;
// getNumberOfUploadTransferBytes = 13464. These are read as BARE 4-byte addresses (0x0000____),
// NOT paged: the ≥0x1F00 → OR 0xFF0000 rule lives in getAdress, which the symbolic register reads
// (flag/magic/protection) use — but the program/offset-table/wiring are Memory objects read via
// Memory.upload → readByteArray(rawBase), which never calls getAdress. So the wire address is the
// raw base. One contiguous read from the offset table captures the whole image.
const MAP_0BA6: ProgramMap = {
  regions: [{ base: 0x00002faa, len: 13464, name: 'program image (offset table + wiring + program)' }],
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

/** 0BA6 family (0BA6 / ES3 / ES10): 4-byte addressing, high paged program map. */
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
