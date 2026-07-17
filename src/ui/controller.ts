// UI wiring: renders the log and the button states from the Store, serializes port access
// (the busy mutex), implements the two-click write confirm, and binds each button to an action.
// This is the ONLY module that touches the DOM event/model beyond the tiny helpers.

import type { App } from '../app.js';
import type { AppState } from '../state/store.js';
import type { TransportMode } from '../transport/types.js';
import { $, copyText, downloadText } from '../util/dom.js';
import {
  blockDiag,
  dumpRegion,
  findMemoryMap,
  nameTest,
  probeAddressSpace,
  readFirmware,
} from '../actions/diagnostics.js';
import { recoverNoReneg, recoverPasswordAndUnlock, relock } from '../actions/password.js';
import { decodeFile, readAllAndDecode } from '../actions/program.js';
import { doCheckMode, doConnect, doIdentify, doRestart, doStop } from '../actions/session.js';

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

  // ---- button enablement + "do this next" glow, derived from state ----
  function render(s: Readonly<AppState>): void {
    const C = s.connected;
    const ST = C && s.stopped;
    const canUnlock = ST && s.protected !== false && !s.unlocked;
    const en: Record<string, boolean> = {
      connect: !C,
      stop: C,
      mode: C,
      ident: C,
      restart: C,
      fw: C,
      unlock: canUnlock,
      unlocknoreneg: canUnlock,
      decode: ST,
      dump: ST,
      nametest: ST,
      findmem: ST,
      probe: ST,
      blockdiag: ST,
      // Re-lock is safe whenever a password EXISTS or we unlocked this session — cross-session
      // by design, so a fresh session can re-lock a device left unprotected earlier.
      relock: ST && (s.unlocked || s.protected === true),
      abort: true,
      decfile: true,
      copylog: true,
      dllog: true,
      clearlog: true,
    };
    document.querySelectorAll<HTMLButtonElement>('button[id]').forEach((b) => {
      if (b.id in en) b.disabled = !en[b.id];
    });
    let next: string | null = null;
    if (!C) next = 'connect';
    else if (!s.stopped) next = 'stop';
    else if (s.protected === true && !s.unlocked) next = 'unlock';
    else if (!s.dumped) next = 'decode';
    else if (s.unlocked) next = 'relock';
    document.querySelectorAll('button').forEach((b) => b.classList.toggle('next', b.id === next && !b.disabled));
  }
  app.store.subscribe(render);

  // ---- action plumbing ----
  function guard(fn: Action): () => Promise<void> {
    return async () => {
      if (busy) {
        app.log('Busy — wait for the current operation to finish (or press “Stop”).', 'err');
        return;
      }
      busy = true;
      document.querySelectorAll<HTMLButtonElement>('button').forEach((b) => {
        if (!ALWAYS_ON.includes(b.id)) b.disabled = true;
      });
      try {
        await fn(app);
      } catch (e) {
        app.log(e instanceof Error ? e.message : String(e), 'err');
      } finally {
        busy = false;
        render(app.store.get());
      }
    };
  }

  /** Bind a plain button id to a guarded action. */
  function on(id: string, fn: Action): void {
    const run = guard(fn);
    $(`#${id}`).onclick = () => void run();
  }

  /** Two-click confirm for the commands that WRITE to the PLC. */
  function armWrite(id: string, fn: Action): void {
    const btn = $<HTMLButtonElement>(`#${id}`);
    const run = guard(fn);
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

  // ---- session / diagnostics ----
  on('ident', doIdentify);
  on('restart', doRestart);
  on('mode', doCheckMode);
  on('stop', doStop);
  on('fw', readFirmware);
  on('nametest', nameTest);
  on('findmem', findMemoryMap);
  on('probe', probeAddressSpace);
  on('blockdiag', blockDiag);
  on('dump', dumpRegion);
  on('decode', readAllAndDecode);

  // ---- writes (armed) ----
  armWrite('unlock', recoverPasswordAndUnlock);
  armWrite('unlocknoreneg', recoverNoReneg);
  armWrite('relock', relock);

  // ---- abort ----
  $('#abort').onclick = () => {
    if (app.conn) app.conn.abort = true;
    app.log('Stopping…', 'mut');
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
