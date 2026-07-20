#!/usr/bin/env node
/// <reference types="node" />
// Command-line decoder: convert a saved LOGO! program dump (.bin) to a text netlist or a Mermaid
// diagram. It reuses the SAME pure decoders as the web UI (src/decode/*), so the CLI and the page
// always agree. Node's global types are referenced here explicitly because the browser build
// deliberately excludes them everywhere else.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decode0BA6, toMermaid } from './decode/ba6.js';
import { decodeCombined } from './decode/program.js';

export type Format = 'netlist' | 'mermaid';

const USAGE = `logo-decode — decode a saved LOGO! program dump to text or Mermaid

Usage:
  logo-decode <file.bin> [--mermaid | --netlist]

Options:
  -n, --netlist   Print the text netlist (default).
  -m, --mermaid   Print the Mermaid flowchart source.
  -h, --help      Show this help.

Input: the logo_<model>_full.bin address-span image (0BA6), or a legacy 2460-byte
0BA4/0BA5 combined dump. The program-only .bin cannot be decoded on its own — it
lacks the offset and anchor tables, so use the full image.
`;

function hint(bytes: Uint8Array): string {
  return (
    `not a full 0BA6 image (${bytes.length} bytes). Use the logo_<model>_full.bin ` +
    `(the address-span image that includes the offset and anchor tables), not the program-only .bin.`
  );
}

/** Render a dump's bytes to the requested format, or throw an Error with a helpful message. */
export function render(bytes: Uint8Array, format: Format): string {
  if (format === 'mermaid') {
    const m = toMermaid(bytes);
    if (m === null) throw new Error('Cannot render a Mermaid diagram: ' + hint(bytes) + ' (Mermaid is 0BA6-only.)');
    return m;
  }
  if (bytes.length === 2460) return decodeCombined(bytes); // legacy 0BA4/0BA5 combined layout
  const nl = decode0BA6(bytes);
  if (nl === null) throw new Error('Cannot decode a netlist: ' + hint(bytes));
  return nl;
}

function fail(message: string): void {
  process.stderr.write(message + '\n');
}

/** Parse argv, read the file, and print the result. Returns the process exit code. */
export function main(args: string[]): number {
  let format: Format = 'netlist';
  const files: string[] = [];
  for (const a of args) {
    if (a === '-m' || a === '--mermaid') format = 'mermaid';
    else if (a === '-n' || a === '--netlist') format = 'netlist';
    else if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE);
      return 0;
    } else if (a.startsWith('-')) {
      fail('Unknown option: ' + a + '\n\n' + USAGE);
      return 2;
    } else files.push(a);
  }
  if (files.length !== 1) {
    fail((files.length ? 'Give exactly one .bin file.' : 'No input file.') + '\n\n' + USAGE);
    return 2;
  }
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(files[0]));
  } catch (e) {
    fail('Cannot read ' + files[0] + ': ' + (e instanceof Error ? e.message : String(e)));
    return 1;
  }
  try {
    process.stdout.write(render(bytes, format) + '\n');
    return 0;
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

// Run only when invoked directly (node dist/cli.js …), not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
