// The application context passed to every action: the centralized state Store, the Logger,
// a thin Ui port (so actions never touch the DOM directly), and the current Connection.

import type { Connection } from './pg/connection.js';
import type { Logger, LogClass } from './log.js';
import type { Store } from './state/store.js';

/**
 * A snapshot of the operation currently running, for the on-screen progress indicator.
 * `fraction` is 0..1 for a determinate bar, or `null` while the operation is running but has no
 * measurable progress yet (shown as an indeterminate "working…" bar).
 */
export interface ProgressView {
  label: string;
  fraction: number | null;
  detail?: string;
}

export interface Ui {
  /** Current value of a text input by element id. */
  input(id: string): string;
  /** Replace the netlist output panel. */
  setNetlist(text: string): void;
  /**
   * Provide the Mermaid diagram source for the decoded program (or `null` to hide the diagram
   * controls). The UI turns it into an "open in mermaid.live" link and a copy button; the source is
   * generated locally and nothing is uploaded.
   */
  setDiagram(mermaid: string | null): void;
  /** Set the connection status label. */
  setStatus(text: string, cls: LogClass): void;
  /** Show/update the running-operation progress indicator; `null` hides it. */
  setProgress(p: ProgressView | null): void;
  /**
   * Display the recovered password value non-modally (in a persistent panel, not a pop-up).
   * Pass an empty string to clear it. The operator reads this before choosing to clear protection.
   */
  showPassword(text: string): void;
  /** Offer a byte blob to the user as a file download (a DOM action, kept off the action layer). */
  download(filename: string, bytes: Uint8Array): void;
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
