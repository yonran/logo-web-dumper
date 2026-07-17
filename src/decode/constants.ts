// 0BA5/0BA6 block-format tables. Source: brickpool/logo 0BA5-Dekodierung wiki. See PROTOCOL.md
// §5 for the full format documentation.

/** Basic functions (GF): opcode → [name, record length]. */
export const GF: Record<number, readonly [string, number]> = {
  0x01: ['AND', 12],
  0x02: ['OR', 12],
  0x03: ['NOT', 4],
  0x04: ['NAND', 12],
  0x05: ['NOR', 12],
  0x06: ['XOR', 8],
  0x07: ['AND-edge', 12],
  0x08: ['NAND-edge', 12],
};

/** Special functions (SF): opcode → [name, record length]. */
export const SF: Record<number, readonly [string, number]> = {
  0x21: ['on-delay', 8],
  0x22: ['off-delay', 12],
  0x23: ['pulse-relay', 12],
  0x24: ['weekly-timer', 20],
  0x25: ['latching-relay', 8],
  0x27: ['ret-on-delay', 12],
  0x2b: ['up/down-counter', 24],
  0x2d: ['async-pulse-gen', 12],
  0x2f: ['on/off-delay', 12],
  0x31: ['stairwell-switch', 12],
  0x34: ['message-text', 8],
  0x35: ['analog-threshold', 16],
  0x39: ['analog-watch', 20],
};

/** Output/marker wiring groups: [label, base address, count]. */
export const WIRING_GROUPS: readonly (readonly [string, number, number])[] = [
  ['Q', 0x0e20, 16],
  ['M', 0x0e48, 24],
  ['AQ', 0x0e84, 2],
  ['X', 0x0e98, 16],
];
