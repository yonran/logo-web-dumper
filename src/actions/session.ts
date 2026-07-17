// Session actions: connect / identify / restart / mode / stop.

import type { App } from '../app.js';
import { Connection } from '../pg/connection.js';
import { ADDR, isStopMode, isPasswordSet } from '../pg/constants.js';
import { openTransport, resolveMode, transportCaps } from '../transport/connect.js';
import type { TransportMode } from '../transport/types.js';

/**
 * Connect the cable. Honours an explicit transport choice; `auto` prefers Web Serial. On
 * failure, logs targeted hints (an empty picker means the OS isn't seeing the cable on that
 * transport). Handles its own errors — does not throw.
 */
export async function doConnect(app: App, pref: TransportMode): Promise<void> {
  const caps = transportCaps();
  const mode = resolveMode(pref, caps);
  try {
    const transport = await openTransport(mode, caps, app.logger);
    app.conn = new Connection(transport, app.logger);
    app.ui.setStatus('connected (' + transport.kind + ')', 'ok');
    app.log('Cable connected via ' + transport.kind + '. Configured 9600 8E1.', 'ok');
    // A 0BA6 stays wedged in its error state across reconnects (only 0x22 or a power cycle
    // clears it), so a previous failed session would poison this one too.
    app.log('Clearing any leftover error state from a previous session…', 'mut');
    await app.conn.restart();
    app.store.set({ connected: true });
  } catch (e) {
    if (app.conn) {
      try {
        await app.conn.close();
      } catch {
        // Keep the original connection failure; cleanup is best effort.
      }
    }
    app.conn = null;
    app.store.set({ connected: false, stopped: false, protected: null, passwordRead: false, unlocked: false, dumped: false });
    app.ui.setStatus('not connected', 'err');
    const msg = e instanceof Error ? e.message : String(e);
    const name = e instanceof Error ? e.name : '';
    app.log('Connect failed: ' + msg, 'err');
    const emptyPicker = /NotFoundError|No port selected|No device selected/i.test(name + ' ' + msg);
    if (emptyPicker) {
      app.log('The picker had nothing to choose from, so the OS is not seeing the cable on the "' + mode + '" transport.', 'err');
      if (mode === 'serial' && caps.usb) {
        app.log('→ Your cable did not appear as a serial port. Set the Transport dropdown to “WebUSB” and press Connect again.', 'err');
      } else if (mode === 'usb') {
        app.log(
          '→ No USB device to pick. On Android over OTG: try a USB mouse in the SAME adapter (if it works, OTG is fine and the issue is the cable), check chrome://device-log while re-plugging, enable the phone’s USB-OTG setting, use a real/powered host adapter. On desktop: the OS serial driver may already hold the cable — use Web Serial instead.',
          'err',
        );
      }
      app.log('Most reliable path: plug into a Mac/Windows/Linux computer and use desktop Chrome.', 'mut');
    }
  }
}

/** Close the transport and return every session-derived UI field to its initial state. */
export async function doDisconnect(app: App): Promise<void> {
  const conn = app.requireConn();
  await conn.close();
  app.conn = null;
  app.store.set({ connected: false, stopped: false, protected: null, passwordRead: false, unlocked: false, dumped: false });
  app.ui.setStatus('not connected', 'mut');
  app.log('Disconnected.', 'ok');
}

/** Identify using the 0BA6 handshake or the 0BA5 two-byte probe. */
export async function doIdentify(app: App): Promise<void> {
  const conn = app.requireConn();
  await conn.connect();
  app.ui.setStatus('connected · ' + conn.deviceName, conn.known ? 'ok' : 'err');
}

/** Restart (0x22) then re-negotiate using the device-appropriate handshake. */
export async function doRestart(app: App): Promise<void> {
  const conn = app.requireConn();
  await conn.restart();
  await conn.connect();
}

/** Check operating mode (RUN/STOP). */
export async function doCheckMode(app: App): Promise<void> {
  const conn = app.requireConn();
  await conn.connect();
  const m = await conn.getMode();
  app.store.set({ stopped: isStopMode(m) });
}

/** Force STOP, then learn the protection state so unlock/re-lock enable correctly. */
export async function doStop(app: App): Promise<void> {
  const conn = app.requireConn();
  await conn.connect();
  await conn.sendStop();
  const m = await conn.getMode();
  app.store.set({ stopped: isStopMode(m) });
  if (!isStopMode(m)) return;
  const p = await conn.readByte(ADDR.PWD_EXISTS);
  app.store.set({ protected: isPasswordSet(p) });
  app.log(
    'Password ' +
      (isPasswordSet(p)
        ? 'IS set (0x48FF=0x40) — use steps 3–4 to unlock, step 6 to re-lock.'
        : 'is not set (0x48FF=0x' + p.toString(16) + ').'),
    isPasswordSet(p) ? 'mut' : 'ok',
  );
  // Reversibility across refresh/reconnect: 0x48FF reports only that a password EXISTS, not
  // the current protection LEVEL. So we CANNOT tell from the device whether an unlock earlier
  // this session — or in a previous session / before a page refresh — left it at level 1
  // (unprotected). Make that unknowable-state explicit rather than pretend it's re-locked.
  if (isPasswordSet(p)) {
    app.log(
      'Note: the device can report that a password exists but NOT the current protection level. If you (or an earlier session/refresh) ran an unlock, this LOGO! may still be UNPROTECTED right now — press “6 · Re-lock” to be certain. Re-lock works cross-session.',
      'err',
    );
  }
}
