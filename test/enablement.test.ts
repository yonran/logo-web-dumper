// Button enablement + "do this next" glow, for representative states of the workflow.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUTTON_IDS, buttonEnablement } from '../src/ui/enablement.js';
import type { AppState } from '../src/state/store.js';

const base: AppState = { connected: false, stopped: false, protected: null, unlocked: false, dumped: false };
const s = (patch: Partial<AppState>): AppState => ({ ...base, ...patch });

test('disconnected: only connect + always-on enabled; connect glows', () => {
  const { enabled, next } = buttonEnablement(base);
  assert.equal(enabled.connect, true);
  assert.equal(enabled.stop, false);
  assert.equal(enabled.decode, false);
  assert.equal(enabled.unlock, false);
  assert.equal(enabled.relock, false);
  assert.equal(enabled.copylog, true);
  // `abort` is not state-driven (it's runtime/busy-driven), so it isn't in the enablement map.
  assert.equal('abort' in enabled, false);
  assert.equal(next, 'connect');
});

test('connected, not stopped: stop enabled + glows; reads still disabled', () => {
  const { enabled, next } = buttonEnablement(s({ connected: true }));
  assert.equal(enabled.stop, true);
  assert.equal(enabled.mode, true);
  assert.equal(enabled.ident, true);
  assert.equal(enabled.restart, true);
  assert.equal(enabled.fw, false); // firmware read needs STOP
  assert.equal(enabled.decode, false);
  assert.equal(enabled.unlock, false);
  assert.equal(next, 'stop');
});

test('stopped, protection unknown: reads + unlock enabled; relock off; decode glows', () => {
  const { enabled, next } = buttonEnablement(s({ connected: true, stopped: true }));
  assert.equal(enabled.decode, true);
  assert.equal(enabled.nametest, true);
  assert.equal(enabled.dump, true);
  assert.equal(enabled.fw, true); // firmware read enabled once stopped
  assert.equal(enabled.unlock, true); // protected !== false
  assert.equal(enabled.relock, false); // protected is null, not unlocked
  assert.equal(next, 'decode');
});

test('stopped, protected: unlock enabled + glows; relock enabled', () => {
  const { enabled, next } = buttonEnablement(s({ connected: true, stopped: true, protected: true }));
  assert.equal(enabled.unlock, true);
  assert.equal(enabled.relock, true);
  assert.equal(next, 'unlock');
});

test('stopped, not protected: unlock disabled; decode glows', () => {
  const { enabled, next } = buttonEnablement(s({ connected: true, stopped: true, protected: false }));
  assert.equal(enabled.unlock, false);
  assert.equal(enabled.relock, false);
  assert.equal(next, 'decode');
});

test('unlocked but not dumped: unlock off, relock on, decode still glows', () => {
  const { enabled, next } = buttonEnablement(s({ connected: true, stopped: true, protected: true, unlocked: true }));
  assert.equal(enabled.unlock, false);
  assert.equal(enabled.relock, true);
  assert.equal(next, 'decode');
});

test('unlocked and dumped: relock glows', () => {
  const { enabled, next } = buttonEnablement(
    s({ connected: true, stopped: true, protected: true, unlocked: true, dumped: true }),
  );
  assert.equal(enabled.relock, true);
  assert.equal(next, 'relock');
});

test('every declared button id has a boolean enablement entry', () => {
  const { enabled } = buttonEnablement(base);
  for (const id of BUTTON_IDS) assert.equal(typeof enabled[id], 'boolean', `missing: ${id}`);
});
