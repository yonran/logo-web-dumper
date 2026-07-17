// A scripted LOGO! 0BA6 PG-protocol device implementing the Transport interface. It parses the
// command bytes the Connection writes and answers with the exact bytes a real device would, so
// the whole protocol/action stack can be exercised with no hardware. Behaviour is configurable
// (identNo, mode, whether a password exists, whether lowering protection actually leaks the
// cleartext, whether Read Block works) to cover both the leaking-0BA5 and the holding-ES10 cases.

import type { Transport } from '../../src/transport/types.js';
import { ADDR } from '../../src/pg/constants.js';

export interface FakeDeviceConfig {
  identNo?: number; // connect reply; default 0x45 (0BA6.ES10)
  mode?: number; // 0x42 STOP / 0x01 RUN; default STOP
  passwordExists?: boolean; // 0x48FF === 0x40; default false
  leaksCleartext?: boolean; // does level-1 reveal 0566/program? default false (ES10 holds)
  blockReadsWork?: boolean; // does Read Block 0x05 succeed? default false (ES10 rejects)
  password?: string; // stored cleartext (≤10 chars)
  program?: Uint8Array; // bytes at 0x00FF0EE8
}

const FW = 'V10707'; // 1F03..1F08 → decodes to firmware "V1.07.07"

export class FakeDevice implements Transport {
  readonly kind = 'FakeDevice';
  /** Every command frame written to the device, in order (for request assertions). */
  readonly writes: Uint8Array[] = [];

  private incoming: number[] = [];
  private mode: number;
  private latched = false; // after an exception, everything NOKs until Restart
  private protectionLowered = false;
  private readonly cfg: Required<Pick<FakeDeviceConfig, 'identNo' | 'passwordExists' | 'leaksCleartext' | 'blockReadsWork'>> &
    FakeDeviceConfig;
  private readonly secret = new Map<number, number>();
  private readonly sys = new Map<number, number>();

  constructor(config: FakeDeviceConfig = {}) {
    this.cfg = {
      identNo: config.identNo ?? 0x45,
      passwordExists: config.passwordExists ?? false,
      leaksCleartext: config.leaksCleartext ?? false,
      blockReadsWork: config.blockReadsWork ?? false,
      ...config,
    };
    this.mode = config.mode ?? 0x42;

    // System registers — always readable.
    this.sys.set(ADDR.PWD_MAGIC1, 0x04);
    this.sys.set(ADDR.PWD_MAGIC2, 0x00);
    this.sys.set(ADDR.IDENT, 0x42);
    for (let i = 0; i < FW.length; i++) this.sys.set(ADDR.FW_START + i, FW.charCodeAt(i));
    this.sys.set(ADDR.PWD_EXISTS, this.cfg.passwordExists ? 0x40 : 0x00);

    // Secret registers — readable only when protection is effectively down.
    const pw = config.password ?? 'secret';
    for (let i = 0; i < 10; i++) this.secret.set(ADDR.PWD_MEM + i, i < pw.length ? pw.charCodeAt(i) : 0x00);
    const prog = config.program ?? new Uint8Array(0);
    for (let i = 0; i < prog.length; i++) this.secret.set(ADDR.PROGRAM + i, prog[i]);
  }

  /** True when secret memory (password store, program) is currently exposed. */
  private secretsReadable(): boolean {
    return !this.cfg.passwordExists || (this.protectionLowered && this.cfg.leaksCleartext);
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

  private static addr(cmd: Uint8Array): number {
    return ((cmd[1] << 24) >>> 0) + (cmd[2] << 16) + (cmd[3] << 8) + cmd[4];
  }

  private handle(cmd: Uint8Array): void {
    const op = cmd[0];
    if (op === 0x21) {
      // Connect request. Observed on real 0BA6.ES10: → 21  ← 06 03 21 45, i.e. ACK, 0x03, the
      // echoed command byte, then the IdentNo (byte[3]). The brickpool wiki documents
      // 06 55 <..> <ident>; the ES10 differs, but the IdentNo is byte[3] either way.
      this.push(0x06, 0x03, 0x21, this.cfg.identNo);
      return;
    }
    if (op === 0x22) {
      // Restart clears the latched error state.
      this.latched = false;
      this.push(0x06);
      return;
    }
    if (op === 0x55) {
      if (cmd[1] === 0x17) {
        this.push(0x06, this.mode); // mode query → 06 <mode>
      } else if (cmd[1] === 0x12) {
        // Force STOP. Observed on 0BA6.ES10: a STOP command to a device ALREADY in STOP got NO
        // response (only a real RUN→STOP transition is acknowledged with 0x06). See
        // LAB-NOTEBOOK.md — inferred from a single observation of an already-stopped device.
        if (this.mode !== 0x42) {
          this.mode = 0x42;
          this.push(0x06);
        }
      } else if (cmd[1] === 0x18) {
        this.mode = 0x01; // force RUN
        this.push(0x06);
      } else {
        this.push(0x06);
      }
      return;
    }
    if (this.latched) {
      // Any command after an exception is refused until Restart.
      this.push(0x15, 0x03);
      return;
    }
    if (op === 0x02) {
      // Read Byte → ACK, 0x03, echoed address, value. Never faults (matches ES10).
      const a = FakeDevice.addr(cmd);
      const value = this.readMem(a);
      this.push(0x06, 0x03, cmd[1], cmd[2], cmd[3], cmd[4], value);
      return;
    }
    if (op === 0x01) {
      // Write Byte → ACK. Protection registers change the effective level.
      const a = FakeDevice.addr(cmd);
      if (a === ADDR.PL_LEVEL1) this.protectionLowered = true;
      else if (a === ADDR.PL_LEVEL2 || a === ADDR.PL_LEVEL3) this.protectionLowered = false;
      this.push(0x06);
      return;
    }
    if (op === 0x05) {
      // Read Block: on the 0BA6.ES10 this is rejected. Observed exactly (PROTOCOL.md §3.2):
      // the LOGO! sends 0x06 immediately on receiving the 0x05 command byte — before it has
      // parsed the address — THEN the 15 03 exception where the data block was expected, and
      // the session latches until a Restart. So the reply is `06 15 03`, NOT a bare `15 03`.
      if (!this.cfg.blockReadsWork) {
        this.latched = true;
        this.push(0x06, 0x15, 0x03);
        return;
      }
      const a = FakeDevice.addr(cmd);
      const count = (cmd[5] << 8) | cmd[6];
      const data: number[] = [];
      for (let i = 0; i < count; i++) data.push(this.readMem((a + i) >>> 0));
      let xor = 0;
      for (const d of data) xor ^= d;
      this.push(0x06, ...data, xor);
      return;
    }
    // Unknown command: unknown-command exception.
    this.latched = true;
    this.push(0x15, 0x05);
  }

  private readMem(a: number): number {
    if (this.sys.has(a)) return this.sys.get(a)!;
    if (this.secret.has(a)) return this.secretsReadable() ? this.secret.get(a)! : 0x00;
    return 0x00; // unmapped/protected reads return 0x00 without faulting
  }
}
