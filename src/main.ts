// Entry point: build the Logger, Store, and Ui port, wire the App together, and bind the UI.

import { App, type Ui } from './app.js';
import { Logger } from './log.js';
import { Store } from './state/store.js';
import { $, downloadBytes } from './util/dom.js';
import { wireUi } from './ui/controller.js';

const logger = new Logger();
const store = new Store();

const ui: Ui = {
  input: (id) => $<HTMLInputElement>(`#${id}`).value,
  setNetlist: (t) => {
    $('#netlist').textContent = t;
  },
  setStatus: (t, cls) => {
    const el = $('#status');
    el.textContent = t;
    el.className = cls ?? 'mut';
  },
  setProgress: (p) => {
    const wrap = $('#progress');
    if (!p) {
      wrap.hidden = true;
      return;
    }
    wrap.hidden = false;
    const bar = $('#progressbar');
    const fill = $('#progressfill');
    const indeterminate = p.fraction == null;
    const pct = p.fraction == null ? 0 : Math.max(0, Math.min(100, Math.round(p.fraction * 100)));
    bar.classList.toggle('indeterminate', indeterminate);
    fill.style.width = indeterminate ? '' : pct + '%';
    bar.setAttribute('aria-valuenow', indeterminate ? '' : String(pct));
    const head = indeterminate ? p.label + ' — working…' : p.label + ' — ' + pct + '%';
    $('#progresstext').textContent = p.detail ? head + ' · ' + p.detail : head;
  },
  confirm: (m) => window.confirm(m),
  download: (filename, bytes) => downloadBytes(filename, bytes),
};

const app = new App(store, logger, ui);
wireUi(app);
