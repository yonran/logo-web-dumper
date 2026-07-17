// Tiny DOM helpers. Kept separate so the protocol/decoding layers never touch the DOM.

/** Query a required element; throws if the markup is missing it (a build-time bug). */
export function $<T extends HTMLElement = HTMLElement>(sel: string): T {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element: ${sel}`);
  return el;
}

/** Trigger a browser download of raw bytes. */
export function downloadBytes(name: string, bytes: Uint8Array): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
}

/** Trigger a browser download of a text file. */
export function downloadText(name: string, text: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = name;
  a.click();
}

/**
 * Copy text to the clipboard, with a fallback for non-secure contexts (e.g. `file://`)
 * where the async Clipboard API is unavailable.
 */
export async function copyText(t: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(t);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = t;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    document.body.removeChild(ta);
    return ok;
  }
}
