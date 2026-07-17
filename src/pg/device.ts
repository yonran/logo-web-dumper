// Device (addressing) profile. The only real differences between 0BA5 and 0BA6 on this protocol
// are the on-the-wire address WIDTH and the 0xFF paging of high addresses. We keep the ADDR
// constants in their 0BA6-canonical form (high = 0x00FF____, low = 0x0000____); a 0BA5 device
// simply sends the LOW 16 bits as a 2-byte address — which is exactly `addr & 0xFFFF`, since the
// 0BA6 page only ever occupies the top 16 bits. So one field, `addrWidth`, captures the whole
// difference. (Verified against LSC: Logo6.getAdress pages ≥0x1F00; DataTransfer.isAddress32
// switches the wire width.)

import { IDENT_NAMES } from './constants.js';

/** One contiguous span of the uploaded program image, in read order. */
export interface ProgramRegion {
  /** Wire address (pre-paging); a 2-byte device masks it to the low 16 bits. */
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
  decode: 'legacy2460',
};

// 0BA6 (LSC Logo6.getMemories): the program image sits high, ≥0x1F00, so it is paged to 0x00FF____.
// ProgOffsetTabelle 0x2FAA, Anchors 0x31CA, Program 0x3292; getNumberOfUploadTransferBytes = 13464.
// One contiguous read from the offset table captures the whole image (offset table + wiring + program).
const MAP_0BA6: ProgramMap = {
  regions: [{ base: 0x00ff2faa, len: 13464, name: 'program image (offset table + wiring + program)' }],
  programBase: 0x00ff3292,
  decode: 'raw',
};

export interface DeviceProfile {
  readonly identNo: number;
  readonly name: string;
  /** Address bytes on the wire: 4 for 0BA6, 2 for 0BA5. */
  readonly addrWidth: 2 | 4;
  /** Program memory map for this device family. */
  readonly mem: ProgramMap;
}

/** 0BA5: 2-byte addressing, no 0xFF page, legacy (0BA4-inherited) program map. */
export const BA5: DeviceProfile = { identNo: 0x42, name: '0BA5', addrWidth: 2, mem: MAP_LEGACY };

/** 0BA6 family (0BA6 / ES3 / ES10): 4-byte addressing, high paged program map. */
export function ba6(ident: number): DeviceProfile {
  return { identNo: ident, name: IDENT_NAMES[ident] ?? '0x' + ident.toString(16), addrWidth: 4, mem: MAP_0BA6 };
}

/** A 0BA5-style device detected only via the 0x1F02 probe (unknown IdentNo → 2-byte, legacy map). */
export function ba5Like(ident: number): DeviceProfile {
  return { identNo: ident, name: IDENT_NAMES[ident] ?? '0x' + ident.toString(16), addrWidth: 2, mem: MAP_LEGACY };
}

/** Resolve an IdentNo to a profile (null = unknown / unsupported). */
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
