# LOGO! Web Dumper

Read and decode the circuit program from a **Siemens LOGO! 0BA5 / 0BA6** small PLC — entirely in your browser, no install, no Siemens software. (The device is auto-detected on connect; the 0BA5 path is implemented but so far only verified against the emulator, not real 0BA5 hardware.)

**Live tool: https://yonran.github.io/logo-web-dumper/**

## Why

Siemens' LOGO!Soft Comfort *Demo* can't transfer programs (the Transfer menu is disabled without a paid license). This tool talks the LOGO! **PG serial protocol** directly through your USB programming cable, so you can dump and read a 0BA6 program for free.

- **Desktop (Chrome/Edge):** uses the Web Serial API — plug the cable in and go.
- **Android (Chrome):** uses WebUSB through a USB-OTG adapter (Web Serial isn't available on Android, WebUSB is).

## What it does

1. **Connect** to the cable (Web Serial or WebUSB).
2. **Identify** the device (`0x21` handshake → confirms 0BA6, IdentNo `0x43`/`0x44`/`0x45`).
3. **Self-test** by reading the program name — confirms the address mapping before you trust a dump.
4. **Dump** the raw program memory to a `.bin`.
5. **Decode** the pointer table + I/O wiring + program into a readable **netlist** (e.g. `B001 = OR(B002, I2)`, `Q1 = B001`).

## Status / accuracy

- Basic gates (AND/OR/NOT/NAND/NOR/XOR + edge variants) and output/marker wiring are decoded **exactly** (validated against the reverse-engineered spec).
- Special functions (timers, counters, message text) are **named** with their raw bytes shown; numeric parameters aren't interpreted yet.
- The USB-serial chip drivers for the WebUSB (Android) path (CP210x / CH340 / FTDI) are best-effort and untested on all silicon; the desktop Web Serial path is robust.
- **Requires STOP mode** on the device for memory reads.

## Development

The app is TypeScript in `src/`, compiled to ES modules in `dist/` (no bundler; the browser
loads the modules natively). `index.html` references `./dist/main.js`.

```sh
npm install --ignore-scripts   # dev deps only (typescript, eslint); no runtime deps
npm run typecheck              # tsc --noEmit
npm run lint                   # eslint (js + typescript-eslint recommendedTypeChecked)
npm run build                 # tsc → dist/
```

To run locally, build and serve the repo root over HTTP (module scripts need `http(s)://`, not
`file://`), e.g. `python3 -m http.server` then open `http://localhost:8000/`.

Module layout: `transport/` (Web Serial + WebUSB byte pipes) → `pg/` (the `Connection` class,
which owns the transport and is the only thing that speaks the PG protocol) → `actions/`
(operations that orchestrate a Connection + the `state/` store) → `ui/` (DOM wiring). Protocol
and program-format facts live in `PROTOCOL.md`; the investigation log is `LAB-NOTEBOOK.md`.

Deployment is automatic: pushing to `main` runs `.github/workflows/pages.yml`, which builds and
publishes to GitHub Pages. `dist/` is not committed.

### Recording hardware sessions

Real device sessions are saved as fixtures in `test/fixtures/*.session` and replayed against the
fake by `test/session-replay.test.ts`, which asserts the fake produces the exact recorded bytes
— so the fakes can't silently drift away from what real hardware did. To capture a new session:

1. Run the tool against a device, then press **Download log** (or **Copy log**).
2. Save it as `test/fixtures/<device>-<date>.session`.
3. Add a header line describing the device, e.g.
   `# device: identNo=45 mode=42 passwordExists=1 leaksCleartext=0 blockReadsWork=0`
   (hex for `identNo`/`mode`; `1`/`0` for the flags). The replay test parses `→ … ← …` lines and
   ignores everything else. Per-byte region reads aren't individual log lines, so they're skipped.
4. `npm test` — the new session is picked up automatically. A failure means the fake and the real
   capture disagree; reconcile the fake (and PROTOCOL.md) with the observation.

## Sources & credits

Siemens does not publicly document the PG protocol or the program format; everything here rests on community reverse-engineering. Full annotated documentation with per-fact citations is in **[PROTOCOL.md](PROTOCOL.md)**.

- **[brickpool/logo](https://github.com/brickpool/logo)** — Arduino library implementing the PG protocol for 0BA4/0BA5/0BA6. The 0BA6 connect/read sequences here were cross-checked against its [`src/LogoPG.cpp`](https://github.com/brickpool/logo/blob/master/src/LogoPG.cpp).
  - [PG-Protocol wiki](https://github.com/brickpool/logo/wiki/PG-Protocol) — message framing, Read Block `0x05`, addressing, checksum.
  - [0BA5-Dekodierung wiki](https://github.com/brickpool/logo/wiki/0BA5-Dekodierung) — connector encoding, GF/SF opcodes, pointer table, block format.
- **[NI LabVIEW forum thread](https://forums.ni.com/t5/LabVIEW/LOGO-PLC-driver-based-on-LabVIEW/td-p/877701)** — SNATAX (0BA6 data monitoring/control/info) and cacalderon (0BA5, DE-9 cable pinout).
- **[amobbs thread (neiseng)](https://www.amobbs.com/thread-3705429-1-1.html)** — 0BA5 data address space, password security, cyclic read.
- **Web APIs** — [Web Serial API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API) (desktop) and [WebUSB API](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API) (Android).
- **Why the free demo can't do this** — Siemens [LOGO!Soft Comfort V9 Demo](https://support.industry.siemens.com/cs/document/110002070/) disables program transfer; the full license (order `6ED1058-0BA08-0YA1`) is required.

This project **reimplements** the protocol and block format for the browser; it does not copy code from the above.

## Not affiliated with Siemens

Siemens and LOGO! are trademarks of Siemens AG. This is an independent, unofficial tool. Use at your own risk.

## License

Public domain — [The Unlicense](LICENSE). Do anything you want with it; no attribution required (though the reverse-engineering sources above appreciate credit).
