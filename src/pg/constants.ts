// PG-protocol constants for the LOGO! 0BA6. Every value is documented in PROTOCOL.md with
// its reverse-engineering source (primarily brickpool/logo's LogoPG.cpp + PG-Protocol wiki).

/** Command / response opcodes. */
export const OP = {
  WRITE_BYTE: 0x01,
  READ_BYTE: 0x02,
  READ_BLOCK: 0x05,
  CONNECT: 0x21,
  RESTART: 0x22,
  ACK: 0x06,
  NOK: 0x15,
} as const;

/** 32-bit addresses under the 0BA6 `0x00FF____` page. */
export const ADDR = {
  PWD_MAGIC1: 0x00ff1f00, // must read 0x04
  PWD_MAGIC2: 0x00ff1f01, // must read 0x00
  IDENT: 0x00ff1f02, // ident byte (proven readable on 0BA6.ES10)
  FW_START: 0x00ff1f03, // firmware string "V.." runs 1F03..1F08
  FW_END: 0x00ff1f08,
  PWD_EXISTS: 0x00ff48ff, // 0x40 = password set, 0x00 = none
  PWD_MEM: 0x00ff0566, // 10-byte password store (cleartext on 0BA5)
  PL_LEVEL1: 0x00ff4740, // write 0 → protection level 1 (no protection)
  PL_LEVEL2: 0x00ff4800, // write 0 → protection level 2 (read protection)
  PL_LEVEL3: 0x00ff4100, // write 0 → protection level 3 (read/write protection)
  PROG_NAME: 0x00ff0570, // 16-byte ASCII program name
  PTR_TABLE: 0x00ff0c14, // 260-byte pointer table
  OUT_WIRING: 0x00ff0e20, // 200-byte output/marker wiring
  PROGRAM: 0x00ff0ee8, // 2000-byte program memory
} as const;

export const PWD_EXISTS_YES = 0x40;

/** CPU exception codes carried in a NOK (0x15) response. Source: LogoPG.cpp CpuError(). */
export const CPU_ERR: Record<number, string> = {
  0x01: 'Device busy — LOGO! cannot accept a telegram right now',
  0x02: 'Device timeout — resource unavailable (2nd cycle timed out)',
  0x03: 'ILLEGAL ACCESS — read across the border (bad address or length)',
  0x04: 'Parity/overflow/telegram error',
  0x05: 'Unknown command — this mode is not supported',
  0x06: 'XOR check incorrect',
  0x07: 'Simulation error — not supported in this mode',
};

/** Operating modes reported by the `55 17 17 AA` query. */
export const MODES: Record<number, string> = {
  0x01: 'RUN',
  0x20: 'RUN_P (parameter mode)',
  0x42: 'STOP',
};
export const MODE_STOP = 0x42;

/** IdentNo → device name (from the `0x21` connect reply). */
export const IDENT_NAMES: Record<number, string> = {
  0x40: '0BA4',
  0x42: '0BA5',
  0x43: '0BA6',
  0x44: '0BA6.ES3',
  0x45: '0BA6.ES10',
};

export function cpuErrText(code: number): string {
  return CPU_ERR[code] ?? 'unrecognised code';
}
