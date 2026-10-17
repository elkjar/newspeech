# LIVEN firmware notes (from Ambient-Ø v1.5.45 — Texture Lab has no public image; unit is S 1.0)

MD5 of the published LIVEN_AMBIENT_1_5_45.syx: 2a1e3cd1ac5da9fa1d8282b01e2183dd (our copy matches).

**Container** (decode the .syx with `lvn.py`): `cmtd` [size, cksum, 0, model 0x0D, section table] →
`pmtd` presets (0x48, 620,872 B) + `mmtd` system v1.5.45 (entry 0xC16B8100, 7 raw `sect` records:
load addr + len + bytes). Unencrypted, uncompressed. `fw_extract.py` unpacks + disassembles.

**CPU**: TI C674x DSP (C6748 / OMAP-L13x class) — compact-instruction fetch packets, DDR at 0xC0000000,
startup puts the stack in L1D RAM (0x11F0xxxx). Disassembler: GNU binutils `objdump -m tic6x` (handles
compact instructions + fetch-packet headers). 32-bit constants are mvk/mvkh pairs, often in `||` parallel
slots — `c6x_consts.py` rebuilds them (pair window is short; grep halves when it misses).

**Checksums**: cmtd/pmtd/mmtd cksum fields are NOT any standard CRC-32 / sum / Adler / Fletcher / MD5 /
SHA truncation over any contiguous range (`fw_cksum_hunt.py`), nor zlib CRC-32 with a hidden seed (CRC
unwinding gives unrelated seeds per section). The system image never parses `cmtd`/`mmtd` (its tag table
has `pmtd` only) → the container is verified by the **bootloader**, which is not in the update file.
Solving it needs the unit's flash (bootloader) — don't write firmware before then.

**Family check (2026-10-17)**: all 13 published images share the container + the C674x platform —
LIVEN 8bit warps 1.1.62/2.0.67/3.0.76 (model 02), XFM 2.0.43/3.0.46 (03), Bass&Beats 1.1.27 (04), Lofi-12 2.0.55/2.1.65 (07),
Mega Synthesis 1.1.37 (0B), Ambient-Ø 1.5.45 (0D), plus raw-.bin Lofi-12 XT 1.5.205 (0C), CyDrums 1.1.84 (08),
deconstruct MINIMAL 1.0.58 (10). Texture Lab = 06 (no image published). Byte 0x10 = model, 0x14 = section count.
`fw_family_hunt.py`: no standard CRC-32/sum/Adler matches ANY of the 28 section checksums. No image carries a
`bmtd` (boot) section; the XT/CyDrums `pmtd/mmtd/bmtd` strings belong to the SYSTEM INFO version formatter
(XT 0xC2C7FFA0…, reads RAM copies of each section header, prints *.*.*) — no checksum there either.
⇒ the checksum algorithm exists only in the bootloader in each unit's flash. Getting it = SPI-flash read.

**Map so far** (system image):
- 0xC16B4440 `crc32(ptr a4, len b4, prev a6)` — zlib CRC-32, bitwise (poly 0xEDB88320 via mvk/mvkh), chainable.
  Callers: 0xC16A1D60 = SysEx sender (210-byte chunks, running CRC); 0xC167C574 / 0xC168A640 / 0xC1697830 =
  the three importers (crc32(buf, len, 0) vs the 4 received bytes) — pattern / sample / backup.
- 0xC173C600… tag table (8-byte entries): settings ETIE GBPM HPAG LISL LIFX LIIG LIMN LISS CHAT MCHO CHPT CHPC
  CHT0-3 MCOE MCMD MRAS MRPC MTHR MTAS MTCC MTPC MTHZ MSTN MTMD MTEN MTVL TMTM PTRN PBRG PCNT PREF pmtd PNSD
  PPTN PPT2 RRST LMTR · pattern SEQN SQPM SQPS SQPR SQSD · SMEN SCKG SIPO SOPO VRMD · WTSD WTSI WTSN (samples?).
  Serializer that walks it: ~0xC1651800-0xC16537xx (write + read passes). MIDI-menu tags (MTPC/MRPC/MCMD/MTCC)
  are where "PC.CH resets to 16 at power-on" would live.
- Display strings near 0xC1738F66 ("IMPT", "EXPT", "N.B.IM", "N.B.EX", …).

**Patch wishlist** (only after the bootloader is understood + a flash backup exists): BPM as a CC, PC.CH
persisting, arp type CC, sample import without the IMPT button (for a racked unit).

## Texture Lab hardware (opened 2026-10-17)

Main board **"LIZARD Ver 1.1"** (PWB 2020-05-16), keybed on a second board over two ribbons.

| part | what |
|---|---|
| IC1 DSP | **TI TMS320C6742EZWT**, 200 MHz, BGA |
| IC1 (flash, beside the DSP) | **ISSI IS25LP128** — 16 MB SPI NOR, **3.3 V**, SOIC-8 208 mil → clip-readable; holds bootloader + system + patterns + samples |
| IC2 | Piecemakers PME809416DBR DDR2 |
| CN1 (back) | **TI 14-pin JTAG** (2×7, keyed — one pin absent), R100/R101 4.7 k pull-ups |
| CN100 | 7-pin header (pin-1 ▽, TP14/TP5/TP7/TP3/TP6) between DSP and flash — factory SPI programming or UART, untraced |

**Reading the flash:** unit unpowered, SOIC-8 clip on IC1. Use 3.3 V logic — a Raspberry Pi Pico running
pico-serprog + `flashrom -p serprog:dev=/dev/cu.usbmodem…` (or a CH341A *modded* to 3.3 V I/O; the stock black
board drives 5 V). Read three times, compare hashes, keep the image in Dropbox before anything is ever written.
If the DSP fights the bus in-circuit, hold it in reset. JTAG (XDS110 + CCS) = live debugging, later.
