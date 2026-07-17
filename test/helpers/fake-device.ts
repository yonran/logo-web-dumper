// A scripted LOGO! PG-protocol device implementing the Transport interface. It parses the command
// bytes the Connection writes and answers with the exact bytes a real device would, so the whole
// protocol/action stack runs with no hardware. Supports both 0BA6 (4-byte addressing, 0x21
// connect, 0xFF page on ≥0x1F00) and 0BA5 (2-byte addressing, no 0x21 answer, no page), selected
// by identNo. Behaviour is configurable (password present, whether the firmware leaks the
// cleartext, whether Read Block works) to cover leaking-0BA5 and holding-ES10 cases.

import type { Transport } from '../../src/transport/types.js';

// 16-bit base addresses — the ground truth, defined HERE independently of the tool's constants so
// the fake catches a wrong address. The wire address per device follows LSC's rule (see wire()).
const BASE = {
  PWD_MEM: 0x0566,
  PROGRAM_LEGACY: 0x0ee8, // 0BA4/0BA5 program body (bare, < 0x1F00)
  PROGRAM_0BA6: 0x3292, // 0BA6 program body (LSC Logo6 map; BARE wire 0x00003292 — Memory reads aren't paged)
  PWD_EXISTS: 0x48ff,
  PWD_MAGIC1: 0x1f00,
  PWD_MAGIC2: 0x1f01,
  IDENT: 0x1f02,
  FW_START: 0x1f03,
  CLEAR: 0x4800, // ADR_CLEAR_PASSWORD_ACTIVE
  SET: 0x4801, // ADR_SET_PASSWORD_ACTIVE
} as const;

export interface FakeDeviceConfig {
  identNo?: number; // connect reply; default 0x45 (0BA6.ES10). 0x42 → 0BA5 (2-byte addressing).
  mode?: number; // 0x42 STOP / 0x01 RUN; default STOP
  passwordExists?: boolean; // 0x48FF === 0x40; default false
  // Two INDEPENDENT firmware behaviours (the ES10 has neither; a fully-leaking device has both):
  leaksCleartext?: boolean; // is the password store at 0x0566 readable? default false (ES10 hides it)
  clearWriteUnlocks?: boolean; // does writing 0x4800=0 then expose program memory? default false
  blockReadsWork?: boolean; // does Read Block 0x05 succeed? default false (ES10 rejects)
  password?: string; // stored cleartext (≤10 chars)
  encryptPassword?: boolean; // store the password XOR-obfuscated like newer 0BA6 (ES10) firmware
  program?: Uint8Array; // bytes at the program base
  flakyReads?: number; // drop the response to the first N Read Byte commands (transient glitch)
}

// LSC SymmetricalSimpleEncoding key — ground truth, defined independently of the tool's decoder.
const SIMPLE_KEY = 'protect customer';

const FW = 'V10707'; // 1F03..1F08 → decodes to firmware "V1.07.07"

export class FakeDevice implements Transport {
  readonly kind = 'FakeDevice';
  /** Every command frame written to the device, in order (for request assertions). */
  readonly writes: Uint8Array[] = [];

  private incoming: number[] = [];
  private mode: number;
  private latched = false; // after an exception, everything NOKs until Restart
  private protectionLowered = false;
  private flakyLeft: number;
  private readonly addrWidth: 2 | 4;
  private readonly cfg: Required<
    Pick<FakeDeviceConfig, 'identNo' | 'passwordExists' | 'leaksCleartext' | 'clearWriteUnlocks' | 'blockReadsWork'>
  > &
    FakeDeviceConfig;
  private readonly pwdMem = new Map<number, number>(); // password store — leaks without any write
  private readonly progMem = new Map<number, number>(); // program etc. — needs the clear write
  private readonly sys = new Map<number, number>();

  constructor(config: FakeDeviceConfig = {}) {
    this.cfg = {
      identNo: config.identNo ?? 0x45,
      passwordExists: config.passwordExists ?? false,
      leaksCleartext: config.leaksCleartext ?? false,
      clearWriteUnlocks: config.clearWriteUnlocks ?? false,
      blockReadsWork: config.blockReadsWork ?? false,
      ...config,
    };
    this.addrWidth = this.cfg.identNo === 0x42 ? 2 : 4;
    this.mode = config.mode ?? 0x42;
    this.flakyLeft = config.flakyReads ?? 0;

    // System registers — always readable, keyed by the wire address for this device.
    this.sys.set(this.wire(BASE.PWD_MAGIC1), 0x04);
    this.sys.set(this.wire(BASE.PWD_MAGIC2), 0x00);
    this.sys.set(this.wire(BASE.IDENT), this.cfg.identNo);
    for (let i = 0; i < FW.length; i++) this.sys.set(this.wire(BASE.FW_START + i), FW.charCodeAt(i));
    this.sys.set(this.wire(BASE.PWD_EXISTS), this.cfg.passwordExists ? 0x40 : 0x00);

    // Password store: on a leaking device it is exposed as soon as it's queried (no write needed).
    const pw = config.password ?? 'secret';
    for (let i = 0; i < 10; i++) {
      let b = i < pw.length ? pw.charCodeAt(i) : 0x00;
      // Newer 0BA6 firmware stores it obfuscated: enc = (~plain) ^ key[i]. Padding stays 0x00.
      if (config.encryptPassword && i < pw.length) b = (pw.charCodeAt(i) ^ 0xff ^ SIMPLE_KEY.charCodeAt(i)) & 0xff;
      this.pwdMem.set(this.wire(BASE.PWD_MEM + i), b);
    }
    // Program memory: protected until the clear write drops protection (on a leaking device).
    // The body lives at the device family's program base — 0x3292 on 0BA6, 0x0EE8 on 0BA4/0BA5 —
    // read via progWire (BARE, no 0xFF page: Memory.upload does not go through getAdress).
    const progBase = this.addrWidth === 4 ? BASE.PROGRAM_0BA6 : BASE.PROGRAM_LEGACY;
    const prog = config.program ?? new Uint8Array(0);
    for (let i = 0; i < prog.length; i++) this.progMem.set(this.progWire(progBase + i), prog[i]);
  }

  /** Wire address for a SYMBOLIC register: bare 16-bit on 0BA5; on 0BA6 the ≥0x1F00 page (getAdress). */
  private wire(base: number): number {
    if (this.addrWidth === 2) return base & 0xffff;
    return base >= 0x1f00 ? (base | 0xff0000) >>> 0 : base;
  }

  /** Wire address for a MEMORY block (program/offset table): raw base, NEVER paged (readByteArray). */
  private progWire(base: number): number {
    return this.addrWidth === 2 ? base & 0xffff : base >>> 0;
  }

  // Whether the password STORE (0x0566) hands back bytes — independent of the program.
  private pwdReadable(): boolean {
    return !this.cfg.passwordExists || this.cfg.leaksCleartext;
  }
  // Whether the PROGRAM area reads back real data. Protected until a 0x4800 clear write AND the
  // firmware actually honours it (clearWriteUnlocks). Deliberately NOT tied to leaksCleartext, so a
  // test can model "password hidden, but the clear write still opens the program" — the outcome we
  // hoped for on the ES10 — separately from whether the password itself leaked.
  private progReadable(): boolean {
    return !this.cfg.passwordExists || (this.protectionLowered && this.cfg.clearWriteUnlocks);
  }

  private push(...bytes: number[]): void {
    this.incoming.push(...bytes);
  }

  write(bytes: Uint8Array): Promise<void> {
    this.writes.push(bytes.slice());
    this.handle(bytes);
    return Promise.resolve();
  }

  read(n: number): Promise<Uint8Array> {
    const out = Uint8Array.from(this.incoming.slice(0, n));
    this.incoming = this.incoming.slice(out.length);
    return Promise.resolve(out);
  }

  close(): Promise<void> {
    return Promise.resolve();
  }

  /** Parse the wire address from a command (addrWidth bytes starting at cmd[1]). */
  private addr(cmd: Uint8Array): number {
    let a = 0;
    for (let i = 0; i < this.addrWidth; i++) a = (a << 8) | cmd[1 + i];
    return a >>> 0;
  }

  private handle(cmd: Uint8Array): void {
    const op = cmd[0];
    const w = this.addrWidth;
    if (op === 0x21) {
      // Connect request. 0BA6 answers 06 03 21 <ident>; 0BA5 does NOT answer (probed via 0x1F02).
      if (w === 4) this.push(0x06, 0x03, 0x21, this.cfg.identNo);
      return;
    }
    if (op === 0x22) {
      this.latched = false;
      this.push(0x06);
      return;
    }
    if (op === 0x55) {
      if (cmd[1] === 0x17) {
        this.push(0x06, this.mode);
      } else if (cmd[1] === 0x12) {
        // STOP to an already-stopped device gets NO response (observed on 0BA6.ES10).
        if (this.mode !== 0x42) {
          this.mode = 0x42;
          this.push(0x06);
        }
      } else if (cmd[1] === 0x18) {
        this.mode = 0x01;
        this.push(0x06);
      } else {
        this.push(0x06);
      }
      return;
    }
    if (this.latched) {
      this.push(0x15, 0x03);
      return;
    }
    if (op === 0x02) {
      // Simulate a transient line glitch: drop the response entirely so the tool times out & retries.
      if (this.flakyLeft > 0) {
        this.flakyLeft--;
        return;
      }
      // Read Byte → ACK, 0x03, echoed address (width bytes), value. Never faults.
      const value = this.readMem(this.addr(cmd));
      const echo = [...cmd.slice(1, 1 + w)];
      this.push(0x06, 0x03, ...echo, value);
      return;
    }
    if (op === 0x01) {
      // Write Byte → ACK. Only 0x4800 clears / 0x4801 re-locks; other registers do nothing.
      const a = this.addr(cmd);
      if (a === this.wire(BASE.CLEAR)) this.protectionLowered = true;
      else if (a === this.wire(BASE.SET)) this.protectionLowered = false;
      this.push(0x06);
      return;
    }
    if (op === 0x05) {
      // Read Block: on the ES10 rejected with 06 (pre-parse ACK) then 15 03, latching the session.
      if (!this.cfg.blockReadsWork) {
        this.latched = true;
        this.push(0x06, 0x15, 0x03);
        return;
      }
      const a = this.addr(cmd);
      const count = (cmd[1 + w] << 8) | cmd[2 + w];
      const data: number[] = [];
      for (let i = 0; i < count; i++) data.push(this.readMem((a + i) >>> 0));
      let xor = 0;
      for (const d of data) xor ^= d;
      this.push(0x06, ...data, xor);
      return;
    }
    this.latched = true;
    this.push(0x15, 0x05);
  }

  private readMem(a: number): number {
    if (this.sys.has(a)) return this.sys.get(a)!;
    if (this.pwdMem.has(a)) return this.pwdReadable() ? this.pwdMem.get(a)! : 0x00;
    if (this.progMem.has(a)) return this.progReadable() ? this.progMem.get(a)! : 0x00;
    return 0x00; // unmapped/protected reads return 0x00 without faulting
  }
}
