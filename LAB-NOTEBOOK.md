# Lab Notebook — LOGO! 0BA6 program recovery

Chronological log of experiments, hypotheses, and hardware observations. Newest entries at
the bottom of each section. This is the *investigation* record; settled protocol facts live
in [PROTOCOL.md](PROTOCOL.md). When an entry here graduates to a confirmed fact, copy it there
and cite this notebook.

Device under test (DUT): **Siemens LOGO! 0BA6.ES10**, IdentNo `0x45`, firmware **V1.07.07**,
part `6ED1052-1FB00-0BA6`. Program is password-protected (`0x00FF48FF = 0x40`).

Convention: `→` = PC→LOGO, `←` = LOGO→PC. All addresses 4-byte big-endian (0BA6).

---

## Confirmed on this hardware

- Connect `→ 21` `← 06 55 .. 45` → IdentNo `0x45` = 0BA6.ES10.
- Operating mode query `→ 55 17 17 AA` `← 06 42` = STOP. Reads require STOP; confirmed.
- `→ 02 00 FF 48 FF` `← 06 03 00 FF 48 FF 40` → password IS set (`0x40`).
- Magic sanity: `0x00FF1F00 = 0x04`, `0x00FF1F01 = 0x00` (as documented).
- Ident anchor `0x00FF1F02` reads correctly — Read Byte works, so zero reads elsewhere are
  real answers, not transport failures.
- **Read Block faults on this DUT even for legal ranges** — `→ 05 00 ff 0e e8 07 d0` `← 06`
  then `15 03` (illegal access). The `06` is the pre-parse ACK, not success (PROTOCOL.md §3.2).
  The tool therefore reads memory byte-wise (Read Byte `0x02`), which does not fault.
- Read Byte on protected / unmapped addresses returns **data `0x00`** (it does NOT fault).
  So an all-zero read is ambiguous: it means *either* "protected" *or* "unmapped/wrong
  address" — the two cannot be told apart by the value alone.

---

## Open question: how would the protocol let you ENTER a known password?

**Answer from a 4-front literature sweep (2026-07-16): there is no password-entry command.**

Spawned four parallel research agents over (1) brickpool/logo source + wiki + all issues/PRs,
(2) the NI LabVIEW forum thread (SNATAX/cacalderon), (3) amobbs/neiseng + Chinese/German/
Russian PLC forums, (4) other libraries + captured LOGO!Soft traffic + PLC-security writeups.
Unanimous, independent conclusion:

- The 0BA4/0BA5/0BA6 serial PG protocol has **no login / authenticate / challenge-response
  telegram**. The command set is `01` Write Byte, `02` Read Byte, `04/05` Write/Read Block,
  `55` control (mode), `20` Clear, `21` Connect, `22` Restart, `06` ACK, `15` Exception. None
  of them submits a password for the *device* to validate.
- The reference `SetSessionPassword()` (brickpool `LogoPG.cpp`), despite its name, never puts
  the password on the wire. It writes protection-level 1 to `0x00FF4740`, **reads the stored
  cleartext back** from `0x00FF0566`, and `strncmp()`s it **on the host**. "Login" = read +
  local compare.
- Decisive architectural fact (mikrocontroller.net #474631, corroborating a captured session):
  the **device sends the password to the PC** in cleartext; LOGO!Soft Comfort itself does the
  same read-and-compare. The typed-password prompt is a client-side UI gate, not a device check.
- The only genuine password *entry* / challenge-response in the whole LOGO! ecosystem is on
  **LOGO!8 (0BA7/0BA8) over Ethernet TCP/10005** (SySS `slig`, SSA-542701) — a different
  generation and protocol, and even that turned out to be read-and-decrypt (3DES/null key),
  not authentication. Nothing carries over to 0BA6 serial.
- Nobody has published *any* working entry path for a non-leaking 0BA6.ES10 / V1.07.07.

Implication: the tool is not missing an opcode. On firmware that refuses to leak `0x0566`,
the entire documented approach has no fallback.

---

## The unlock failure

### E1 — documented recovery (write level 1, then read back). FAILS.

Sequence (both variants below establish a clean STOP session first: `22` restart → `21`
connect → `55 17 17 AA` mode=STOP → check `48FF`/magic):

```
→ 01 00 ff 47 40 00      ← 06        Write Byte: protection → level 1 (ACK'd)
→ 02 00 ff 05 66 ...     ← 06 03 .. 00   Read password store: every byte 0x00
→ 02 00 ff 0e e8 ...     ← 06 03 .. 00   Read program area:   every byte 0x00
```

The write is **acknowledged** (`06`) but read access does **not** open: `0x0566` and
`0x0EE8` still read all-zero. This is the core failure.

### Two variants of E1 — and both were run on hardware, both failed

The tool has carried two orderings of the read-after-write:

| Variant | Between write and read | Result on DUT | Where |
|---|---|---|---|
| **E1a — back-to-back** | nothing (write → read, same session), mirrors `SetSessionPassword()` exactly | **all zero** | pre-commit `613dc04` code; run in a phone session (see 613dc04 message: *"the unlock write (0x4740=0) was ACK'd but the password (0x0566) and program (0x0EE8) still read all-zero"*) |
| **E1b — re-negotiate** | `22` restart + `21` connect + mode, on the guess that protection "latches at connect time" | **all zero** ("UNLOCK DID NOT TAKE") | commit `613dc04` onward; current default step 3. **Re-confirmed first-hand on real hardware 2026-07-16** (0BA6.ES10, WebUSB/CH340) with the current restart-enabled code — `01 00 ff 47 40 00 ← 06`, then `0x0566` and `0x0EE8` both read all-zero. |

**Key inference (2026-07-16):** the inserted re-negotiate (E1b) is NOT what breaks the unlock —
the back-to-back read (E1a) was tried first and *already* returned all-zero. Both orderings
fail identically. That removes "our own Restart is re-locking the device" as the explanation
and points hard at the firmware genuinely holding read protection after a level-1 write.

> ⚠️ E1a's failure is reconstructed from the `613dc04` commit message, not from a surviving
> raw serial log (the pre-`613dc04` session transcript is gone from disk; only the current
> session remains under `~/.claude/projects/`). Hence E1a is re-run cleanly below (E2) to
> confirm it in one deliberate, logged session rather than trusting a paraphrase.

### E2 — clean isolated back-to-back confirmation. PENDING HARDWARE.

Added a diagnostics button **"Unlock (no re-negotiate)"** (`recoverNoReneg()` in
`src/actions/password.ts`) that does E1a in one session with nothing between the write and the
read, and reports which branch it lands in. Purpose: turn the paraphrased E1a result into a
first-hand, logged datapoint.

Predicted outcome given E1a/E1b history: **still all zero** (i.e. re-negotiate was not the cause).
A non-zero result would instead mean E1a's earlier failure had some other confound — worth knowing.

**Result:** _(still pending — the 2026-07-16 hardware session ran step 3 (E1b), not this button.)_

### Real hardware session — 2026-07-16 (0BA6.ES10, WebUSB / CH340, fw V1.07.07)

First fully first-hand run of the current code against the DUT. Confirms E1b and adds three
findings:

1. **E1b confirmed:** `01 00 ff 47 40 00 ← 06` (protection write ACK'd), then `0x0566` reads all
   zero ("password NOT readable") and `0x0EE8 ×16` reads all zero → "UNLOCK DID NOT TAKE". A
   subsequent full program read returned **2 non-zero bytes / 2000** — i.e. effectively empty,
   consistent with read protection genuinely holding. **Strengthens H-A.**
2. **Connect reply is `06 03 21 45`, not `06 55 <..> <ident>`** (four times, consistent). Only
   byte[3] (the IdentNo) is read by the tool, so identification is unaffected. PROTOCOL.md §3.1
   and the test fake updated to the observed bytes.
3. **`55 12 12 AA` (STOP) got no response** on the already-stopped device; the mode query right
   after still returned `06 42`. So an absent `06` after the STOP command is not an error.
   PROTOCOL.md §3.3 and the fake updated.

**Bug found and fixed (from this session):** after "UNLOCK DID NOT TAKE", the tool had set
`unlocked = true` regardless, so the decode step's protection guard was bypassed and it spent
~68 s reading a still-protected device (all zeros) and saved a junk file. `unlocked` now reflects
*actual* read access (set only if the post-write reads return data); a failed unlock leaves it
false so decode blocks, while Re-lock stays enabled because a password exists. Covered by the
regression test in `test/observed-es10.test.ts`.

---

## Live hypotheses (post-E1a/E1b)

- **H-A — firmware genuinely holds (LEADING).** V1.07.07 closed the 0BA5 cleartext-leak: a
  level-1 write is ACK'd but does not grant read of `0x0566`/program. Consistent with both
  E1a and E1b failing and with the literature finding no entry path. If true, the program is
  not dumpable over PG without LOGO!Soft + the password.
- **H-B — latched-error artifact (LARGELY CLOSED).** A stale `15 03` wedge could make every
  read fail. Closed because: (i) the current flow sends `22` before every op; (ii) the reads
  return clean `0x00` *data*, not `15 03` — a wedge would fault. Not consistent with observations.
- **H-C — wrong password address on 0BA6 (OPEN).** `0x0566` is confirmed only as *where the
  library reads*; that it holds the cleartext on **0BA6** is unverified. An all-zero Read Byte
  is indistinguishable from reading unmapped memory. Needs an independent way to confirm `0566`
  is the real store on this generation.
- **H-D — level write needs a different value/target (OPEN, speculative).** German 0BA5 wiki:
  *"to access the password, at least protection level 2 must be set."* brickpool writes level 1
  (`0x4740`). Whether the ES10 wants a different level register / sequence is untested. Low
  confidence; do not write speculative protection values without a clear rationale (each write
  changes device state).

## Next experiments (not yet run)

1. **E2** (built, above): run "Unlock (no re-negotiate)" once on the DUT; record raw log.
2. **Power-cycle after the level-1 write**, then reconnect and read `0566`/`0EE8` — some
   protection changes only apply after reboot (commit 613dc04 option (a)). Cheap, reversible.
3. **Disambiguate H-A vs H-C:** after the write, read `0566` AND a deliberately-unmapped
   address AND a known-mapped non-protected address in the same pass. If the unmapped and the
   `0566` reads are identical zeros while a mapped address returns data, `0566` is either
   protected or simply not the store — still ambiguous, but it rules out gross transport issues.
   A stronger test: on an *unprotected* 0BA6 (borrow/reset one, or clear this program if
   acceptable), read `0566` and confirm it returns real ASCII — that verifies the address itself.

---

## State reversibility across reconnect / refresh

Principle (project rule): a state-changing op and its undo must survive a serial reconnect and
a browser refresh — reload state from the device where possible, and where not, warn loudly.

- **Reloadable:** "Put in STOP" re-reads `0x00FF48FF` and sets `st.protected`, so Re-lock is
  enabled cross-session (it is gated on `st.protected===true || st.unlocked`, not on this-session
  unlock). A fresh page / different computer can still Re-lock a device left unprotected earlier.
- **NOT reloadable (made explicit in UI):** `0x00FF48FF` reports only that a password *exists*
  (`0x40`), **not the current protection level**. After a level-1 write the device looks
  identical (`0x40`) whether it is currently unprotected or re-locked. The tool therefore
  **cannot** know from the device whether an unlock is still owed an undo. On connect/STOP with
  a password present, the log now says this outright and tells the operator to press Re-lock to
  be certain. New write buttons (incl. `recoverNoReneg`) set `st.protected`/`st.unlocked` so the
  undo re-enables the same way.

## Log of changes to the tool

- **2026-07-16** — Added `recoverNoReneg()` + "Unlock (no re-negotiate)" diagnostics button
  (E2). Created this notebook. Documented the no-password-entry literature result. Added an
  explicit connect-time warning that protection *level* is not device-reportable (reversibility
  rule).
