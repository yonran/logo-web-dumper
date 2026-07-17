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
  PWD_EXISTS: 0x00ff48ff, // 0x40 = password set (LSC ADR_PASSWORD_FLAG; ≥0x1F00 → 0x00FF page)
  // Program-region addresses are BARE (no 0x00FF page). Verified from LSC Logo6.getAdress: it
  // only ORs 0xFF0000 onto addresses ≥ 0x1F00; anything below stays a bare 16-bit value, sent as
  // a 4-byte address 0x0000____. Our old 0x00FF0566 / 0x00FF0EE8 were wrong (they read zeros
  // while the ≥0x1F00 system registers worked), which is why every program/password read failed.
  PWD_MEM: 0x00000566, // 10-byte password store
  // Protection registers, VERIFIED by decompiling LOGO!Soft Comfort V8.0
  // (DE.siemens.ad.logo.model.hardware.Modular0.getAdress + clearPasswordOnLogo/set method).
  // LSC clears protection by writing 0 to 0x4800 and re-sets it by writing 0 to 0x4801.
  PL_CLEAR: 0x00ff4800, // ADR_CLEAR_PASSWORD_ACTIVE — write 0 to UNLOCK (what LSC actually does)
  PL_SET: 0x00ff4801, // ADR_SET_PASSWORD_ACTIVE — write 0 to RE-LOCK
  // Legacy addresses from brickpool's LogoPG.cpp (its protection-level labels are wrong: it
  // calls 0x4800 "level 2 read protection", but LSC uses it to CLEAR protection). Kept for
  // reference; 0x4740 is what this tool used to write and it never took on the 0BA6.ES10.
  PL_LEVEL1: 0x00ff4740, // brickpool "level 1 (no protection)" — NOT what LSC writes
  PL_LEVEL3: 0x00ff4100, // brickpool "level 3 (read/write protection)"
  PROG_NAME: 0x00000570, // 16-byte ASCII program name (bare, < 0x1F00)
  PTR_TABLE: 0x00000c14, // 260-byte pointer table (bare)
  OUT_WIRING: 0x00000e20, // 200-byte output/marker wiring (bare)
  PROGRAM: 0x00000ee8, // 2000-byte program memory (bare)
} as const;

export const PWD_EXISTS_YES = 0x40;

// LSC's isPWProtected treats ANY nonzero byte at 0x48FF as "password set" (`readByte(0x48FF) > 0`),
// not exactly 0x40 — so a device reporting a different nonzero flag isn't misread as unprotected.
export function isPasswordSet(flag: number): boolean {
  return flag !== 0;
}

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

// The mode byte is a bitfield (LSC's TS_* flags), not an enum. STOP is bit 0x02; the observed
// 0x42 is TS_REMOTE|TS_STOP. Test the bit, not equality, so STOP with other status bits set
// (error 0x08, first-cycle 0x80, non-remote) isn't misread as "not in STOP".
export const TS_RUN = 0x01;
export const TS_STOP = 0x02;
export function isStopMode(m: number): boolean {
  return (m & TS_STOP) !== 0;
}

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
