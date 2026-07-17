// Entry point: build the Logger, Store, and Ui port, wire the App together, and bind the UI.

import { App, type Ui } from './app.js';
import { Logger } from './log.js';
import { Store } from './state/store.js';
import { $ } from './util/dom.js';
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
};

const app = new App(store, logger, ui);
wireUi(app);
