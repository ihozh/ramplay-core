# RamPlay Teaching Console — Project Specification

> Audience: the coding agent / developers working on this repository in VS Code.
> Status: v0.26 draft. This file is the single source of truth. If an implementation
> needs to deviate from it, update this spec first and note the change in §14.

---

## 1. Goals

RamPlay is an open, original 8-bit cartridge game console designed for teaching
digital systems, computer architecture, and hardware security at Farmingdale State
College. The name combines RAM (memory), the Rams (campus mascot), and play.
Its secure-boot feature is called **Root** ("RamPlay with Root secure boot").

1. **Physical and understandable** — real 6502 hardware on breadboards; every chip on the
   CPU side is something a student can explain.
2. **Real games** — 160×128 color display, tiles + sprites, 32 KB cartridges.
3. **Cartridges** — the reset vector lives on the cartridge; the console has no BIOS.
4. **Security labs** — cartridge dumping, tampering, checksums, signatures, root of trust.
5. **Works without hardware** — a web emulator that is bit-compatible with the hardware,
   so students can develop games at home.

### 1.1 Non-goals
- Compatibility with any commercial console. No bank switching in v1. No interrupts
  required by games in v1 (polling only).

### 1.2 Originality / IP rules (mandatory)
- All code, protocols, file formats, names, and assets in this repo must be original.
- Do **not** copy or imitate code, APIs, function names, file formats, logos, boot
  sequences, or assets from Nintendo, Sega, Lexaloffle (PICO-8), or any other product.
- Do not copy third-party code verbatim. Third-party libraries are allowed only under
  permissive licenses (MIT/BSD/Apache-2.0/zlib) and must be listed in `THIRD_PARTY.md`.
- Licenses: software **MIT**; hardware **CERN-OHL-S-2.0**; docs **CC BY 4.0**.
  Copyright holder line is TBD pending confirmation with the college (§14); use
  `Copyright (c) RamPlay Contributors` as a placeholder.
- Do not use Farmingdale or Rams logos/mascot artwork in the repo until approved by
  the college; the text name "RamPlay" is fine.
- Student contributions are accepted under the repo licenses (add a short
  `CONTRIBUTING.md` stating this).

---

## 2. System Overview

```
+-------------------- 5 V domain ---------------------+     +---- 3.3 V domain ----+
| W65C02S CPU  -- 62256 RAM -- W65C22S VIA            |     | Raspberry Pi Pico    |
|   1 MHz osc / 555 single-step clock                 |     |  (display + sound    |
|   74HC00 address decode                             | PB  |   coprocessor)       |
|   Cartridge slot (AT28C256, 32 KB)                  |---->|  74LVC245 level shift|--> ST7735 160x128 SPI LCD
|   7 buttons on Port A                               | CB2 |                      |--> piezo (PWM)
|                                                     |<----| VBLANK (via NPN)     |
+-----------------------------------------------------+     +----------------------+
```

The CPU side is the well-known "breadboard 6502" layout (CPU, RAM, EEPROM, VIA, NAND
decode). RamPlay adds: the cartridge connector, the Pico display/sound module, and the
security extension.

---

## 3. Memory Map (CPU)

| Range         | Size  | Device                    | Decode                     |
|---------------|-------|---------------------------|----------------------------|
| `$0000–$3FFF` | 16 KB | RAM (62256, lower half)   | A15=0, A14=0               |
| `$4000–$5FFF` | —     | unused (reads open bus)   |                            |
| `$6000–$600F` | 16 B  | W65C22S VIA (mirrored to `$7FFF`) | A15=0, A14=1, A13=1 |
| `$8000–$FFFF` | 32 KB | Cartridge ROM             | A15=1                      |

Zero page `$0000–$00FF`, stack `$0100–$01FF` (standard 6502).

### 3.1 VIA registers used

| Address | Name | RamPlay use                                   |
|---------|------|---------------------------------------------|
| `$6000` | ORB  | Display/sound byte stream (write only)      |
| `$6001` | ORA  | Buttons (read). Reading also clears CA1 flag|
| `$6002` | DDRB | `$FF` (all outputs)                         |
| `$6003` | DDRA | `$00` (all inputs)                          |
| `$600C` | PCR  | `$A0` → CB2 pulse-output mode; CA1 negative edge |
| `$600D` | IFR  | Bit 1 (`$02`) = CA1 = VBLANK flag           |
| `$600E` | IER  | `$7F` (all VIA interrupts disabled)         |

### 3.2 Required init sequence (games / SDK `rpl_init`)

```
LDA #$FF  : STA $6002   ; DDRB = output
LDA #$00  : STA $6003   ; DDRA = input
LDA #$A0  : STA $600C   ; PCR: CB2 pulse on ORB write, CA1 falling edge
LDA #$7F  : STA $600E   ; disable VIA IRQs
```

---

## 4. Input

Buttons on Port A, active-low with pull-ups (pressed = 0). SDK inverts so pressed = 1.

| Bit | 0  | 1    | 2    | 3     | 4 | 5 | 6     | 7      |
|-----|----|------|------|-------|---|---|-------|--------|
| Btn | Up | Down | Left | Right | A | B | Start | unused (reads 1) |

---

## 5. Frame Sync (VBLANK)

- The Pico renders at a fixed **30 fps**.
- At the start of each frame the Pico snapshots its state (double buffering) and emits a
  VBLANK pulse: Pico GPIO high for 10 µs → NPN inverter → VIA CA1 low → IFR bit 1 set.
- Game loop pattern (polling, no IRQ):

```
wait:  LDA $600D
       AND #$02
       BEQ wait        ; wait for VBLANK
       LDA $6001       ; read buttons (also clears CA1 flag)
       ...             ; game logic, send display commands
       JMP wait
```

- Commands received while a frame is rendering apply to the **next** frame.

---

## 6. Display / Sound Protocol (the core contract)

### 6.1 Transport
- Each CPU write to `$6000` places one byte on PB0–PB7; the VIA pulses CB2 low for one
  PHI2 cycle. The Pico captures PB0–7 on the CB2 falling edge (PIO state machine → FIFO).
- One-way, no handshake. Max CPU rate is ~1 byte / 4 µs; the Pico must never drop bytes
  at that rate.
- Stream = `opcode` followed by a fixed or terminated argument list. There is no framing;
  the parser resets to the "expect opcode" state on CPU reset (§7, `RESB_SENSE`) and on
  opcode `$FF`.
- Multi-byte integers are **little-endian**.

### 6.2 Video model
- Screen: **160×128**, RGB565.
- **Tiles**: 256 tiles, 8×8 px, 4 bpp (16 colors). 32 bytes/tile, row-major,
  4 bytes/row, **high nibble = left pixel**.
- **Palettes**: 4 palettes × 16 colors, RGB565. In sprites, color index 0 is transparent.
  In the background every index is opaque.
- **Background map**: 32×32 cells (256×256 px), wraps. The screen is a 160×128 window
  positioned by `SCROLL`. Background cells honor hflip and vflip.
- **Sprites**: 32, each 8×8, drawn above background, lower index on top. No per-line limit.
  A sprite is clipped at the right and bottom edges. It cannot hang off the left or
  top edge (`x`, `y` are unsigned).
- **Text layer**: 20×16 cells of 8×8, fixed (does not scroll), drawn above everything,
  built-in ASCII `$20–$7E` font in the Pico firmware (original font, drawn by us).
  Cell value `$20` (space) = transparent. Glyph pixels are drawn in **color 15** of the
  palette given to `TEXT`; the rest of the cell is transparent.

**Attribute byte** (used by BG cells and sprites):

| Bit | 7                     | 6–4      | 3     | 2     | 1–0     |
|-----|-----------------------|----------|-------|-------|---------|
|     | sprite: visible (BG: ignored) | reserved=0 | vflip | hflip | palette |

### 6.3 Commands

| Op   | Name     | Args (bytes)                                | Effect |
|------|----------|---------------------------------------------|--------|
| `$00`| NOP      | —                                           | none (padding) |
| `$01`| DEFTILE  | `id`, 32 × data                             | define tile `id` |
| `$02`| SETBG    | `x`(0–31), `y`(0–31), `tile`, `attr`        | set one BG cell |
| `$03`| SETSPR   | `id`(0–31), `x`, `y`, `tile`, `attr`        | set sprite. `x,y` = screen px of top-left; x≥160 or y≥128 is off-screen |
| `$04`| SETPAL   | `pal`(0–3), 16 × RGB565 (32 bytes)          | set palette |
| `$05`| SCROLL   | `sx`, `sy`                                  | BG scroll in px (wraps at 256) |
| `$06`| SOUND    | `freq_lo`, `freq_hi`, `dur`                 | square wave, Hz (u16), duration in 10 ms units; `dur=0` stops |
| `$07`| TEXT     | `x`(0–19), `y`(0–15), `pal`, chars…, `$00`  | write text to text layer; stops at `$00` or end of row |
| `$08`| CLEAR    | —                                           | BG = tile 0 attr 0, all sprites hidden, text layer = spaces, scroll = 0,0 |
| `$09`| BGROW    | `x`, `y`, `n`(1–32), n × `tile`             | set `n` consecutive BG cells in a row (attr 0), wraps at x=32 |
| `$0A`| CLRTXT   | —                                           | text layer = spaces |
| `$FF`| RESYNC   | —                                           | parser returns to "expect opcode" |
| other| —        | —                                           | ignored, parser stays in "expect opcode" |

Out-of-range arguments are clamped or masked (`x & 31`, `id & 31`, `pal & 3`), never
crash. Default state after power-on/reset: all tiles zero, palette 0 = a default
16-color palette (defined in `firmware/common/default_palette.h`), palettes 1–3 copy of
palette 0, `CLEAR` state.

Exact rules, so the firmware and the emulator agree:

- `TEXT`: every byte up to and including the `$00` is consumed. Characters past
  column 19 are dropped. A character outside `$20–$7E` is stored as `$20`. With
  `x` > 19 or `y` > 15 nothing is stored. `pal` is masked with 3.
- `BGROW`: exactly `n` tile bytes are consumed, whatever `n` is. Only the first 32
  are stored. `n = 0` stores nothing.
- `CLEAR` sets every sprite to `x=0, y=0, tile=0, attr=0`.
- `SOUND` takes effect at once.
- `$FF` is RESYNC only where an opcode is expected. Inside an argument list it is data.

### 6.4 Shared reference implementation
The command parser and renderer must exist **once** as portable C in
`firmware/common/` (no Pico SDK dependencies) and be used by:
- the Pico firmware, and
- the web emulator (compiled to WebAssembly via Emscripten), **or** a line-by-line TS port
  validated against the same test vectors (§11).

The emulator uses the TS port (`src/video/rpl.ts`). The font and the
default palette have one source each (`firmware/common/font.txt`, `palette.txt`);
`tools/gen_tables.py` writes the C headers and the TS table from them.

---

## 7. Pico Module

### 7.1 Pin assignment

| Pico GPIO | Signal       | Notes |
|-----------|--------------|-------|
| GP0–GP7   | PB0–PB7 in   | through 74LVC245 (VCC=3.3 V, DIR fixed A→B, /OE=GND) |
| GP8       | CB2 strobe in| 5 V→3.3 V via divider (10k/20k) |
| GP9       | RESB_SENSE in| CPU /RESB via divider; low = reset parser + state |
| GP10      | VBLANK out   | to NPN base via 1 kΩ; collector → VIA CA1 with 3.3k pull-up to 5 V |
| GP11      | RESB_CTRL out| (security extension, §9) to NPN that can pull /RESB low; idle = low (not asserting) |
| GP15      | AUDIO        | PWM → piezo |
| GP16      | LCD DC       | |
| GP17      | LCD CS       | SPI0 |
| GP18      | LCD SCK      | SPI0 |
| GP19      | LCD MOSI     | SPI0 |
| GP20      | LCD RST      | |
| GP21      | LCD BL       | PWM backlight |

### 7.2 Firmware architecture (C, Pico SDK)
- **PIO SM0**: wait for CB2 falling edge, sample GP0–7, push to RX FIFO; chained DMA
  into a 4 KB ring buffer.
- **Core 0**: drain ring buffer → `rpl_parse_byte()` (from `firmware/common`).
- **Core 1**: frame loop at 30 fps: snapshot state → render scanlines → SPI DMA to LCD →
  VBLANK pulse at start of frame.
- **USB CDC debug mode**: bytes received over USB serial are fed into the same parser.
  This lets us test the display without any 6502 hardware
  (`tools/rplsend.py file.bin` streams a command file).
- Pico RAM budget: tiles 8 KB, map 2 KB, sprites 160 B, text 320 B, framebuffer
  40 KB (×2 if double-buffered) — well within 264 KB.

---

## 8. Cartridge

### 8.1 Electrical (30-pin, 2×15, 2.54 mm header)

| Pins   | Signal |
|--------|--------|
| 1–15   | A0–A14 |
| 16–23  | D0–D7  |
| 24     | /CE (= NOT A15 from console decode) |
| 25     | /OE (= RWB-derived read enable) |
| 26     | /WE (tied high on console in v1) |
| 27     | VCC 5 V |
| 28, 29 | GND |
| 30     | reserved (NC) |

Pin numbering is a draft; final numbering is set in `hardware/cartridge/` and must be
mirrored here.

### 8.2 ROM image format (`.rpl` = raw 32768-byte binary, CPU `$8000–$FFFF`)

| CPU address   | Content |
|---------------|---------|
| `$8000–$FEFF` | game code and data |
| `$FF00–$FF3F` | Ed25519 signature (64 B) — zero if unsigned |
| `$FF40–$FF43` | magic `"RPL1"` |
| `$FF44`       | format version = 1 |
| `$FF45–$FF54` | title, ASCII, 16 B, space-padded |
| `$FF55`       | label flag: `$01` = the cartridge draws its own label (§8.4); `$FF` = it does not |
| `$FF56–$FFF9` | reserved, `$FF` |
| `$FFFA–$FFFB` | NMI vector |
| `$FFFC–$FFFD` | RESET vector |
| `$FFFE–$FFFF` | IRQ/BRK vector |

Signature covers bytes `$8000–$FEFF` and `$FF40–$FFFF` (everything except the
signature itself). See `tools/rplsign.py`.

The CPU never looks at the header. It reads `$FFFC`/`$FFFD` and runs, as in v2. The
header is for tools, the emulator's cartridge panel, and Root (§9).

### 8.3 Cartridge PNG (a game as a picture)

RamPlay can save any cartridge on the shelf as a PNG: a drawing of the cartridge with
the game's own title screen on its label. The file is also the game. Whoever has the
picture has the game: adding the file in RamPlay puts the cartridge on their shelf.

The game is in one extra PNG chunk, `rpLc` (ancillary, private, safe to copy), placed
just before `IEND`:

| Bytes | Content |
|-------|---------|
| 0 | format version = 1 |
| 1–2 | `n`, length of the information, little-endian |
| `n` bytes | information: JSON, UTF-8 (`id`, `title`, `author`, `year`, `tags`, `description`) |
| 32768 bytes | the `.rpl` image, unchanged |

- The ROM is stored as it is, so it can be cut out with a
  hex editor (the dumping lab uses this). The chunk CRC that every PNG chunk has catches
  a damaged file.
- This is our own layout. It does not hide data in the pixels, and the picture is our own
  drawing (§1.2).
- Limit: an app that re-encodes pictures (most chat and social apps, a screenshot) drops
  the chunk, and the game with it. The file itself has to be sent: mail attachment, file
  share, AirDrop, a course site upload. RamPlay says so when a picture has no game in it.
- A picture whose `id` is a library game puts the library's copy on the shelf.
- Code: `src/cartpng.ts` (read and write). The picture itself is drawn by the platform.

### 8.4 Label mode (a cartridge draws its own label)

A cartridge may carry its own cover picture. If header byte `$FF55` is `$01`, the game
must do this: when Left and Right are both held at power-on, it does not start. It draws
the label into background cells x 0..21, y 0..24 (176 x 200 pixels), sets scroll 0,0,
shows no sprites and no text, and idles. It may let Up and Down scroll the picture, so
that the whole label can be seen on the 160 x 128 screen. `RPL_LABEL` in the SDK sets the
byte. `labelOf(rom)` in `src/snapshot.ts` runs the cartridge this way and returns the
picture, for a platform's shelf.

---

## 9. Root — Secure Boot Extension (research track, v2)

Root-of-trust boot ("Root"), implemented later but the pins and format are reserved now:
1. Pico asserts `RESB_CTRL` → CPU held in reset.
2. Pico reads the cartridge directly (address via 2× 74HC595, data via the existing
   level-shifted path or a second 74LVC245 — exact circuit TBD in `hardware/secure-boot/`).
3. Pico computes SHA-512/Ed25519 over the signed region and verifies against a public key
   stored in Pico flash.
4. Pass → release reset. Fail → show error on screen, keep CPU in reset.

Lab materials S1–S6 (dump/tamper, checksum, logo-lock, CPU-reported signature check,
breaking it with a lying cartridge, bus sniffing / clock glitching) live in `labs/`.

---

## 10. Software Toolchain & SDK

- Assembler/C: **cc65** suite (ca65, cc65, ld65).
- `sdk/ramplay.inc` — ca65 constants and macros (register addresses, opcodes, button bits).
  - `RPL_HEADER "TITLE"` writes the `$FF00–$FF54` header (zero signature, magic,
    version, padded title). Every game calls it once.
  - `rpl_cmd b0, b1, …` sends up to 8 bytes; each is an `lda` operand
    (`rpl_cmd #RPL_SETSPR, #0, ball_x, ball_y, #2, #RPL_ATTR_VISIBLE`).
  - `rpl_print col, row, pal, label` sends a `TEXT` command for a zero-terminated string.
- `sdk/ramplay.h` — C equivalents for cc65 (constants and prototypes; a C `crt0` is
  not written yet, see §14).
- `sdk/ramplay.cfg` — ld65 linker config: ZP `$0000–$00FF`, RAM `$0200–$3FFF`,
  ROM `$8000–$FEFF`, reserved `$FF00–$FFF9`, vectors `$FFFA`.
- `sdk/rpl_rt.s` — runtime: `rpl_init`, `rpl_wait_vblank`, `rpl_read_buttons`,
  `rpl_send` (A → `$6000`), plus helpers per command.
  - `rpl_wait_vblank` waits for the flag, reads `$6001` (which clears it), and
    returns the buttons in A (pressed = 1) and in `rpl_buttons`.
  - `rpl_send` changes no flags and no registers.
- `tools/png2tiles.py` — PNG (indexed, ≤16 colors) → tile bytes + palette (RGB565).
- `tools/rplsign.py` — sign/verify a `.rpl` image (Ed25519, `cryptography` package).
- `tools/rplsend.py` — stream a command file to the Pico over USB serial.
- `tools/rplinfo.py` — check a `.rpl` image (size, magic, version, title, vectors).
- `tools/gen_tables.py` — font and palette sources → C headers and TS table (§6.4).

### 10.1 Example (ca65)

```asm
        .include "ramplay.inc"
        RPL_HEADER "HELLO"
        .segment "CODE"
reset:  ldx #$FF
        txs
        jsr rpl_init
        lda #RPL_CLEAR
        jsr rpl_send
        ; TEXT at (4,7), palette 0, "HELLO RAMPLAY"
        lda #RPL_TEXT
        jsr rpl_send
        lda #4
        jsr rpl_send
        lda #7
        jsr rpl_send
        lda #0
        jsr rpl_send
        ldx #0
@loop:  lda msg,x
        jsr rpl_send
        beq @done          ; terminator $00 already sent
        inx
        bne @loop
@done:  jsr rpl_wait_vblank
        jmp @done
msg:    .byte "HELLO RAMPLAY", 0

        .segment "VECTORS"
        .word reset, reset, reset
```

---

## 11. RamPlay Core and platforms

### 11.1 Conformance
`tests/protocol/` contains command streams (`*.bin`) and expected frames (`*.png`).
Firmware (host build of `firmware/common`) and emulator must render pixel-identical
output for every vector. CI runs these on every push.

### 11.2 Core and platforms
The software has two parts.

**RamPlay Core** (this repository, the package `ramplay-core`) is the system. Every cartridge runs on it. It is
public: MIT licensed, packed as plain ES modules with type declarations (`npm pack`), with no dependencies, for anyone to build a platform on. It has
no drawing in it, like the v2 engine, so a page, a lab bench, a grader or a Worker can run
it, in a browser or in Node. Its whole interface is `src/index.ts`:

| Part | Files | What it is |
|------|-------|------------|
| machine | `engine/cart.ts` | the cartridge: 32768 bytes, the `.rpl` header fields |
| | `engine/bus.ts` | the 16-bit bus: which chip answers an address (§3) |
| | `engine/cpu.ts` | the W65C02S: all opcodes, cycle counts, a disassembler |
| | `engine/via.ts` | the W65C22S subset of §3.1 |
| | `engine/machine.ts` | power, reset, one frame at a time, the protocol log |
| picture | `video/rpl.ts`, `video/tables.ts` | the display protocol: parser, renderer, font, palette (§6) |
| cartridge PNG | `cartpng.ts` | a cartridge as a picture, read and write (§8.3) |
| snapshot | `snapshot.ts` | a cartridge's own picture: its label, or a frame and its sprites |

Core's tests (`test/`) are the CPU, the VIA, the machine, the protocol vectors of
§11.1 and every built-in game played from its title to its end. Core has a page of its
own (`index.html`, at `/core/` on the site): what core is, a bare console made of
core, a canvas and a keyboard, the interface, and links to the platforms and documents.

**A platform** is everything around the system: where cartridges come from, where the
picture goes, what the buttons are, how sound is made. Anyone can make one in a project
of their own. It depends on `ramplay-core` and imports only from its interface. RamPlay
is the RamPlay project's own platform: a shelf, a cartridge shop, labels, upload and
review. It is in a separate repository. Core does not contain platform code.

The VIA timers and the shift register are not modeled. If a game enables the CA1
interrupt in IER the IRQ line works, so a later lab can take VBLANK as an interrupt.

## 12. Repository Layout

This repository is RamPlay Core: the system.

```
ramplay-core/
├─ RAMPLAY_SPEC.md         # this file
├─ README.md               # the npm package: install, interface
├─ LICENSE / LICENSE-HW / LICENSE-DOCS / THIRD_PARTY.md
├─ src/                    # the system in TypeScript; index.ts is the interface
├─ test/                   # CPU, VIA, machine, protocol vectors, cartridge PNG, labels
├─ index.html, page/       # the core page
├─ firmware/
│  ├─ common/              # portable C: parser, renderer, font, default palette
│  └─ pico/                # Pico SDK app: PIO, DMA, LCD driver, USB CDC
├─ sdk/                    # ramplay.inc, ramplay.h, ramplay.cfg, rpl_rt.s
├─ examples/               # hello, catch, pong, and example.mk for any cartridge
├─ tools/                  # rplinfo, gen_tables (later: png2tiles, rplsign, rplsend)
├─ tests/protocol/         # conformance vectors
├─ hardware/               # KiCad: io-board, cartridge, secure-boot (later)
└─ docs/                   # wiring tables, student guides
```

Platforms, games and servers are not here. The RamPlay project's own are in a separate
repository that holds this one as the folder `core/`.

## 13. Milestones (build in this order)

| # | Deliverable | Done when |
|---|-------------|-----------|
| M1 | `firmware/common` parser + renderer, host build, `tests/protocol` with ≥10 vectors | `make test` passes on Linux/macOS |
| M2 | SDK (`sdk/*`) + `examples/hello` builds with cc65 into a valid `.rpl` | `make -C examples/hello` outputs 32768-byte image with correct vectors and magic |
| M3 | Web emulator v1 runs `hello` and `pong` | text and paddles render; keyboard works |
| M4 | Pico firmware with USB CDC mode | `rplsend.py` streams vectors and LCD matches expected PNGs |
| M5 | Pico firmware with PIO/CB2 path on real hardware | `hello.rpl` on a real cartridge displays correctly |
| M6 | Tools: `png2tiles`, `rplsign` | round-trip tests pass |
| M7 | Emulator v2 editors | tile/map/sfx editors export usable data |
| M8 | Secure-boot prototype (§9) | unsigned/tampered cartridge is refused |

Coding conventions: C11, `-Wall -Wextra -Werror`; TypeScript strict mode; Python 3.11+
with type hints; every module has unit tests; no generated binaries committed except
test vectors.

---

## 14. Open Questions / Change Log

- [ ] Final cartridge pin numbering and connector type (header vs. card-edge).
- [ ] Confirm W65C22S CA1 input threshold with NPN pull-up value on the real board.
- [ ] Secure-boot read path circuit (§9 step 2).
- [ ] Default 16-color palette values. (`firmware/common/palette.txt` holds a first
      set; changing it means re-blessing the vectors.)
- [ ] Confirm with college marketing: use of "RamPlay" name and any Rams artwork.
- [ ] Confirm IP ownership / copyright holder with SUNY Research Foundation / college.
- [ ] USPTO trademark search for "RamPlay" before any public release.
- [ ] RESYNC cannot recover a parser that is inside an argument list (§6.3), because
      `$FF` is valid data there. Only CPU reset does. Decide whether that is enough.
- [ ] C runtime (`crt0`) for cc65, so `sdk/ramplay.h` can be used for a whole game.
- [ ] The cartridge has no SRAM, so catch keeps its best score in console RAM (it
      survives Reset; power off clears it). v2 kept it on the cartridge with a battery.
- v0.1 — initial spec (working name Lit-8).
- v0.2 — renamed to RamPlay; prefixes `rpl_` / `RPL_`, image extension `.rpl`,
  magic `"RPL1"`; secure-boot feature named Root.
- v0.3 — M1 to M3 built. Added the exact parser
  rules under §6.3, text color (index 15) and sprite clipping in §6.2, the TS port
  choice in §6.4, `RPL_HEADER` / `rpl_cmd` / `rpl_print` and the `rpl_wait_vblank`
  contract in §10, `tools/rplinfo.py` and `tools/gen_tables.py`, §11.2 (engine layout,
  `window.ramplay`), `examples/catch`.
- [ ] Cartridge PNG and §1.2: PICO-8 also ships games as PNG pictures of a cartridge. Ours uses a PNG chunk and our own drawing. The idea is the same. Decide whether that is far enough from "imitate" before a public release.
- v0.23 — a cartridge can draw its own label: header byte `$FF55`, label mode with Left and Right held at power-on (§8.2, §8.4), `RPL_LABEL` in the SDK.
- v0.24 — the software is two parts: RamPlay Core, the system, and platforms built on it (§11.2).
- v0.25 — core is public and packable for others to use (`lib/`, type declarations) (§11.2).
- v0.26 — this repository is RamPlay Core only: the specification, the SDK, the examples, the tools, the firmware, the protocol vectors and the TypeScript system. RamPlay, its server and the project's games moved to their own repository, and so did their sections of this file (old §11 and §11.3).
