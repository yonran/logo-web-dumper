// Centralized logging. Every byte exchanged and every status line goes through one Logger,
// which keeps a plain-text mirror (so Copy/Download give exact text, not scraped DOM) and
// fans each line out to listeners (the on-screen log view subscribes to render).

export type LogClass = 'ok' | 'err' | 'mut' | null;
export type LogListener = (msg: string, cls: LogClass) => void;

export class Logger {
  readonly lines: string[] = [];
  private readonly listeners: LogListener[] = [];

  log(msg: string, cls: LogClass = null): void {
    this.lines.push(msg);
    for (const l of this.listeners) l(msg, cls);
  }

  onLine(cb: LogListener): void {
    this.listeners.push(cb);
  }

  clear(): void {
    this.lines.length = 0;
  }

  text(): string {
    return this.lines.join('\n');
  }
}
