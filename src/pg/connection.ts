// Centralized communication. One Connection owns the transport and is the ONLY thing that
// talks the PG protocol — every command (connect, restart, read, write, mode, probe) is a
// method here, so byte framing, exception handling, and the Restart-after-error recovery live
// in exactly one place. Higher layers (actions) call these methods and never touch bytes.

import type { Logger } from '../log.js';
import type { Transport } from '../transport/types.js';
import { addr8, hex } from '../util/hex.js';
import { cpuErrText, IDENT_NAMES, MODES, MODE_STOP, OP } from './constants.js';

/** A read/write rejected by the device. `nok` is the CPU exception code, when known. */
export class PgError extends Error {
  readonly nok?: number;
  constructor(message: string, nok?: number) {
    super(message);
    this.name = 'PgError';
    this.nok = nok;
  }
}

export interface ProbeHit {
  addr: number;
  v: number;
}
export interface BlockHit {
  addr: number;
  nz: number;
}

export class Connection {
  /** Set by the Stop button to interrupt a long region read / probe. */
  abort = false;

  constructor(
    private readonly xport: Transport,
    private readonly logger: Logger,
  ) {}

  get kind(): string {
    return this.xport.kind;
  }

  async close(): Promise<void> {
    await this.xport.close();
  }

  private static addrBytes(addr: number): number[] {
    return [(addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff];
  }

  /** Connect request `0x21` → `06 55 <..> <IdentNo>`. Returns the IdentNo. */
  async connect(): Promise<number> {
    const stale = await this.xport.read(4096, 80); // drain
    if (stale.length) this.logger.log('drained ' + stale.length + ' stale byte(s) before connect: ' + hex(stale), 'mut');
    await this.xport.write(new Uint8Array([OP.CONNECT]));
    const r = await this.xport.read(4, 1500);
    this.logger.log('→ 21    ← ' + (r.length ? hex(r) : '(nothing)'), r.length ? null : 'err');
    if (r.length < 4 || r[0] !== OP.ACK) {
      throw new Error(
        'No 0BA6 ack. Got: ' + hex(r) + '. Is it in STOP and cabled? Genuine cable may need RTS/DTR high.',
      );
    }
    await this.drain('connect', 120);
    const ident = r[3];
    const name = IDENT_NAMES[ident] ?? '0x' + ident.toString(16);
    this.logger.log('Connected. IdentNo=0x' + ident.toString(16) + ' → ' + name, ident >= 0x43 && ident <= 0x45 ? 'ok' : 'err');
    return ident;
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

  /** After an exception the 0BA6 needs 22 then 21 before it will answer again. */
  async recover(): Promise<void> {
    await this.restart(true);
    await this.xport.write(new Uint8Array([OP.CONNECT]));
    await this.xport.read(4, 800);
    await this.xport.read(4096, 40);
  }

  /** Read everything still buffered and show it. Nothing gets swallowed silently. */
  async drain(tag: string, to = 400): Promise<Uint8Array> {
    const j = await this.xport.read(4096, to);
    if (j.length) this.logger.log('  ' + tag + ' trailing bytes (' + j.length + '): ' + hex(j), 'mut');
    return j;
  }

  /**
   * Read Byte `0x02`. Response echoes the address back: `06 03 <4-byte addr> <data>`, which
   * makes it self-validating. Throws PgError on NOK.
   */
  async readByte(addr: number, quiet = false): Promise<number> {
    const cmd = new Uint8Array([OP.READ_BYTE, ...Connection.addrBytes(addr)]);
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
    const rest = await this.xport.read(6, 1500); // 03 + 4 addr echo + 1 data
    if (rest.length < 6) {
      await this.drain('short');
      throw new Error('Read Byte ' + A + ': short response (' + hex(rest) + ')');
    }
    if (!quiet) this.logger.log('→ ' + hex(cmd) + '   ← 06 ' + hex(rest), 'mut');
    if (rest[0] !== 0x03) throw new Error('Read Byte ' + A + ': expected data code 0x03, got 0x' + rest[0].toString(16));
    const echo = (rest[1] << 24 >>> 0) + (rest[2] << 16) + (rest[3] << 8) + rest[4];
    if (echo !== addr) this.logger.log('  address echo MISMATCH: sent ' + A + ', echoed ' + addr8(echo), 'err');
    return rest[5];
  }

  /** Write Byte `0x01`. Response is a bare `0x06` (or `15 <code>`). Throws on NOK / no ACK. */
  async writeByte(addr: number, data: number): Promise<void> {
    const cmd = new Uint8Array([OP.WRITE_BYTE, ...Connection.addrBytes(addr), data & 0xff]);
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
    const nm = MODES[m] ?? 'unknown 0x' + m.toString(16);
    this.logger.log(
      'Operating mode: ' + nm + (m === MODE_STOP ? '  ← good, memory reads need STOP' : '  ← reads will be REJECTED; press “2 · Put in STOP”'),
      m === MODE_STOP ? 'ok' : 'err',
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

  /** Low-level Read Block attempt that reports rather than throws — used to characterise WHY
   * block reads fail on 0BA6 hardware. Returns the data on success, else null (after recovery). */
  async tryBlock(cmd: Uint8Array, count: number, label: string): Promise<Uint8Array | null> {
    await this.xport.read(4096, 60);
    await this.xport.write(cmd);
    const t0 = await this.xport.read(1, 2000);
    if (!t0.length) {
      this.logger.log(label + ' → no response', 'err');
      await this.recover();
      return null;
    }
    if (t0[0] === OP.NOK) {
      const e = await this.xport.read(1, 900);
      this.logger.log(label + ' → NOK 15 ' + hex(e) + '  ' + (e.length ? cpuErrText(e[0]) : ''), 'err');
      await this.recover();
      return null;
    }
    if (t0[0] !== OP.ACK) {
      this.logger.log(label + ' → unexpected ' + hex(t0), 'err');
      await this.recover();
      return null;
    }
    const data = await this.xport.read(count, 8000);
    if (data.length < count) {
      if (data.length === 2 && data[0] === OP.NOK) {
        this.logger.log(label + ' → 06 then NOK 15 ' + data[1].toString(16).padStart(2, '0') + '  ' + cpuErrText(data[1]), 'err');
      } else {
        this.logger.log(label + ' → short ' + data.length + '/' + count + ': ' + hex(data.slice(0, 24)), 'err');
      }
      await this.recover();
      return null;
    }
    const cs = await this.xport.read(1, 1500);
    let x = 0;
    for (const d of data) x ^= d;
    const ok = cs.length > 0 && cs[0] === x;
    this.logger.log(label + ' → OK, ' + data.length + ' bytes, XOR ' + (ok ? 'ok' : 'MISMATCH'), ok ? 'ok' : 'err');
    await this.xport.read(4096, 60);
    return data;
  }

  /** One Read Byte per address across a window — maps which addresses answer. Honours `abort`. */
  async probePages(base: number, pages: number, stride: number): Promise<ProbeHit[]> {
    this.abort = false;
    const hits: ProbeHit[] = [];
    this.logger.log(
      'Probing ' + pages + ' addresses from ' + addr8(base) + ' stride 0x' + stride.toString(16) + ' — one Read Byte each. This is slow at 9600 baud.',
      'mut',
    );
    for (let i = 0; i < pages && !this.abort; i++) {
      const addr = (base + i * stride) >>> 0;
      try {
        const v = await this.readByte(addr, true);
        hits.push({ addr, v });
        this.logger.log(
          '  READABLE  ' + addr8(addr) + ' = 0x' + v.toString(16).padStart(2, '0') + (v >= 32 && v < 127 ? '  "' + String.fromCharCode(v) + '"' : ''),
          'ok',
        );
      } catch (e) {
        if (!(e instanceof PgError && e.nok !== undefined)) {
          this.logger.log('  probe aborted at ' + addr8(addr) + ': ' + (e instanceof Error ? e.message : String(e)), 'err');
          break;
        }
      }
      if (i % 16 === 15) this.logger.log('  … ' + (i + 1) + '/' + pages + ' probed, ' + hits.length + ' readable so far', 'mut');
    }
    this.logger.log('Probe done: ' + hits.length + '/' + pages + ' addresses readable.', hits.length ? 'ok' : 'err');
    if (hits.length) this.logRuns(hits.map((h) => h.addr), stride, 'Readable regions:');
    return hits;
  }

  /**
   * Read Block as an address VALIDATOR. Read Byte quietly returns 0x00 for unmapped memory;
   * Read Block rejects illegal ranges with `15 03`, so it is the command that actually tells
   * us where memory exists. Honours `abort`.
   */
  async probeBlocks(base: number, pages: number, stride: number, n: number): Promise<BlockHit[]> {
    this.abort = false;
    const hits: BlockHit[] = [];
    this.logger.log('Probing ' + pages + ' pages with Read Block ×' + n + ' — unlike Read Byte, this FAULTS on unmapped memory.', 'mut');
    for (let i = 0; i < pages && !this.abort; i++) {
      const addr = (base + i * stride) >>> 0;
      const cmd = new Uint8Array([OP.READ_BLOCK, ...Connection.addrBytes(addr), (n >> 8) & 0xff, n & 0xff]);
      await this.xport.read(4096, 40);
      await this.xport.write(cmd);
      const t0 = await this.xport.read(1, 1500);
      let ok = false;
      let data: Uint8Array | null = null;
      if (t0.length && t0[0] === OP.ACK) {
        data = await this.xport.read(n, 3000);
        if (data.length === n) {
          await this.xport.read(1, 800);
          ok = true;
        }
      }
      if (ok && data) {
        let nz = 0;
        for (const d of data) if (d) nz++;
        hits.push({ addr, nz });
        this.logger.log('  LEGAL  ' + addr8(addr) + '  ' + nz + '/' + n + ' non-zero  ' + hex(data.slice(0, 8)), 'ok');
      } else {
        await this.recover();
      }
      if (i % 16 === 15) this.logger.log('  … ' + (i + 1) + '/' + pages + ', ' + hits.length + ' legal so far', 'mut');
    }
    this.logger.log('Read Block probe done: ' + hits.length + '/' + pages + ' pages are LEGAL ranges.', hits.length ? 'ok' : 'err');
    if (hits.length) {
      const runs: { start: number; end: number; nz: number }[] = [];
      let cur: { start: number; end: number; nz: number } | null = null;
      for (const h of hits) {
        if (cur && h.addr === cur.end + stride) {
          cur.end = h.addr;
          cur.nz += h.nz;
        } else {
          cur = { start: h.addr, end: h.addr, nz: h.nz };
          runs.push(cur);
        }
      }
      this.logger.log('Legal regions (Read Block accepts these):', 'ok');
      for (const r of runs) this.logger.log('  ' + addr8(r.start) + ' … ' + addr8(r.end) + '   (' + r.nz + ' non-zero bytes sampled)', 'ok');
    }
    return hits;
  }

  /** Summarise a sorted list of addresses into contiguous runs and log them. */
  private logRuns(addrs: number[], stride: number, header: string): void {
    const runs: { start: number; end: number }[] = [];
    let cur: { start: number; end: number } | null = null;
    for (const a of addrs) {
      if (cur && a === cur.end + stride) {
        cur.end = a;
      } else {
        cur = { start: a, end: a };
        runs.push(cur);
      }
    }
    this.logger.log(header, 'ok');
    for (const r of runs) this.logger.log('  ' + addr8(r.start) + ' … ' + addr8(r.end), 'ok');
  }
}
