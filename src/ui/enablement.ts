// Pure button-state policy, split out from the DOM so it can be unit-tested. Given a state
// snapshot it returns which buttons are enabled and which one carries the "do this next" glow;
// the controller just applies this to the DOM.

import type { AppState } from '../state/store.js';

export const BUTTON_IDS = [
  'connect',
  'disconnect',
  'stop',
  'mode',
  'ident',
  'restart',
  'fw',
  'recover',
  'unlock',
  'decode',
  'dump',
  'nametest',
  'relock',
  'decfile',
  'copylog',
  'dllog',
  'clearlog',
] as const;

export type ButtonId = (typeof BUTTON_IDS)[number];

export interface Enablement {
  enabled: Record<ButtonId, boolean>;
  next: ButtonId | null;
}

export function buttonEnablement(s: AppState): Enablement {
  const C = s.connected;
  const ST = C && s.stopped;
  // Reading the password (recover) is read-only and re-runnable; clearing protection (unlock) is
  // the write. Both are gated on device state (a password exists), not on the session-only
  // passwordRead flag — so they still enable correctly after a page refresh.
  const canRecover = ST && s.protected !== false && !s.unlocked;
  const canUnlock = ST && s.protected !== false && !s.unlocked;
  const enabled: Record<ButtonId, boolean> = {
    connect: !C,
    disconnect: C,
    stop: C,
    mode: C,
    ident: C,
    restart: C,
    fw: ST,
    recover: canRecover,
    unlock: canUnlock,
    decode: ST,
    dump: ST,
    nametest: ST,
    // Re-lock is safe whenever a password EXISTS or we unlocked this session — cross-session by
    // design, so a fresh session can re-lock a device left unprotected earlier.
    relock: ST && (s.unlocked || s.protected === true),
    // NB: `abort` (the "Stop" button) is intentionally not here — it is runtime-driven (only
    // enabled while an operation is running), handled in the controller, not from AppState.
    decfile: true,
    copylog: true,
    dllog: true,
    clearlog: true,
  };
  let next: ButtonId | null = null;
  if (!C) next = 'connect';
  else if (!s.stopped) next = 'stop';
  // Guide the operator to READ the password first, then to the protection-clearing write.
  else if (s.protected === true && !s.unlocked && !s.passwordRead) next = 'recover';
  else if (s.protected === true && !s.unlocked) next = 'unlock';
  else if (!s.dumped) next = 'decode';
  else if (s.unlocked) next = 'relock';
  return { enabled, next };
}
