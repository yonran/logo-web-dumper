// Device (addressing) profile. The only real differences between 0BA5 and 0BA6 on this protocol
// are the on-the-wire address WIDTH and the 0xFF paging of high addresses. We keep the ADDR
// constants in their 0BA6-canonical form (high = 0x00FF____, low = 0x0000____); a 0BA5 device
// simply sends the LOW 16 bits as a 2-byte address — which is exactly `addr & 0xFFFF`, since the
// 0BA6 page only ever occupies the top 16 bits. So one field, `addrWidth`, captures the whole
// difference. (Verified against LSC: Logo6.getAdress pages ≥0x1F00; DataTransfer.isAddress32
// switches the wire width.)

import { IDENT_NAMES } from './constants.js';

export interface DeviceProfile {
  readonly identNo: number;
  readonly name: string;
  /** Address bytes on the wire: 4 for 0BA6, 2 for 0BA5. */
  readonly addrWidth: 2 | 4;
}

/** 0BA5: 2-byte addressing, no 0xFF page. */
export const BA5: DeviceProfile = { identNo: 0x42, name: '0BA5', addrWidth: 2 };

/** 0BA6 family (0BA6 / ES3 / ES10): 4-byte addressing. */
export function ba6(ident: number): DeviceProfile {
  return { identNo: ident, name: IDENT_NAMES[ident] ?? '0x' + ident.toString(16), addrWidth: 4 };
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
