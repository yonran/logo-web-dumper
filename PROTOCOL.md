# LOGO! 0BA6 PG Protocol & Program Format

Documentation of everything this tool relies on to read and decode a **Siemens LOGO! 0BA6** program over the serial PG interface. Siemens does not publish this; all of it comes from community reverse-engineering (see [Sources](#sources)). Every section notes where its facts come from.

> **Disclaimer.** Independent, unofficial. Siemens and LOGO! are trademarks of Siemens AG. Reverse-engineered facts may be incomplete or wrong for your specific device/firmware. No warranty. See [LICENSE](LICENSE) (public domain).

---

## 1. Device identification

The part number `6ED1052-1FB00-0BA6` denotes the LOGO! **0BA6** generation. 0BA0–0BA6 use a 4-wire RS-232-compatible serial PG interface; 0BA7/0BA8 moved to Ethernet and do **not** use this protocol.

**Compatibility of this tool:**

| IdentNo | Device | Supported? |
|---|---|---|
| `0x45` | 0BA6.ES10 | ✅ yes (primary target, hardware-tested) |
| `0x44` | 0BA6.ES3 | ✅ yes (4-byte addressing) |
| `0x43` | 0BA6 | ✅ yes |
| `0x42` | 0BA5 | ⚠️ implemented (2-byte addressing, auto-detected) but **unverified on real 0BA5 hardware** |
| `0x40` | 0BA4 | ❌ no (would need its own address map; untested) |
| — | 0BA7 / 0BA8 (LOGO!8) | ❌ no — **Ethernet**, a different protocol entirely (see the SySS `slig` tooling for those) |

So: **LOGO! 0BA5 and 0BA6** (any ES variant), the serial-PG generations. The physical link is the **4-wire RS-232 PG interface at 9600 8E1** via the USB programming cable (or any USB-serial adapter — see §2).

Source: brickpool/logo PG-Protocol wiki (Introducing PG Protocol); Siemens LOGO! ordering data; IdentNo values cross-checked against `LogoPG.cpp` and this tool's own detection.

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

> The reference code uses Read Block for bulk transfer, including password upload and program-image
> upload. The only captured hardware rejection so far targeted the now-known-wrong legacy program
> address, so it does not establish that Read Block is unsupported at the correct 0BA6 map. The tool
> keeps byte-wise reads as its dependable capture path and uses a small block read only as an unlock
> fallback when byte probes remain uniform.

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

### 3.4 Password protection and password-store recovery

If the circuit program is password-protected, the program area cannot be read: on a 0BA6.ES10 `Read Block` returns `15 03` (illegal access) and `Read Byte` returns `0x00` for every protected byte (it does **not** fault). Check first:

```
Read Byte 0x00FF48FF  →  0x40 = password set,  0x00 = none
Read Byte 0x00FF1F00  →  0x04   (magic, sanity)
Read Byte 0x00FF1F01  →  0x00   (magic, sanity)
```

**When firmware exposes the password store, the password is recoverable locally.** Older models
store cleartext; ES10 stores a reversible XOR representation. Some firmware may return all zeros,
in which case no password is recovered. The sequence is what LOGO!Soft Comfort itself does —
**verified by decompiling LSC V8.0** (`DE.siemens.ad.logo.model.hardware.Modular0`, methods
`isPWProtected` / `uploadPassword` / `checkPassword` / `clearPasswordOnLogo`):

```
Read  0x00FF48FF                 ← password flag (isPWProtected)
Read  0x00000566 .. 0x0000056F   ← 10-byte stored representation (stop at first 0)
                                   (Read Byte on 0BA6.ES10; Read Block is rejected)
[compare entered vs stored IN THE PC — no password is ever sent to the device]
Write Byte 0x00FF4800 = 0x00     ← clear protection (clearPasswordOnLogo). THE UNLOCK WRITE.
```

Verified LSC addresses. `getAdress` returns the 16-bit value; the 0BA6 32-bit wire form ORs
`0xFF0000` **only for addresses ≥ `0x1F00`**. Anything below stays a bare `0x0000____`.
This explains the password store; program addresses are family-specific and listed in section 4.2.

| Symbolic (LSC) | 16-bit | 0BA6 wire | Role |
|---|---|---|---|
| `ADR_PASSWORD_FLAG` | `0x48FF` | `0x00FF48FF` | read: password present? |
| `ADR_PASSWORD` | (`0x0566`) | `0x00000566` | read: 10-byte stored representation |
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

> This is password recovery from hardware you own, using a readable or reversibly obfuscated store.

**Password obfuscation on newer 0BA6 firmware.** Older firmware stores the 10 password bytes at `0x0566` as plain ASCII. Newer 0BA6 (e.g. the **ES10 / `Logo6Update2`**, gated by `supports("supportPasswordSimpleEncrypt")`) stores them **obfuscated** — LSC's `EncryptAndDecrypt$SymmetricalSimpleEncoding`. This is **not** a cipher (contrast the LOGO!8 Ethernet path, which uses real 3DES under a null key): it's a symmetric per-byte XOR against a hardcoded 16-byte ASCII key, plus a bit-flip, applied over the nonzero bytes:

```
plaintext[i] = stored[i]  XOR  "protect customer"[i]  XOR  0xFF
```

Trivially reversible (the key is baked into the app). This tool decodes the store the way the
detected model stores it — XOR-decoded for the 0BA6.ES10 (`0x45`), cleartext for 0BA5/earlier 0BA6
(`0x42`–`0x44`) — and shows the other interpretation only as a labelled fallback.

Source: **LOGO!Soft Comfort V8.0 bytecode** — `EncryptAndDecrypt$SymmetricalSimpleEncoding` (key `code[] = "protect customer"`), invoked by `Logo6Update2.uploadPassword`.

Source: **LOGO!Soft Comfort V8.0 bytecode** (`Modular0.getAdress` → `ADR_CLEAR_PASSWORD_ACTIVE = 0x4800`, `ADR_SET_PASSWORD_ACTIVE = 0x4801`, `ADR_PASSWORD_FLAG = 0x48FF`; `checkPassword` does a local `String.equals`, sending nothing to the device). Cross-referenced with brickpool/logo `src/LogoPG.cpp` (whose `0x4740` unlock is not what LSC uses). Verified against real hardware (0BA6.ES10): `0x00FF48FF = 0x40`.

---

## 4. Address map

### 4.0 The paging rule (all families)

**The 4-byte address expansion is CONDITIONAL — verified from LSC `Logo6.getAdress`:** it takes the
base 16-bit address and ORs the `0xFF0000` page onto it **only if the address is ≥ `0x1F00`**.
Everything below `0x1F00` stays a **bare** 16-bit value, transmitted as `0x0000____`.

```java
addr = super.getAdress(id);          // base 16-bit
if (addr >= 0x1F00) addr |= 0xFF0000;    // page only the high addresses
```

(On a 0BA5 the wire address is just the low 16 bits — a 2-byte telegram — but the same low/high
split applies to which logical addresses hold what.)

### 4.1 Shared registers (same across 0BA4/0BA5/0BA6, via getAdress)

| Region | base | 4-byte wire | Bytes | Meaning |
|---|---|---|---|---|
| Password store | `0566` | **`0x00000566`** (bare) | 10 | (obfuscated) password |
| Program name | `0570` | **`0x00000570`** (bare) | 16 | ASCII name |
| Password exists | `48FF` | `0x00FF48FF` (paged) | 1 | `0x40` = yes |
| Magic / ident / fw | `1F00`–`1F08` | `0x00FF1F00`+ (paged) | — | system registers |
| Clear / set protection | `4800`/`4801` | `0x00FF4800/4801` (paged) | 1 | write 0 to clear / set |

### 4.2 Program map — this DIFFERS by family

The program/pointer/wiring addresses are **not** shared. Each family's `getMemories` defines its own
layout. This tool selects the map from the detected IdentNo (see `src/pg/device.ts`).

**0BA4 / 0BA5 (LSC `Logo4.getMemories`, inherited by `Logo5`) — low, bare:**

| Region | base | wire | Bytes |
|---|---|---|---|
| Pointer/offset table | `0C14` | `0x00000C14` | 260 |
| Output/marker wiring | `0E20` | `0x00000E20` | ~200 |
| Program memory | `0EE8` | `0x00000EE8` | 2000 |

**0BA6 / ES3 / ES10 (LSC `Logo6.getMemories`; ES10 = `Logo6Update2`, which inherits it) — high, but BARE on the wire:**

| Region | base | wire | Bytes |
|---|---|---|---|
| Block-name table / names | `0688`, `0708` | bare | 100, 800 |
| MessageMemoryRTF (7 reads) | `0AA8`…`2D2A` | bare | 6, 100, 6400, 50, 25, 256, 640 |
| Program-offset table | `2FAA` | `0x00002FAA` | 420 |
| Anchor tables (6 reads) | `31CA`…`327E` | bare | 40, 60, 20, 40, 20, 20 |
| **Program memory** | `3292` | **`0x00003292`** | 3800 |

`Logo6.getMemories` declares 11 top-level objects; `MessageMemoryRTF` expands into seven logical
ranges. The fixed allocations plus the complete 6,400-byte message-text capacity total 12,797
bytes, but that is **not normally the wire-byte count**. On a real (non-virtual) connection LSC uses
`fastUploadMessageText`: after reading the 100-byte offset table, it reads only populated 128-byte
message records, coalescing populated IDs separated by at most two unused IDs. Thus the actual
payload is data-dependent: **6,397 bytes plus selected message-text runs (0…6,400 bytes)**.

The tool reads the proven program body first as a hardware-safety measure, then reproduces that LSC
message-selection algorithm for the remaining memories. It places results at address-relative
offsets in a **15,074-byte** raw image spanning `0x0688…0x416A`; address gaps and unused message
slots remain zero and are never requested. LSC's `getNumberOfUploadTransferBytes() == 13,464` is a
nominal progress estimate, not a contiguous range or actual wire total. Any exception aborts the
composite image; the independently completed program-body artifact is retained. There is **no 0BA6
netlist decoder yet**.

> 🔴 **These program addresses are BARE, not paged.** The `≥0x1F00 → OR 0xFF0000` paging lives in
> `getAdress`, which is used for the *symbolic register* reads (flag `0x48FF`, magic `0x1F00`,
> protection `0x4800`). But the program/offset-table/wiring are `Memory` objects read via
> `Memory.upload → DataTransfer.readByteArray(rawBase)`, which **never calls `getAdress`** — the raw
> `Memory` base goes on the wire as `0x0000____`. (The `Memory` constructor stores the base verbatim
> into `fTransferStartAdress`; `writeCommandAddress` just emits its 4 bytes.) An earlier version of
> this doc/tool wrongly paged them to `0x00FF3292`; those read `0x00` on the ES10.

> 🔴 **History.** (1) The very first version paged *everything*, reading password/program at
> `0x00FF0566`/`0x00FF0EE8`. (2) Then `0C14`/`0E20`/`0EE8` turned out to be the **0BA4** map. (3) The
> `Logo6` bases `2FAA`/`31CA`/`3292` are correct but must be sent **bare**, not paged. NOTE: even at
> the bare `0x00003292`, the program body reads `0x00` on the ES10 after the `0x4800` clear write —
> read protection is still holding; the password recovery works but the program read does not (see
> LAB-NOTEBOOK). This addressing is decompiler-derived and not yet confirmed by a non-zero hardware read.

Source: LOGO!Soft Comfort V8.0 bytecode — `Logo6.getAdress` (the `addr >= 0x1F00 ? addr | 0xFF0000 : addr` rule, for symbolic reads only); `Memory`/`Memory.upload` + `DataTransfer.readByteArray`/`writeCommandAddress` (raw base, no paging).

Source: 0BA5 addresses from brickpool/logo 0BA5-Dekodierung wiki (Appendix A / Adressübersicht) and PG-Protocol wiki (Appendix A). 0BA6 `0x00FF____` prefix from the `ADDR_*` constants in `src/LogoPG.cpp`.

---

## 5. Legacy 0BA4/0BA5 program format

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

This section applies only to the legacy 2460-byte 0BA4/0BA5 image described above. The 0BA6 image
is captured raw and is not passed to this decoder.

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
