// Session-replay consistency check. Each captured real-hardware session in test/fixtures/*.session
// is replayed against a FakeDevice built from its `# device:` header, asserting the fake produces
// EXACTLY the recorded response to each request. This is how we keep the fakes honest over time:
// drop a downloaded session log into test/fixtures/ and this test proves the fake still matches it
// (or fails loudly if a fake/protocol change drifts away from what real hardware did).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { FakeDevice, type FakeDeviceConfig } from './helpers/fake-device.js';

// Fixtures are source files (not compiled into build/), so resolve them from the repo root,
// which is the cwd when `npm test` runs.
const fixturesDir = join(process.cwd(), 'test', 'fixtures');

interface Exchange {
  line: number;
  request: number[];
  response: number[];
}
interface Session {
  config: FakeDeviceConfig;
  exchanges: Exchange[];
}

function hexTokens(s: string): number[] {
  const out: number[] = [];
  for (const tok of s.trim().split(/\s+/)) {
    if (/^[0-9a-fA-F]{2}$/.test(tok)) out.push(parseInt(tok, 16));
    else break; // stop at the first non-hex token (a "(note)")
  }
  return out;
}

function parseConfig(line: string): FakeDeviceConfig {
  const cfg: FakeDeviceConfig = {};
  for (const m of line.matchAll(/(\w+)=([0-9a-fA-Fx]+)/g)) {
    const key = m[1];
    const val = m[2];
    if (key === 'identNo' || key === 'mode') cfg[key] = parseInt(val, 16);
    else if (key === 'passwordExists' || key === 'leaksCleartext' || key === 'blockReadsWork') cfg[key] = val === '1' || val === 'true';
  }
  return cfg;
}

function parseSession(text: string): Session {
  let config: FakeDeviceConfig = {};
  const exchanges: Exchange[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const dev = /^#\s*device:\s*(.*)$/.exec(raw);
    if (dev) {
      config = parseConfig(dev[1]);
      continue;
    }
    if (raw.trimStart().startsWith('#')) continue;
    if (!raw.includes('→') || !raw.includes('←')) continue;
    const [left, right] = raw.split('←');
    const request = hexTokens(left.replace('→', ''));
    const response = /\(nothing\)/.test(right) ? [] : hexTokens(right);
    exchanges.push({ line: i + 1, request, response });
  }
  return { config, exchanges };
}

const files = readdirSync(fixturesDir).filter((f) => f.endsWith('.session'));

for (const file of files) {
  test(`fake reproduces recorded session: ${file}`, async () => {
    const { config, exchanges } = parseSession(readFileSync(join(fixturesDir, file), 'utf8'));
    assert.ok(exchanges.length > 0, 'no exchanges parsed');
    const dev = new FakeDevice(config);
    for (const ex of exchanges) {
      await dev.write(Uint8Array.from(ex.request));
      // Read exactly the recorded number of bytes, then confirm nothing extra was queued.
      const got = [...(await dev.read(ex.response.length))];
      const trailing = [...(await dev.read(8))];
      assert.deepEqual(
        got,
        ex.response,
        `line ${ex.line}: request ${ex.request.map((b) => b.toString(16)).join(' ')}`,
      );
      assert.deepEqual(trailing, [], `line ${ex.line}: fake queued unexpected trailing bytes`);
    }
  });
}
