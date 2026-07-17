// WebUSB (desktop or Android). Used when Web Serial doesn't enumerate the cable. Works on any
// platform with WebUSB; the trade-off is that WE configure the chip's registers (baud/parity)
// instead of the OS driver, per-chip. Show EVERY device and identify after, so an unknown-VID
// cable is never hidden.

import type { Logger } from '../log.js';
import { id4 } from '../util/hex.js';
import { sleep } from '../util/async.js';
import { chipHint, usbName, type Transport } from './types.js';

export async function connectWebUSB(log: Logger): Promise<Transport> {
  const known = await navigator.usb.getDevices();
  log.log(
    'previously-authorised devices: ' + (known.length ? known.map(usbName).join(', ') : '(none)'),
    'mut',
  );
  // The "show all" idiom is filters:[{}] — a list with ONE EMPTY filter object (matches
  // everything). filters:[] (an empty list) matches NOTHING and produces the misleading
  // "No compatible devices found", which is the opposite of what we want.
  const dev = await navigator.usb.requestDevice({ filters: [{}] });
  log.log('selected USB device: ' + usbName(dev) + chipHint(dev.vendorId), 'ok');
  log.log('  class ' + dev.deviceClass + '/' + dev.deviceSubclass + '/' + dev.deviceProtocol, 'mut');
  await dev.open();
  if (!dev.configuration) await dev.selectConfiguration(1);

  // Find an interface exposing bulk IN + OUT endpoints.
  let iface: USBInterface | undefined;
  let epIn = 0;
  let epOut = 0;
  for (const i of dev.configuration!.interfaces) {
    const a = i.alternate;
    const ins = a.endpoints.filter((e) => e.direction === 'in' && e.type === 'bulk');
    const outs = a.endpoints.filter((e) => e.direction === 'out' && e.type === 'bulk');
    if (ins.length && outs.length) {
      iface = i;
      epIn = ins[0].endpointNumber;
      epOut = outs[0].endpointNumber;
      break;
    }
  }
  if (!iface) throw new Error('No bulk endpoints found on this device');
  try {
    await dev.claimInterface(iface.interfaceNumber);
  } catch (e) {
    throw new Error(
      'claimInterface failed (' +
        (e instanceof Error ? e.message : String(e)) +
        '). Another driver may hold the device — on desktop, the OS serial driver has it ' +
        '(use Web Serial instead); on Android, close other apps using USB.',
    );
  }

  const vid = dev.vendorId;
  const cOut = (req: number, val: number, idx = 0, data?: BufferSource): Promise<USBOutTransferResult> =>
    dev.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request: req, value: val, index: idx },
      data,
    );
  const cIn = (req: number, val: number, idx: number, len: number): Promise<USBInTransferResult> =>
    dev.controlTransferIn(
      { requestType: 'vendor', recipient: 'device', request: req, value: val, index: idx },
      len,
    );

  // --- configure 9600 8E1 per chip ---
  if (vid === 0x10c4) {
    // CP210x
    log.log(
      'chip: CP210x — WebUSB driver NOT verified on hardware; if bytes are garbled, use desktop Web Serial instead.',
      'err',
    );
    await cOut(0x00, 0x0001); // IFC_ENABLE
    await cOut(0x1e, 0x0000, 0x0000, new Uint8Array([0x80, 0x25, 0, 0])); // SET_BAUDRATE 9600 LE
    await dev.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request: 0x1e, value: 0, index: 0 },
      new Uint8Array([0x80, 0x25, 0, 0]),
    );
    await cOut(0x03, 0x0820); // SET_LINE_CTL: 8 data, even parity, 1 stop
  } else if (vid === 0x1a86) {
    // CH340/CH341 — init mirrors Linux drivers/usb/serial/ch341.c
    log.log('chip: CH340/CH341', 'mut');
    // Read chip version; the baud-divisor register needs bit 7 set for version > 0x27.
    let ver = 0;
    try {
      const r = await cIn(0x5f, 0, 0, 2);
      if (r.data && r.data.byteLength) ver = r.data.getUint8(0);
    } catch {
      ver = 0;
    }
    log.log('  CH34x version 0x' + ver.toString(16), 'mut');
    await cOut(0xa1, 0, 0); // CH341_REQ_SERIAL_INIT
    // Baud 9600 @ 48MHz clock: ps=2, fact=0, div=78 → high=(0x100-78)=0xB2,
    // low=(fact<<2)|ps = 0x02, plus 0x80 when version>0x27 → wIndex 0xB282 (else 0xB202).
    const lo = 0x02 | (ver > 0x27 ? 0x80 : 0x00);
    await cOut(0x9a, 0x1312, (0xb2 << 8) | lo); // WRITE_REG divisor:prescaler
    // LCR = ENABLE_RX|ENABLE_TX|ENABLE_PAR|PAR_EVEN|CS8 = 0x80|0x40|0x08|0x10|0x03 = 0xDB
    await cOut(0x9a, 0x2518, 0x00db); // WRITE_REG LCR2:LCR (8 data, even parity, 1 stop)
    // Assert DTR+RTS. control=RTS(0x40)|DTR(0x20)=0x60 → ~control = 0xFF9F.
    await cOut(0xa4, 0xff9f, 0); // CH341_REQ_MODEM_CTRL
  } else if (vid === 0x0403) {
    // FTDI
    log.log(
      'chip: FTDI — WebUSB driver NOT verified on hardware; if bytes are garbled, use desktop Web Serial instead.',
      'err',
    );
    await cOut(0x00, 0x0000); // SIO_RESET
    await cOut(0x03, 0x4138); // SIO_SET_BAUD_RATE: 9600 (FT232 divisor 0x4138)
    // SIO_SET_DATA: bits0-7 data(8=0x08), bits8-10 parity(even=2 -> 0x0200), bits11-13 stop(1=0).
    // 8E1 = 0x0208.
    await cOut(0x04, 0x0208);
  } else {
    log.log(
      'chip: NO DRIVER for vendor ' +
        id4(vid) +
        ' — baud/parity are NOT configured, so bytes will be garbage on WebUSB.',
      'err',
    );
    log.log(
      '  Report ' +
        id4(vid) +
        ':' +
        id4(dev.productId) +
        ' to add support — OR just use desktop Web Serial, which needs no per-chip driver.',
      'err',
    );
  }

  let buf = new Uint8Array(0);
  const ftdi = vid === 0x0403;
  // Background pump. FTDI prepends 2 status bytes to every 64-byte packet; strip them.
  void (async () => {
    for (;;) {
      try {
        const r = await dev.transferIn(epIn, 64);
        if (r.data && r.data.byteLength) {
          let v = new Uint8Array(r.data.buffer);
          if (ftdi && v.length >= 2) v = v.slice(2);
          const n = new Uint8Array(buf.length + v.length);
          n.set(buf);
          n.set(v, buf.length);
          buf = n;
        }
      } catch {
        break;
      }
    }
  })();

  return {
    kind: 'WebUSB',
    async write(b) {
      await dev.transferOut(epOut, b as BufferSource);
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
        await dev.close();
      } catch {
        /* ignore */
      }
    },
  };
}
