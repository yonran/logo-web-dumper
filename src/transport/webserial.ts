// Web Serial (desktop Chrome/Edge). The OS driver configures the cable, so this is the most
// reliable path — we just open at 9600 8E1 and pump bytes into a buffer.

import type { Logger } from '../log.js';
import { id4 } from '../util/hex.js';
import { sleep } from '../util/async.js';
import { chipHint, type Transport } from './types.js';

export async function connectWebSerial(log: Logger): Promise<Transport> {
  // No filter: the serial-port chooser only lists serial adapters (never mice/webcams),
  // so filtering can only re-hide the user's cable — the exact bug we hit before.
  const port = await navigator.serial.requestPort();

  let info: SerialPortInfo = {};
  try {
    info = port.getInfo();
  } catch {
    info = {};
  }
  if (info.usbVendorId != null) {
    log.log(
      'selected serial port: ' +
        id4(info.usbVendorId) +
        ':' +
        id4(info.usbProductId ?? 0) +
        chipHint(info.usbVendorId),
      'ok',
    );
  } else {
    log.log('selected serial port: (no USB VID/PID reported — built-in or Bluetooth serial)', 'mut');
  }

  await port.open({ baudRate: 9600, dataBits: 8, parity: 'even', stopBits: 1 });
  const reader = port.readable!.getReader();
  let buf = new Uint8Array(0);
  // Background pump: append every chunk to `buf`; `read()` drains from the front.
  void (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) {
          const n = new Uint8Array(buf.length + value.length);
          n.set(buf);
          n.set(value, buf.length);
          buf = n;
        }
      }
    } catch {
      /* reader cancelled on close */
    }
  })();

  return {
    kind: 'Web Serial',
    async write(b) {
      const w = port.writable!.getWriter();
      await w.write(b);
      w.releaseLock();
    },
    async read(n, to = 1500) {
      const t = Date.now();
      while (buf.length < n && Date.now() - t < to) await sleep(15);
      const out = buf.slice(0, n);
      buf = buf.slice(out.length);
      return out;
    },
    async close() {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      try {
        await port.close();
      } catch {
        /* ignore */
      }
    },
  };
}
