// Entry point: build the Logger, Store, and Ui port, wire the App together, and bind the UI.

import { App, type Ui } from './app.js';
import { Logger } from './log.js';
import { Store } from './state/store.js';
import { $, copyText, downloadBytes } from './util/dom.js';
import { wireUi } from './ui/controller.js';

const logger = new Logger();
const store = new Store();

/**
 * Build a mermaid.live link for a diagram, entirely in the browser: the source is deflated with the
 * native CompressionStream and packed into the URL FRAGMENT (`#pako:…`). The fragment is never sent
 * to a server on navigation, so nothing is uploaded — mermaid.live's own JS reads it client-side.
 * Returns null if CompressionStream is unavailable (older browser); the copy button still works.
 */
async function mermaidLiveUrl(code: string): Promise<string | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const state = { code, mermaid: '{\n  "theme": "default"\n}', autoSync: true, rough: false, updateDiagram: true };
  const bytes = new TextEncoder().encode(JSON.stringify(state));
  const compressed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer());
  let bin = '';
  for (const b of compressed) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return 'https://mermaid.live/edit#pako:' + b64;
}

let currentMermaid: string | null = null;

const ui: Ui = {
  input: (id) => $<HTMLInputElement>(`#${id}`).value,
  setNetlist: (t) => {
    $('#netlist').textContent = t;
    $('#netlisttools').hidden = !t.trim(); // show "Copy blocks" only when there is a listing
  },
  setDiagram: (mermaid) => {
    currentMermaid = mermaid;
    const row = $('#diagramrow');
    const link = $<HTMLAnchorElement>('#diagramlink');
    if (!mermaid) {
      row.hidden = true;
      link.removeAttribute('href');
      return;
    }
    row.hidden = false; // reveal now; the copy button works immediately, the link resolves async
    link.textContent = 'Building link…';
    link.removeAttribute('href');
    void mermaidLiveUrl(mermaid).then((url) => {
      if (currentMermaid !== mermaid) return; // a newer decode superseded this one
      if (url) {
        link.href = url;
        link.textContent = 'Open diagram in mermaid.live ↗';
        link.style.display = '';
      } else {
        link.style.display = 'none'; // no CompressionStream — fall back to Copy Mermaid
      }
    });
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
  showPassword: (text) => {
    // A non-modal panel: setting it empty hides it via `#pwout:empty { display:none }`.
    $('#pwout').textContent = text;
  },
  download: (filename, bytes) => downloadBytes(filename, bytes),
};

const app = new App(store, logger, ui);
wireUi(app);

// Copy a value to the clipboard, briefly flashing the button so the click is acknowledged.
function copyButton(btn: HTMLButtonElement, get: () => string | null): void {
  btn.onclick = () => {
    const text = get();
    if (!text) return;
    const label = btn.textContent ?? 'Copy';
    void copyText(text).then((ok) => {
      btn.textContent = ok ? 'Copied ✓' : 'Copy failed';
      setTimeout(() => {
        btn.textContent = label;
      }, 1200);
    });
  };
}
copyButton($<HTMLButtonElement>('#copyblocks'), () => $('#netlist').textContent);
copyButton($<HTMLButtonElement>('#copymermaid'), () => currentMermaid);
