// Test harness: wires an App with a fake Ui and a Connection over a FakeDevice, so action
// functions can be driven exactly as the buttons drive them.

import { App, type ProgressView, type Ui } from '../../src/app.js';
import type { LogClass, Logger } from '../../src/log.js';
import { Logger as LoggerImpl } from '../../src/log.js';
import { Store } from '../../src/state/store.js';
import { Connection } from '../../src/pg/connection.js';
import { FakeDevice, type FakeDeviceConfig } from './fake-device.js';

export class FakeUi implements Ui {
  netlist = '';
  status = '';
  statusCls: LogClass = null;
  inputs: Record<string, string> = {};
  /** The current non-modal password panel text (last value passed to showPassword). */
  password = '';
  /** Every value passed to showPassword(), for assertions. */
  readonly passwordShown: string[] = [];
  /** Files offered via download(), for assertions. */
  readonly downloads: { name: string; bytes: Uint8Array }[] = [];
  /** Progress snapshots passed to setProgress(), for assertions (null = hidden). */
  readonly progress: (ProgressView | null)[] = [];

  input(id: string): string {
    return this.inputs[id] ?? '';
  }
  setNetlist(t: string): void {
    this.netlist = t;
  }
  setStatus(t: string, cls: LogClass): void {
    this.status = t;
    this.statusCls = cls;
  }
  setProgress(p: ProgressView | null): void {
    this.progress.push(p);
  }
  showPassword(text: string): void {
    this.password = text;
    this.passwordShown.push(text);
  }
  download(name: string, bytes: Uint8Array): void {
    this.downloads.push({ name, bytes });
  }
}

export interface Harness {
  app: App;
  store: Store;
  logger: Logger;
  ui: FakeUi;
  device: FakeDevice;
  conn: Connection;
}

export function makeHarness(config: FakeDeviceConfig = {}): Harness {
  const logger = new LoggerImpl();
  const store = new Store();
  const ui = new FakeUi();
  const app = new App(store, logger, ui);
  const device = new FakeDevice(config);
  const conn = new Connection(device, logger);
  app.conn = conn;
  return { app, store, logger, ui, device, conn };
}

/** True if any logged line contains `substr`. */
export function logged(logger: Logger, substr: string): boolean {
  return logger.lines.some((l) => l.includes(substr));
}

/** True if the device received a Write Byte to `addr` with `data`. */
export function wroteByte(device: FakeDevice, addr: number, data: number): boolean {
  const a = [(addr >>> 24) & 0xff, (addr >>> 16) & 0xff, (addr >>> 8) & 0xff, addr & 0xff];
  return device.writes.some(
    (w) => w[0] === 0x01 && w[1] === a[0] && w[2] === a[1] && w[3] === a[2] && w[4] === a[3] && w[5] === data,
  );
}
