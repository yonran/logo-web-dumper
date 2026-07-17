// The transport abstraction: a byte pipe to the cable. Both Web Serial and WebUSB implement
// it, so every layer above (PG protocol, actions) is transport-agnostic.

import { id4 } from '../util/hex.js';

export interface Transport {
  readonly kind: string;
  write(bytes: Uint8Array): Promise<void>;
  /** Read up to `n` bytes, waiting at most `timeoutMs`. Returns whatever arrived (maybe fewer). */
  read(n: number, timeoutMs?: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

export type TransportMode = 'auto' | 'serial' | 'usb';

// Known USB-serial bridge vendor IDs — for a friendly hint only, NEVER a hiding filter.
// Genuine and clone LOGO! cables use various bridges (FTDI / CP210x / CH340 / Prolific);
// there is no single authoritative LOGO! cable VID, so we identify, we don't filter.
export const CHIPS: Record<number, string> = {
  0x0403: 'FTDI',
  0x10c4: 'Silicon Labs CP210x',
  0x1a86: 'WCH CH340/CH341',
  0x067b: 'Prolific PL2303',
};

export function chipHint(vid: number | null | undefined): string {
  if (vid == null) return '';
  const name = CHIPS[vid];
  return name
    ? `  (chip: ${name} — a common USB-serial bridge, consistent with a LOGO! cable)`
    : `  (USB vendor ${id4(vid)} — not a chip I recognise; trying anyway)`;
}

export function usbName(d: USBDevice): string {
  const t = [id4(d.vendorId) + ':' + id4(d.productId)];
  const label = [d.manufacturerName, d.productName].filter(Boolean).join(' ');
  if (label) t.push(`“${label}”`);
  if (d.serialNumber) t.push('sn=' + d.serialNumber);
  return t.join(' ');
}
