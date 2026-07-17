// Byte / hex formatting helpers shared across protocol, decode, and UI layers.

/** Space-separated lowercase hex, e.g. `06 03 40`. */
export function hex(b: Uint8Array | readonly number[]): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

/** 4-nibble `0xNNNN` (USB VID/PID). */
export function id4(v: number): string {
  return '0x' + v.toString(16).padStart(4, '0');
}

/** 8-nibble `0xNNNNNNNN` (a 32-bit LOGO! address). */
export function addr8(a: number): string {
  return '0x' + a.toString(16).padStart(8, '0');
}

/** Little-endian 16-bit word at offset `i`. */
export function w16(b: Uint8Array, i: number): number {
  return b[i] | (b[i + 1] << 8);
}

/** Hex of `n` bytes of `b` starting at `a`. */
export function hexb(b: Uint8Array, a: number, n: number): string {
  return [...b.slice(a, a + n)].map((x) => x.toString(16).padStart(2, '0')).join(' ');
}

/** Printable-ASCII rendering; non-printable bytes become `·`. */
export function ascii(b: Uint8Array | readonly number[]): string {
  return [...b].map((c) => (c >= 32 && c < 127 ? String.fromCharCode(c) : '·')).join('');
}
