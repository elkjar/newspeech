# liven — Sonicware LIVEN Texture Lab tools

Scripts from reverse-engineering the Texture Lab's SysEx (2026-10-16). Plain Python 3, no deps
except `record_syx.py` (python-rtmidi: `python3 -m venv .venv && .venv/bin/pip install python-rtmidi`).

**Container (all LIVEN SysEx):** `F0 00 48 04 00 00 <model> <cmd> <type> <payload> F7`; model 06 = Texture Lab,
0D = Ambient-Ø; cmd 60 = user data, 7F = firmware. 7-bit packing: groups of 8 = MSB byte + 7 bytes,
bit (6-i) → byte i. User data: type 01 start (u32 kind: 0 pattern / 2 sample, u32 size), 02 data (210 raw bytes
each), 03 end = zlib CRC-32 of the body, little-endian.
**Sample:** 8-byte name (`X.X.X.X`, uppercase) + u32 real frames + i32 0 + always 192,000 int16 mono @ 32 kHz.
**Pattern:** chunks LDKS → SEQN (name) / SQPS (BPM ×10 at +8, …) / SQPM / SQPR / SQSD — sizes include the 8-byte header.

| script | does |
|---|---|
| `lvn.py file.syx [out.bin]` | decode a LIVEN .syx, check CRC, dump the body |
| `tlsample.py in.wav NAME out.syx` | any WAV → sample .syx (ffmpeg resamples) — round-trips 01_EPIC.syx byte-identical |
| `tlwavetable.py table.wav NAME out.syx` | a waves/ table (32 × 2048 cycles) → 32 pitched regions for POSITION scanning |
| `paced.py in.syx "port" 00.100 out.txt` | → `sendmidi file out.txt`: one message per 100 ms (the unit drops a blast) |
| `record_syx.py "port" out.syx [idle s]` | record every SysEx whole (receivemidi dropped bytes on long dumps) |
| `gen-texturelab.py [out.json]` | regenerates `tools/rack/devices/texturelab.json` (edit's device file) |

Sending a sample: on the unit select the slot → FUNC + DATA → S.IMP → OK (IMPT) → send → OK to save.
Full backup: ▶ + POWER → VALUE to EXPT → (shift + VALUE = slower interval) → OK; ~17 MB, ~1.5 h; refuses on BT.LO.
