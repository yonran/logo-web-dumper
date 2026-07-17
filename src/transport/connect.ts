// Transport selection. Picks Web Serial or WebUSB (honouring an explicit choice; auto prefers
// serial, which needs no per-chip driver) and returns an open Transport, or throws.

import type { Logger } from '../log.js';
import { connectWebSerial } from './webserial.js';
import { connectWebUSB } from './webusb.js';
import type { Transport, TransportMode } from './types.js';

export interface TransportCaps {
  serial: boolean;
  usb: boolean;
}

export function transportCaps(): TransportCaps {
  return { serial: 'serial' in navigator, usb: 'usb' in navigator };
}

/** Resolve `auto` to the concrete transport that will actually be used. */
export function resolveMode(pref: TransportMode, caps: TransportCaps): 'serial' | 'usb' | null {
  if (pref !== 'auto') return pref;
  return caps.serial ? 'serial' : caps.usb ? 'usb' : null;
}

export async function openTransport(
  mode: 'serial' | 'usb' | null,
  caps: TransportCaps,
  log: Logger,
): Promise<Transport> {
  if (mode === 'serial') {
    if (!caps.serial) throw new Error('This browser has no Web Serial. Switch Transport to WebUSB.');
    log.log('Connecting via Web Serial…', 'mut');
    return connectWebSerial(log);
  }
  if (mode === 'usb') {
    if (!caps.usb) throw new Error('This browser has no WebUSB.');
    log.log('Connecting via WebUSB…', 'mut');
    return connectWebUSB(log);
  }
  throw new Error('Neither Web Serial nor WebUSB is available in this browser.');
}
