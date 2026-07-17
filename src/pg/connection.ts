// Centralized communication. One Connection owns the transport and is the ONLY thing that
// talks the PG protocol — every command (connect, restart, read, write, mode, probe) is a
// method here, so byte framing, exception handling, and the Restart-after-error recovery live
// in exactly one place. Higher layers (actions) call these methods and never touch bytes.

import type { Logger } from '../log.js';
import type { Transport } from '../transport/types.js';
import { addr8, hex } from '../util/hex.js';
import { cpuErrText, IDENT_NAMES, isStopMode, MODES, OP } from './constants.js';
import { addrBytes as encodeAddr, ba6, BA5, profileForIdent, wireAddr, type DeviceProfile } from './device.js';

/** A read/write rejected by the device. `nok` is the CPU exception code, when known. */
export class PgError extends Error {
  readonly nok?: number;
  constructor(message: string, nok?: number) {
    super(message);
    this.name = 'PgError';
    this.nok = nok;
  }
}

export class Connection {
  /** Telegram retry count (LSC retries reads/writes 5×). */
  private static readonly RETRIES = 5;

  /** Set by the Stop button to interrupt a long region read / probe. */
  abort = false;

  /** Addressing profile — set by connect(). Defaults to 0BA6.ES10. */
  private device: DeviceProfile = ba6(0x45);

  constructor(
    private readonly xport: Transport,
    private readonly logger: Logger,
  ) {}

  get kind(): string {
    return this.xport.kind;
  }

  get deviceName(): string {
    return this.device.name;
  }

  async close(): Promise<void> {
    await this.xport.close();
  }

  /** Encode an address as its wire bytes for the current device (4-byte on 0BA6, 2-byte on 0BA5). */
  private addrBytes(addr: number): number[] {
    return encodeAddr(this.device, addr);
  }

  /**
   * Connect + auto-detect the device. 0BA6 answers the `0x21` request (`06 03 21 <ident>`); 0BA5
   * does not, and is probed instead with a 2-byte Read Byte at the ident register `0x1F02`.
   * Sets `this.device` (address width) and returns the IdentNo.
   */
  async connect(): Promise<number> {
    const stale = await this.xport.read(4096, 80); // drain
    if (stale.length) this.logger.log('drained ' + stale.length + ' stale byte(s) before connect: ' + hex(stale), 'mut');
    await this.xport.write(new Uint8Array([OP.CONNECT]));
    const r = await this.xport.read(4, 1500);
    this.logger.log('→ 21    ← ' + (r.length ? hex(r) : '(nothing)'), r.length ? null : 'mut');
    if (r.length >= 4 && r[0] === OP.ACK) {
      await this.drain('connect', 120);
      const ident = r[3];
      this.device = profileForIdent(ident) ?? ba6(ident);
      this.logger.log('Connected. IdentNo=0x' + ident.toString(16) + ' → ' + this.device.name, ident >= 0x43 && ident <= 0x45 ? 'ok' : 'err');
      return ident;
    }
    // No 0x21 answer — try the 0BA5 (2-byte) probe: Read Byte at 0x1F02 (the ident register).
    this.logger.log('No 0x21 answer — probing for a 0BA5 (2-byte addressing) at 0x1F02…', 'mut');
    this.device = BA5;
    await this.xport.read(4096, 80);
    await this.xport.write(new Uint8Array([OP.READ_BYTE, 0x1f, 0x02]));
    const p = await this.xport.read(5, 1500); // 06 03 1F 02 <ident>
    this.logger.log('→ 02 1f 02   ← ' + (p.length ? hex(p) : '(nothing)'), p.length ? null : 'err');
    if (p.length >= 5 && p[0] === OP.ACK && p[1] === 0x03) {
      await this.drain('connect (0BA5)', 120);
      const ident = p[4];
      this.device = ident === 0x42 ? BA5 : { identNo: ident, name: IDENT_NAMES[ident] ?? '0x' + ident.toString(16), addrWidth: 2 };
      this.logger.log('Connected. 0BA5-style device, IdentNo=0x' + ident.toString(16) + ' → ' + this.device.name, 'ok');
      return ident;
    }
    throw new Error('No device ack (neither 0BA6 0x21 nor 0BA5 0x1F02 probe). Got: ' + hex(r) + ' / ' + hex(p) + '. Is it in STOP and cabled?');
  }

  /**
   * Restart `0x22`. CRITICAL for 0BA6: after ANY exception the device refuses every further
   * command with an exception code until it is restarted.
   */
  async restart(quiet = false): Promise<boolean> {
    await this.xport.read(4096, 60);
    await this.xport.write(new Uint8Array([OP.RESTART]));
    const r = await this.xport.read(1, 1200);
    const ok = r.length > 0 && r[0] === OP.ACK;
    if (!quiet) this.logger.log('→ 22   ← ' + (r.length ? hex(r) : '(nothing)') + '   (Restart — clears the error state)', ok ? 'ok' : 'err');
    await this.xport.read(4096, quiet ? 60 : 150); // swallow the stray trailing byte
    return ok;
  }

  /**
   * Re-establish the session after an exception: Restart (0x22), then the device-appropriate
   * handshake. The 0BA6 answers the 0x21 connect request; the 0BA5 does NOT (0x21 gets no reply)
   * and is re-probed with the 2-byte Read Byte at the ident register 0x1F02, exactly as connect()
   * detects it. Using 0x21 on a 0BA5 would leave the device un-handshaken and desync the stream.
   */
  async recover(): Promise<void> {
    await this.restart(true);
    if (this.device.addrWidth === 4) {
      await this.xport.write(new Uint8Array([OP.CONNECT]));
      await this.xport.read(4, 800);
    } else {
      await this.xport.write(new Uint8Array([OP.READ_BYTE, 0x1f, 0x02]));
      await this.xport.read(5, 800);
    }
    await this.xport.read(4096, 40);
  }

  /** Read everything still buffered and show it. Nothing gets swallowed silently. */
  async drain(tag: string, to = 400): Promise<Uint8Array> {
    const j = await this.xport.read(4096, to);
    if (j.length) this.logger.log('  ' + tag + ' trailing bytes (' + j.length + '): ' + hex(j), 'mut');
    return j;
  }

  /**
   * Read Byte `0x02` with retry. LSC retries the whole telegram up to 5× on any transient failure
   * (no response, short/desynced response, echo mismatch, or a transient NOK); a single glitch at
   * 9600 baud otherwise aborts a multi-thousand-byte dump. Deterministic rejections (illegal access
   * 0x03, unknown command 0x05) are surfaced immediately — retrying won't change them.
   */
  async readByte(addr: number, quiet = false): Promise<number> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.readByteOnce(addr, quiet);
      } catch (e) {
        if (e instanceof PgError && (e.nok === 0x03 || e.nok === 0x05)) throw e;
        if (this.abort || attempt >= Connection.RETRIES) throw e;
        this.logger.log('  retry Read Byte ' + addr8(addr) + ' (attempt ' + (attempt + 1) + '/' + Connection.RETRIES + ')', 'mut');
      }
    }
  }

  /** One Read Byte attempt. Response echoes the address back (`06 03 <addr> <data>`). */
  private async readByteOnce(addr: number, quiet = false): Promise<number> {
    const cmd = new Uint8Array([OP.READ_BYTE, ...this.addrBytes(addr)]);
    const A = addr8(addr);
    await this.xport.write(cmd);
    const t0 = await this.xport.read(1, 1500);
    if (!t0.length) {
      await this.drain('(silent)');
      throw new Error('Read Byte ' + A + ': no response.');
    }
    if (t0[0] === OP.NOK) {
      const e = await this.xport.read(1, 1000);
      const code = e.length ? e[0] : -1;
      if (!quiet) {
        this.logger.log('→ ' + hex(cmd) + '   ← 15 ' + hex(e) + '   NOK', 'err');
        await this.drain('after NOK');
        await this.restart();
      } else {
        await this.xport.read(4096, 40);
        await this.recover();
      }
      throw new PgError(
        'Read Byte ' + A + ' rejected — NOK code 0x' + (code < 0 ? '??' : code.toString(16).padStart(2, '0')) + ': ' + cpuErrText(code),
        code < 0 ? undefined : code,
      );
    }
    if (t0[0] !== OP.ACK) {
      await this.drain('after unexpected');
      throw new Error('Read Byte ' + A + ': expected 0x06/0x15, got 0x' + t0[0].toString(16));
    }
    // Response: 03 + <addrWidth> addr echo + 1 data. Width is 4 on 0BA6, 2 on 0BA5.
    const w = this.device.addrWidth;
    const rest = await this.xport.read(2 + w, 1500);
    if (rest.length < 2 + w) {
      await this.drain('short');
      throw new Error('Read Byte ' + A + ': short response (' + hex(rest) + ')');
    }
    if (!quiet) this.logger.log('→ ' + hex(cmd) + '   ← 06 ' + hex(rest), 'mut');
    if (rest[0] !== 0x03) throw new Error('Read Byte ' + A + ': expected data code 0x03, got 0x' + rest[0].toString(16));
    let echo = 0;
    for (let i = 0; i < w; i++) echo = (echo << 8) | rest[1 + i];
    echo >>>= 0;
    if (echo !== wireAddr(this.device, addr)) {
      // Wrong echo = the response is for a different address (desync) — the data is unreliable.
      // Throw so the retry re-reads (LSC treats a wrong echo as a failure).
      await this.drain('after echo mismatch');
      throw new Error('Read Byte ' + A + ': address echo mismatch (echoed 0x' + echo.toString(16) + ')');
    }
    return rest[1 + w];
  }

  /**
   * Write Byte `0x01` with retry (LSC retries up to 5× on a non-ACK). Our writes are all protection
   * registers, so a retry is idempotent. Deterministic NOKs (illegal 0x03, unknown 0x05) throw at once.
   */
  async writeByte(addr: number, data: number): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.writeByteOnce(addr, data);
      } catch (e) {
        if (e instanceof PgError && (e.nok === 0x03 || e.nok === 0x05)) throw e;
        if (this.abort || attempt >= Connection.RETRIES) throw e;
        this.logger.log('  retry Write Byte ' + addr8(addr) + ' (attempt ' + (attempt + 1) + '/' + Connection.RETRIES + ')', 'mut');
      }
    }
  }

  /** One Write Byte attempt. Response is a bare `0x06` (or `15 <code>`). */
  private async writeByteOnce(addr: number, data: number): Promise<void> {
    const cmd = new Uint8Array([OP.WRITE_BYTE, ...this.addrBytes(addr), data & 0xff]);
    const A = addr8(addr);
    await this.xport.read(4096, 40);
    await this.xport.write(cmd);
    const t0 = await this.xport.read(1, 1500);
    this.logger.log(
      '→ ' + hex(cmd) + '   ← ' + (t0.length ? hex(t0) : '(nothing)') + '   (Write Byte ' + A + ' = 0x' + data.toString(16).padStart(2, '0') + ')',
      t0.length && t0[0] === OP.ACK ? 'ok' : 'err',
    );
    if (t0.length && t0[0] === OP.NOK) {
      const e = await this.xport.read(1, 900);
      await this.restart();
      throw new PgError('Write Byte ' + A + ' rejected — NOK ' + (e.length ? cpuErrText(e[0]) : '?'), e.length ? e[0] : undefined);
    }
    if (!t0.length || t0[0] !== OP.ACK) throw new Error('Write Byte ' + A + ': no ACK (got ' + hex(t0) + ')');
  }

  /**
   * Byte-wise region read. Read Byte is confirmed working at every probed address on the
   * 0BA6.ES10, so this is the dependable dump path even though Read Block is rejected.
   * Honours `abort`.
   */
  async readRegion(addr: number, count: number, label: string): Promise<Uint8Array> {
    const out = new Uint8Array(count);
    const t0 = Date.now();
    for (let i = 0; i < count; i++) {
      if (this.abort) {
        this.logger.log('  aborted at ' + i + '/' + count, 'err');
        throw new Error('aborted');
      }
      out[i] = await this.readByte((addr + i) >>> 0, true);
      if (i % 128 === 127 || i === count - 1) {
        const pct = Math.round(((i + 1) / count) * 100);
        const el = (Date.now() - t0) / 1000;
        this.logger.log('  ' + label + ': ' + (i + 1) + '/' + count + ' bytes (' + pct + '%), ' + el.toFixed(0) + 's elapsed', 'mut');
      }
    }
    this.logger.log('  ' + label + ': read ' + count + ' bytes via Read Byte.', 'ok');
    return out;
  }

  /** Operating mode: `55 17 17 AA` → `06 <mode>`. Returns the mode byte; logs the meaning. */
  async getMode(): Promise<number> {
    await this.xport.read(4096, 50);
    await this.xport.write(new Uint8Array([0x55, 0x17, 0x17, 0xaa]));
    const r = await this.xport.read(2, 1500);
    this.logger.log('→ 55 17 17 aa   ← ' + (r.length ? hex(r) : '(nothing)'), 'mut');
    if (r.length < 2 || r[0] !== OP.ACK) {
      await this.drain('mode');
      throw new Error('Mode request not confirmed (got ' + hex(r) + ').');
    }
    const m = r[1];
    const stopped = isStopMode(m);
    const nm = MODES[m] ?? (stopped ? 'STOP (0x' + m.toString(16) + ')' : 'unknown 0x' + m.toString(16));
    this.logger.log(
      'Operating mode: ' + nm + (stopped ? '  ← good, memory reads need STOP' : '  ← reads will be REJECTED; press “2 · Put in STOP”'),
      stopped ? 'ok' : 'err',
    );
    await this.drain('mode');
    return m;
  }

  /** Force STOP: `55 12 12 AA` → `06`. */
  async sendStop(): Promise<void> {
    await this.xport.read(4096, 50);
    await this.xport.write(new Uint8Array([0x55, 0x12, 0x12, 0xaa]));
    const r = await this.xport.read(1, 1000);
    this.logger.log('→ 55 12 12 aa   ← ' + (r.length ? hex(r) : '(nothing)'), 'mut');
    if (r.length && r[0] === OP.ACK) {
      this.logger.log('STOP acknowledged.', 'ok');
    } else if (r.length && r[0] === OP.NOK) {
      const e = await this.xport.read(1, 800);
      this.logger.log('STOP rejected: NOK code ' + (e.length ? cpuErrText(e[0]) : '?'), 'err');
    } else {
      this.logger.log('STOP: unexpected response.', 'err');
    }
    await this.drain('stop');
  }

}
