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
