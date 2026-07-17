// Shared action preamble. Almost every operation needs a clean, connected, STOP-mode session
// first: Restart (clear any latched error) → Connect (re-negotiate) → query mode → record it
// in the store. This is that sequence in one place.

import type { App } from '../app.js';
import type { Connection } from '../pg/connection.js';
import { MODE_STOP } from '../pg/constants.js';

const STOP_HINT = 'Needs STOP mode — press “2 · Put in STOP” first.';

/**
 * Restart + connect + confirm STOP. Updates `store.stopped`. Returns the Connection when in
 * STOP, or null (after logging `hint`) otherwise.
 */
export async function ensureStopped(app: App, hint: string = STOP_HINT): Promise<Connection | null> {
  const conn = app.requireConn();
  conn.abort = false;
  await conn.restart();
  await conn.connect();
  const m = await conn.getMode();
  app.store.set({ stopped: m === MODE_STOP });
  if (m !== MODE_STOP) {
    app.log(hint, 'err');
    return null;
  }
  return conn;
}
