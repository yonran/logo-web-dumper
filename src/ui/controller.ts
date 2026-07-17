// UI wiring: renders the log and the button states from the Store, serializes port access
// (the busy mutex), implements the two-click write confirm, and binds each button to an action.
// This is the ONLY module that touches the DOM event/model beyond the tiny helpers.

import type { App } from '../app.js';
import type { AppState } from '../state/store.js';
import type { TransportMode } from '../transport/types.js';
import { buttonEnablement } from './enablement.js';
import { $, copyText, downloadText } from '../util/dom.js';
import { dumpRegion, nameTest, readFirmware } from '../actions/diagnostics.js';
import { recoverPasswordAndUnlock, relock } from '../actions/password.js';
import { decodeFile, readAllAndDecode } from '../actions/program.js';
import { doCheckMode, doConnect, doDisconnect, doIdentify, doRestart, doStop } from '../actions/session.js';

// Buttons that never touch the serial port and so stay usable during an operation.
const ALWAYS_ON = ['abort', 'copylog', 'dllog', 'clearlog'];
// First click arms a write button; a second click within this window performs the write.
const ARM_MS = 10000;

type Action = (app: App) => Promise<void>;

export function wireUi(app: App): void {
  const logEl = $('#log');
  // One serial port, one conversation: this mutex stops a second button, clicked mid-read,
  // from interleaving on the port and eating the first operation's bytes.
  let busy = false;

  // ---- log view ----
  app.logger.onLine((msg, cls) => {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = msg + '\n';
    logEl.appendChild(s);
    logEl.scrollTop = logEl.scrollHeight;
  });

  // Label of the operation currently running (shown on the Stop button, e.g. "Stop program read").
  let busyLabel = '';
  const abortBtn = $<HTMLButtonElement>('#abort');

  // ---- button enablement + "do this next" glow, derived from state ----
  function render(s: Readonly<AppState>): void {
    const { enabled, next } = buttonEnablement(s);
    document.querySelectorAll<HTMLButtonElement>('button[id]').forEach((b) => {
      if (b.id in enabled) b.disabled = !enabled[b.id as keyof typeof enabled];
    });
    // The Stop button only exists to interrupt a running operation: enabled only while busy.
    abortBtn.disabled = !busy;
    if (!busy) abortBtn.textContent = 'Abort';
    document.querySelectorAll('button').forEach((b) => b.classList.toggle('next', b.id === next && !b.disabled));
    if (app.conn?.known) {
      const mem = app.conn.mem;
      const first = mem.regions[0];
      $<HTMLButtonElement>('#decode').textContent =
        mem.decode === 'legacy2460' ? '4 · Read program & decode' : '4 · Read program & save raw';
      $<HTMLInputElement>('#addr').value = first.base.toString(16).padStart(8, '0').toUpperCase();
      $<HTMLInputElement>('#len').value = String(first.len);
    }
  }
  app.store.subscribe(render);

  // ---- action plumbing ----
  function guard(fn: Action, label: string): () => Promise<void> {
    return async () => {
      if (busy) {
        app.log('Busy — wait for the current operation to finish (or press “Stop”).', 'err');
        return;
      }
      busy = true;
      busyLabel = label;
      // Clear any abort left set by a previous operation's Stop click, at the operation boundary.
      // ensureStopped() already clears it for the long-read ops, but the session ops (doStop,
      // doCheckMode, doIdentify, doRestart) bypass ensureStopped — without this reset a Stop during
      // a program read would leave abort=true so the next Check-mode's first transient glitch is
      // treated as fatal instead of retried.
      if (app.conn) app.conn.abort = false;
      document.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        if (!ALWAYS_ON.includes(b.id)) b.disabled = true;
      });
      abortBtn.disabled = false;
      abortBtn.textContent = 'Abort ' + label; // say what it's stopping
      try {
        await fn(app);
      } catch (e) {
        app.log(e instanceof Error ? e.message : String(e), 'err');
      } finally {
        busy = false;
        app.store.touch();
      }
    };
  }

  /** Bind a plain button id to a guarded action. `label` names the op for the Stop button. */
  function on(id: string, fn: Action, label: string): void {
    const run = guard(fn, label);
    $(`#${id}`).onclick = () => void run();
  }

  /** Two-click confirm for the commands that WRITE to the PLC. */
  function armWrite(id: string, fn: Action, label: string): void {
    const btn = $<HTMLButtonElement>(`#${id}`);
    const run = guard(fn, label);
    btn.onclick = () => {
      if (busy) {
        app.log('Busy — wait for the current operation to finish.', 'err');
        return;
      }
      if (btn.dataset.armed) {
        clearTimeout(Number(btn.dataset.tmr));
        delete btn.dataset.armed;
        btn.textContent = btn.dataset.label ?? btn.textContent;
        btn.classList.remove('armed');
        app.log('Confirmed — writing to the PLC…', 'ok');
        void run();
        return;
      }
      btn.dataset.label = btn.textContent ?? '';
      btn.dataset.armed = '1';
      btn.textContent = '⚠ CLICK AGAIN to write to the PLC';
      btn.classList.add('armed');
      app.log('⚠ This step WRITES to your PLC. Click the same button AGAIN within ' + ARM_MS / 1000 + 's to confirm — or wait and it cancels.', 'err');
      btn.dataset.tmr = String(
        setTimeout(() => {
          if (btn.dataset.armed) {
            delete btn.dataset.armed;
            btn.textContent = btn.dataset.label ?? btn.textContent;
            btn.classList.remove('armed');
            app.log('(write not confirmed in time — nothing was written)', 'mut');
          }
        }, ARM_MS),
      );
    };
  }

  // ---- connect (not guarded: there is no Connection yet) ----
  $<HTMLButtonElement>('#connect').onclick = () => {
    void (async () => {
      const btn = $<HTMLButtonElement>('#connect');
      btn.disabled = true;
      const pref = $<HTMLSelectElement>('#transport').value as TransportMode;
      try {
        await doConnect(app, pref);
      } finally {
        render(app.store.get());
      }
    })();
  };

  // ---- session / diagnostics ---- (label = what the Stop button says it's stopping)
  on('ident', doIdentify, 'identify');
  on('disconnect', doDisconnect, 'disconnect');
  on('restart', doRestart, 'restart');
  on('mode', doCheckMode, 'mode check');
  on('stop', doStop, 'STOP command');
  on('fw', readFirmware, 'firmware read');
  on('nametest', nameTest, 'name read');
  on('dump', dumpRegion, 'dump');
  on('decode', readAllAndDecode, 'program read');

  // ---- writes (armed) ----
  armWrite('unlock', recoverPasswordAndUnlock, 'unlock');
  armWrite('relock', relock, 're-lock');

  // ---- abort ---- (only meaningful while an operation is running)
  abortBtn.onclick = () => {
    if (!busy) return; // nothing to stop
    if (app.conn) app.conn.abort = true;
    app.log('Stopping ' + busyLabel + '…', 'mut');
  };

  // ---- decode a saved file ----
  $('#decfile').onclick = () => $<HTMLInputElement>('#binfile').click();
  $<HTMLInputElement>('#binfile').onchange = (e) => {
    void (async () => {
      const input = e.target as HTMLInputElement;
      const f = input.files?.[0];
      if (!f) return;
      const b = new Uint8Array(await f.arrayBuffer());
      decodeFile(app, b, f.name);
    })();
  };

  // ---- log toolbar ----
  $('#copylog').onclick = () => {
    void (async () => {
      const ok = await copyText(app.logger.text());
      app.log(ok ? '(log copied to clipboard)' : '(copy failed — select the log text and copy manually)', ok ? 'ok' : 'err');
    })();
  };
  $('#dllog').onclick = () => downloadText('logo_session.log', app.logger.text());
  $('#clearlog').onclick = () => {
    app.logger.clear();
    logEl.replaceChildren();
  };

  // ---- initial environment checks ----
  if (!('serial' in navigator) && !('usb' in navigator)) {
    app.log('This browser has neither Web Serial nor WebUSB. Use Chrome or Edge (desktop or Android). Safari/iOS support neither.', 'err');
  }
  if (location.protocol === 'file:') {
    $('#filenote').textContent = 'Opened as a local file — clipboard copy may be blocked; use Download log if Copy fails.';
  }
  render(app.store.get());
}
