// The application context passed to every action: the centralized state Store, the Logger,
// a thin Ui port (so actions never touch the DOM directly), and the current Connection.

import type { Connection } from './pg/connection.js';
import type { Logger, LogClass } from './log.js';
import type { Store } from './state/store.js';

export interface Ui {
  /** Current value of a text input by element id. */
  input(id: string): string;
  /** Replace the netlist output panel. */
  setNetlist(text: string): void;
  /** Set the connection status label. */
  setStatus(text: string, cls: LogClass): void;
  /** Show an OK/Cancel prompt; returns true on OK. Used to verify the recovered password. */
  confirm(message: string): boolean;
}

export class App {
  /** Null until a transport is connected. */
  conn: Connection | null = null;

  constructor(
    readonly store: Store,
    readonly logger: Logger,
    readonly ui: Ui,
  ) {}

  log(msg: string, cls: LogClass = null): void {
    this.logger.log(msg, cls);
  }

  requireConn(): Connection {
    if (!this.conn) throw new Error('Not connected — press “1 · Connect cable” first.');
    return this.conn;
  }
}
