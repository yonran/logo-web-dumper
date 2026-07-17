// Centralized state management. The whole app's observed state is these five fields in one
// place. Nothing mutates them directly — call `set()`, and every subscriber (button
// enablement, the "do this next" glow) re-renders from the new snapshot. This is what makes
// the UI reload correctly after a reconnect: the state is re-derived from the device (see the
// STOP action reading 0x48FF) and pushed through here, rather than living in scattered globals.

export interface AppState {
  /** A transport is open. */
  connected: boolean;
  /** The device is confirmed in STOP mode (memory reads are allowed). */
  stopped: boolean;
  /** A password exists on the device (0x48FF === 0x40). `null` = not yet known. */
  protected: boolean | null;
  /** We lowered protection this session (an undo, Re-lock, is owed). */
  unlocked: boolean;
  /** A program dump has been read this session. */
  dumped: boolean;
}

export const INITIAL_STATE: AppState = {
  connected: false,
  stopped: false,
  protected: null,
  unlocked: false,
  dumped: false,
};

export type StateListener = (s: Readonly<AppState>) => void;

export class Store {
  private state: AppState;
  private readonly listeners: StateListener[] = [];

  constructor(init: AppState = INITIAL_STATE) {
    this.state = { ...init };
  }

  get(): Readonly<AppState> {
    return this.state;
  }

  set(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  /** Re-notify listeners without changing state (used to re-render after an operation). */
  touch(): void {
    this.emit();
  }

  subscribe(cb: StateListener): void {
    this.listeners.push(cb);
    cb(this.state);
  }

  private emit(): void {
    for (const l of this.listeners) l(this.state);
  }
}
