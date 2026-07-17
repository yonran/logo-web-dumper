# LOGO! 0BA6 PG Protocol & Program Format

Documentation of everything this tool relies on to read and decode a **Siemens LOGO! 0BA6** program over the serial PG interface. Siemens does not publish this; all of it comes from community reverse-engineering (see [Sources](#sources)). Every section notes where its facts come from.

> **Disclaimer.** Independent, unofficial. Siemens and LOGO! are trademarks of Siemens AG. Reverse-engineered facts may be incomplete or wrong for your specific device/firmware. No warranty. See [LICENSE](LICENSE) (public domain).

---

## 1. Device identification

The part number `6ED1052-1FB00-0BA6` denotes the LOGO! **0BA6** generation. 0BA0–0BA6 use a 4-wire RS-232-compatible serial PG interface; 0BA7/0BA8 moved to Ethernet and do **not** use this protocol.

Source: brickpool/logo PG-Protocol wiki (Introducing PG Protocol); Siemens LOGO! ordering data.

---

## 2. Physical layer

| Property | Value |
|---|---|
| Interface | 4-wire RS-232 compatible (TTL levels translated by the cable's active dongle) |
| PC connector | DE-9 male (DTE) |
| LOGO! connector | DE-9 female (DCE) |
| Baud rate | 9600 |
| Framing | 1 start, 8 data (LSB first), **even parity**, 1 stop (**8E1**) |
| Flow | RTS/DTR held high (used to power the plug electronics) |

Pinout: RxD pin 2, TxD pin 3, DTR pin 4, GND pin 5, RTS pin 7.

The cable presents to the OS as a USB-serial port (FTDI / CP210x / CH340 depending on genuine vs clone). This tool configures 9600 8E1 either through the Web Serial API (desktop) or by driving the chip's control endpoints over WebUSB (Android).

Source: brickpool/logo PG-Protocol wiki (The Serial Transmission Mode); DE-9 pinout originally from cacalderon on the NI LabVIEW forum.

---

## 3. PG protocol basics

Master–slave: the PC (DTE) issues queries, the LOGO! (DCE) responds. Command codes are `0x01`–`0x55`. A normal response starts with the acknowledgment byte `0x06` (`ACK`); an error response is `0x15` (`NOK`) followed by an exception code.

### 3.1 Connection request (0BA6)

```
PC  → 21
LOGO← 06 55 <..> <IdentNo>      (4 bytes; first is ACK, last is the device ident)
```

> **Observed on real hardware (0BA6.ES10, WebUSB/CH340):** the reply is `06 03 21 45`, not
> `06 55 <..> <ident>` — i.e. ACK, `0x03`, the echoed command byte `0x21`, then IdentNo `0x45`.
> The `06 55 …` form above is from the brickpool wiki; the ES10 differs in bytes 1–2. Either
> way the **IdentNo is byte[3]**, which is all this tool reads, so identification is unaffected.

IdentNo values:

| IdentNo | Device | Address width |
|---|---|---|
| `0x40` | 0BA4 | 2 bytes (16-bit) |
| `0x42` | 0BA5 | 2 bytes (16-bit) |
| `0x43` | 0BA6 | **4 bytes (32-bit)** |
| `0x44` | 0BA6.ES3 | 4 bytes |
| `0x45` | 0BA6.ES10 | 4 bytes |

**0BA5 vs 0BA6 detection (both supported).** 0BA5 does **not** answer the `0x21` request, so the tool falls back to a 2-byte Read Byte at the ident register `0x1F02` (`02 1F 02` → `06 03 1F 02 <ident>`); IdentNo `0x42` ⇒ 0BA5. Once detected, the two devices differ only in **address width** (0BA6 = 4 bytes, 0BA5 = 2 bytes) and the `0xFF` page (0BA6 pages addresses ≥ 0x1F00; 0BA5 has no page). The 0BA5 wire address is just the low 16 bits of the 0BA6-canonical address, so the same constants serve both. *(0BA5 path is implemented but unverified on real 0BA5 hardware.)*

Source: brickpool/logo `src/LogoPG.cpp` — `LOGO6_CR = {0x21}`, `LogoConnect()`, and the IdentNo switch in `NegotiatePduParameters()`.

### 3.2 Read Block — command `0x05`

Reads binary memory. This is the workhorse for dumping.

```
Query:    05  <address>  <count_hi> <count_lo>
          address = 4 bytes big-endian on 0BA6 (2 bytes on 0BA4/0BA5)
          count   = 2 bytes big-endian, up to ~3000

Response: 06  <data … count bytes …>  <xor>
          xor = XOR of all data bytes (checksum8)
```

The LOGO! sends `0x06` immediately on receiving the `0x05` byte, then streams the data, then one XOR checksum byte. This tool verifies the XOR.

> ⚠️ **`0x06` here does not mean success.** The spec is explicit: *"The LOGO! sends an response (normally Ack `06`) immediately after receiving the command code `05`"* — i.e. before the address has even been parsed, so that a large read cannot time out the DTE. A rejection therefore arrives **after** the `0x06`, as a 2-byte `15 <code>` exception where the data block was expected. Code that treats `0x06` as "read succeeded" will happily hand an error response to its decoder. Observed on real hardware (0BA6.ES10): `→ 05 00 ff 0e e8 07 d0` … `← 06` then `15 03`.

Source: brickpool/logo PG-Protocol wiki (Read Block Command 05, incl. the note on the immediate ACK); `ReadBlock()` in `src/LogoPG.cpp` (4-byte address path, XOR loop).

> Note: `ReadBlock` is invoked exactly **once** in the reference library — `ReadBlock(ADDR_PWD_R_MEM, 10, …)`, i.e. 10 bytes at `0x00FF0566`. Every other documented access uses single-byte `ReadByte`. Block reads of the program area are not exercised by any known working implementation.

### 3.2a Exception response — and the Restart trap (`0x22`)

```
Response: 15  <code>          ← two bytes, that's the whole message
```

| Code | Meaning |
|---|---|
| `01` | Device busy |
| `02` | Device timeout — resource unavailable |
| `03` | **Illegal access** — read across the border (bad address or length) |
| `04` | Parity / overflow / telegram error |
| `05` | Unknown command — mode not supported |
| `06` | XOR check incorrect |
| `07` | Simulation error |

> 🔴 **On 0BA6 a single exception latches the session.** Per the spec: *"the execution of further commands is no longer possible after an error … Additional commands are always answered with an exception code … To restart the communication (after an exception response), the Restart command `22` is used."*
>
> The wedged state **survives closing and reopening the serial port** — only `0x22` or a power cycle clears it. So one bad address makes every subsequent read fail with `15 03` *regardless of whether that later address was valid*, and a stale `15 03` can still be sitting in the buffer on the next connect. Any diagnosis made without first sending `0x22` is unreliable.

```
PC → 22        LOGO! → 06
```

This tool sends `0x22` on connect and automatically after every exception.

Source: brickpool/logo PG-Protocol wiki ch.4 "Restart `22`" and ch.5 exception codes; `CpuError()` / `cpuCode*` in `src/LogoPG.cpp`.

### 3.2b Read Byte — command `0x02`

```
Query:    02  <address>                      (4 bytes on 0BA6)
Response: 06  03  <address echoed, 4 bytes>  <data byte>
```

Self-validating, because the LOGO! echoes the address back. Preferred for probing.

Source: PG-Protocol wiki ch.2 "Read Byte Command 02"; `ReadByte()` in `src/LogoPG.cpp`.

### 3.3 STOP and operating mode (needed before reading memory)

```
STOP:   PC → 55 12 12 AA     LOGO! → 06
START:  PC → 55 18 18 AA     LOGO! → 06
MODE:   PC → 55 17 17 AA     LOGO! → 06 <mode>
```

| Mode byte | Meaning |
|---|---|
| `01` | RUN |
| `20` | RUN_P (parameter mode) |
| `42` | STOP |

Memory reads (and firmware/clock reads) require STOP. Rather than assuming, query the mode with `55 17 17 AA` and check for `06 42`.

> **Observed on real hardware (0BA6.ES10):** sending `55 12 12 AA` to a device **already in
> STOP** produced **no response** — only a real RUN→STOP transition appears to be acknowledged
> with `06`. This is harmless here (the tool queries the mode with `55 17 17 AA` afterwards and
> confirms STOP regardless), but it means an absent `06` after the STOP command is not itself an
> error. Inferred from a single observation of an already-stopped device.

Source: brickpool/logo `src/LogoPG.cpp` — `LOGO_STOP` / `LOGO_START` / `LOGO_MODE`, `GetPlcStatus()`, `RecvControlResponse()`; PG-Protocol wiki "Memory Access".

### 3.4 Password protection and cleartext recovery

If the circuit program is password-protected, the program area cannot be read: on a 0BA6.ES10 `Read Block` returns `15 03` (illegal access) and `Read Byte` returns `0x00` for every protected byte (it does **not** fault). Check first:

```
Read Byte 0x00FF48FF  →  0x40 = password set,  0x00 = none
Read Byte 0x00FF1F00  →  0x04   (magic, sanity)
Read Byte 0x00FF1F01  →  0x00   (magic, sanity)
```

**The 0BA6 stores the password in cleartext and it is recoverable from the device.** The sequence is what LOGO!Soft Comfort itself does — **verified by decompiling LSC V8.0** (`DE.siemens.ad.logo.model.hardware.Modular0`, methods `isPWProtected` / `uploadPassword` / `checkPassword` / `clearPasswordOnLogo`, with `getAdress` mapping the symbolic addresses):

```
Read  0x00FF48FF                 ← password flag (isPWProtected)
Read  0x00FF0566 .. 0x00FF056F   ← 10-byte cleartext password (uploadPassword, stop at first 0)
                                   (Read Byte on 0BA6.ES10; Read Block is rejected)
[compare entered vs stored IN THE PC — no password is ever sent to the device]
Write Byte 0x00FF4800 = 0x00     ← clear protection (clearPasswordOnLogo). THE UNLOCK WRITE.
```

Verified LSC addresses (`getAdress` returns the 16-bit value; the 0BA6 32-bit form prepends `0x00FF`):

| Symbolic (LSC) | 16-bit | 0BA6 | Role |
|---|---|---|---|
| `ADR_PASSWORD_FLAG` | `0x48FF` | `0x00FF48FF` | read: password present? |
| `ADR_PASSWORD` | (`0x0566`) | `0x00FF0566` | read: 10-byte cleartext |
| `ADR_CLEAR_PASSWORD_ACTIVE` | `0x4800` | `0x00FF4800` | write 0 → **clear protection (unlock)** |
| `ADR_SET_PASSWORD_ACTIVE` | `0x4801` | `0x00FF4801` | write 0 → **set protection (re-lock)** |

> ⚠️ **Correction.** Earlier versions of this tool wrote `0x00FF4740` to unlock, taken from
> brickpool's `LogoPG.cpp` (`ADDR_PL_W_LEVEL1`). That is **wrong**: brickpool's protection-level
> labels don't match what LSC does — LSC clears protection by writing `0` to **`0x4800`** (which
> brickpool mislabels as "level 2 read protection") and re-locks with **`0x4801`**. The `0x4740`
> write was ACK'd on the 0BA6.ES10 but never opened reads, consistent with it being the wrong
> register. This tool now writes `0x4800` / `0x4801`.

**Safety of this write:**
- It changes a protection register, not program memory. **Non-destructive**: the program and the stored password are untouched (LSC reads the password *before* this write, and the program *after*). The only command that erases the program/password is Clear Program `0x20`, which is never sent.
- It is **reversible**: writing `0x00` to `0x00FF4801` re-sets protection (`clearPasswordOnLogo`'s paired setter). `0x48FF` only reports whether a password exists, not the level.

> This is password *recovery from your own hardware*, exploiting the 0BA6's cleartext storage — legitimate for a device you own, not a way around someone else's protection.

Source: **LOGO!Soft Comfort V8.0 bytecode** (`Modular0.getAdress` → `ADR_CLEAR_PASSWORD_ACTIVE = 0x4800`, `ADR_SET_PASSWORD_ACTIVE = 0x4801`, `ADR_PASSWORD_FLAG = 0x48FF`; `checkPassword` does a local `String.equals`, sending nothing to the device). Cross-referenced with brickpool/logo `src/LogoPG.cpp` (whose `0x4740` unlock is not what LSC uses). Verified against real hardware (0BA6.ES10): `0x00FF48FF = 0x40`.

---

## 4. Address map (0BA6)

**The 0BA6 address expansion is CONDITIONAL — verified from LSC `Logo6.getAdress`:** it takes the base 16-bit address and ORs the `0xFF0000` page onto it **only if the address is ≥ `0x1F00`**. Everything below `0x1F00` stays a **bare** 16-bit value, transmitted as a 4-byte address `0x0000____`.

```java
addr = super.getAdress(id);         // base 16-bit
if (addr >= 0x1F00) addr |= 0xFF0000;   // page only the high addresses
```

So the program/password-store regions are **bare**, and only the system registers get the `0x00FF` page:

| Region | base | 0BA6 4-byte addr | Bytes | Meaning |
|---|---|---|---|---|
| Password store | `0566` | **`0x00000566`** | 10 | cleartext password |
| Program name | `0570` | **`0x00000570`** | 16 | ASCII name |
| Pointer table | `0C14` | **`0x00000C14`** | 260 | 130 × 16-bit block pointers |
| Output/marker wiring | `0E20` | **`0x00000E20`** | ~200 | Q/M/AQ/X wiring |
| Program memory | `0EE8` | **`0x00000EE8`** | 2000 | the blocks |
| Password exists | `48FF` | `0x00FF48FF` | 1 | `0x40` = yes (≥0x1F00 → paged) |
| Magic / ident / fw | `1F00`–`1F08` | `0x00FF1F00`+ | — | ≥0x1F00 → paged |
| Clear / set protection | `4800`/`4801` | `0x00FF4800/4801` | 1 | ≥0x1F00 → paged |

> 🔴 **Correction (this is the big one).** Earlier versions of this tool put the `0x00FF` page on
> **every** address, so it read the program/password at `0x00FF0566` / `0x00FF0EE8` — the WRONG
> addresses. Those are below `0x1F00`, so LSC addresses them **bare** (`0x00000566` / `0x00000EE8`).
> This is exactly why every program/password read returned zeros while the ≥`0x1F00` system
> registers (`48FF`, `1F00`, `4800`) worked. The tool now uses the bare addresses.

Source: LOGO!Soft Comfort V8.0 bytecode — `DE.siemens.ad.logo.model.hardware.Logo6.getAdress` (the `addr >= 0x1F00 ? addr | 0xFF0000 : addr` rule).

Source: 0BA5 addresses from brickpool/logo 0BA5-Dekodierung wiki (Appendix A / Adressübersicht) and PG-Protocol wiki (Appendix A). 0BA6 `0x00FF____` prefix from the `ADDR_*` constants in `src/LogoPG.cpp`.

---

## 5. Program format

### 5.1 Pointer table (`0x0C14`, 260 bytes)

130 little-endian 16-bit pointers, one per possible block B001–B130. Each pointer is an **offset from `0x0E20`**; `0xFFFF` means the block is unused. Block *N* starts in program memory at `0x0E20 + pointer[N-1]`. Since program memory begins at `0x0EE8` (= `0x0E20 + 0x00C8`), the offset into a program-memory buffer is `pointer − 0x00C8`. The first block's pointer is `0x00C8` (or `0xFFFF` if the program is empty).

Source: brickpool/logo 0BA5-Dekodierung wiki (Verweis auf Blöcke, `0C14`).

### 5.2 Connector encoding (16-bit word at any block/output input)

Each input references a signal as a little-endian 16-bit word:

- **Block reference:** high bit set. `HiByte & 0x80` ⇒ block; `LoByte` in `0x0A`–`0x8C` = B001–B130 (`block = LoByte − 9`). `HiByte` bit 6 (`0x40`) = **negated** input (`0x80` normal, `0xC0` negated).
- **Terminal / constant:** `HiByte = 0x00` (or `0x40` if negated), `LoByte`:

| LoByte | Signal |
|---|---|
| `00`–`17` | I1–I24 (digital in) |
| `30`–`3F` | Q1–Q16 (digital out) |
| `50`–`67` | M1–M24 (markers) |
| `80`–`87` | AI1–AI8 (analog in) |
| `92`–`97` | AM1–AM6 (analog markers) |
| `A0`–`A3` | C▲ C▼ C◄ C► (cursor keys) |
| `B0`–`B7` | S1–S8 (shift-register bits) |
| `FC` | Float |
| `FD` | hi (logic 1) |
| `FE` | lo (logic 0) |
| `FF` | unused |

Source: brickpool/logo 0BA5-Dekodierung wiki (Konstanten und Klemmen – Co; Darstellung am Verknüpfungseingang).

### 5.3 Output / marker wiring (`0x0E20`, 200 bytes)

Fixed 20-byte records: `80 00` + eight 16-bit input words + `FF FF`. Each word is one output terminal's source (or `FFFF`). Groups:

| Start | Terminals | Records |
|---|---|---|
| `0E20` | Q1–Q16 | 2 |
| `0E48` | M1–M24 | 3 |
| `0E84` | AQ1–AQ2 | 1 (first 2 slots) |
| `0E98` | X1–X16 (open connectors) | 2 |

Source: brickpool/logo 0BA5-Dekodierung wiki (Format im Speicher; Verweis auf Ausgänge, Merker).

### 5.4 Basic functions — GF (opcodes `0x01`–`0x08`)

Format: `<op> 00` + up to four input words + `FF FF` trailer (record length 4/8/12 by type). Unused inputs are `FFFF`.

| Op | Function | Len |
|---|---|---|
| `01` | AND | 12 |
| `02` | OR | 12 |
| `03` | NOT | 4 |
| `04` | NAND | 12 |
| `05` | NOR | 12 |
| `06` | XOR | 8 |
| `07` | AND (edge) | 12 |
| `08` | NAND (edge) | 12 |

Worked example from the spec — block B001 raw `02 00 0B 80 FF FF 01 00 FF FF FF FF` decodes to `OR(B002, I2)`. This tool reproduces that exactly.

Source: brickpool/logo 0BA5-Dekodierung wiki (Grundfunktionen – GF).

### 5.5 Special functions — SF (opcodes `0x21`+)

Format: `<op> <Pa>` + inputs + parameter bytes, fixed length per type. `Pa` bit 7 = retentive, bit 6 = parameter-protection.

| Op | Function | Len |
|---|---|---|
| `21` | on-delay | 8 |
| `22` | off-delay | 12 |
| `23` | pulse relay | 12 |
| `24` | weekly timer | 20 |
| `25` | latching relay | 8 |
| `27` | retentive on-delay | 12 |
| `2B` | up/down counter | 24 |
| `2D` | async pulse generator | 12 |
| `2F` | on/off-delay | 12 |
| `31` | stairwell switch | 12 |
| `34` | message text | 8 |
| `35` | analog threshold | 16 |
| `39` | analog watch | 20 |

Example — on-delay `21 40 01 00 7A 80 00 00`: `op=21`, `Pa=40`, input `Trg = I2` (`0x0001`), then parameter `T` (`0x807A`). Note the parameter word has its high bit set, so it is **byte-ambiguous with a block reference** — which is why this tool does **not** guess SF inputs by scanning; it names the SF and shows the raw bytes. Full SF parameter decoding (timer setpoints, counter limits, weekly schedules) is future work.

Source: brickpool/logo 0BA5-Dekodierung wiki (Sonderfunktionen – SF; Einschaltverzögerung).

---

## 6. What this tool decodes

| Item | Accuracy |
|---|---|
| PG connect / identify / Read Block / XOR | Exact (matches library + spec) |
| Output & marker wiring (Q/M/AQ/X) | Exact |
| Basic gates (GF) with resolved inputs | Exact (validated against the spec's worked example) |
| Special functions | Named + raw bytes; parameters not yet interpreted |
| 0BA6 `0x00FF` program address page | Inferred; confirmed at runtime by the name self-test |
| WebUSB chip config (CP210x/CH340/FTDI) | Best-effort, untested on all silicon; desktop Web Serial is robust |

---

## Sources

- **brickpool/logo** — Arduino library, PG protocol for 0BA4/0BA5/0BA6. <https://github.com/brickpool/logo>
  - PG-Protocol wiki — <https://github.com/brickpool/logo/wiki/PG-Protocol>
  - 0BA5-Dekodierung wiki (German block-format teardown) — <https://github.com/brickpool/logo/wiki/0BA5-Dekodierung>
  - Source cross-checked: `src/LogoPG.cpp` — <https://github.com/brickpool/logo/blob/master/src/LogoPG.cpp>
- **NI LabVIEW forum** — SNATAX (0BA6) & cacalderon (0BA5, DE-9 pinout). <https://forums.ni.com/t5/LabVIEW/LOGO-PLC-driver-based-on-LabVIEW/td-p/877701>
- **amobbs (neiseng)** — 0BA5 data address space, password, cyclic read. <https://www.amobbs.com/thread-3705429-1-1.html>
- **Web Serial API** — <https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API>
- **WebUSB API** — <https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API>
- **Siemens LOGO!Soft Comfort V9 Demo** (transfer disabled in demo) — <https://support.industry.siemens.com/cs/document/110002070/>

All protocol/format facts above are reimplemented, not copied, from these community sources.
