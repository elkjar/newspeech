#!/usr/bin/env python3
# Level timeline of a WAV: RMS + peak per window, dBFS, with a bar graph.
# The BROADCAST device tap: record the Loopback device the app is playing
# into, then read the transitions off the tape and line them up with the
# app log (js console lines carry ISO timestamps at every swap):
#
#   ffmpeg -f avfoundation -i ":BROADCAST" -t 200 -ac 2 -c:a pcm_s16le tap.wav
#   python3 scripts/tap-level.py tap.wav 0.5            # whole tape, 0.5 s windows
#   python3 scripts/tap-level.py tap.wav 0.1 110 130    # zoom a span
#
# 2026-09-08: this is how the "loud doubling between songs" was pinned to the
# incoming song's master trim (0..1 → -24..0 dB) landing as a +13 dB step.
import math
import struct
import sys
import wave

path = sys.argv[1]
win_s = float(sys.argv[2]) if len(sys.argv) > 2 else 0.5
t_from = float(sys.argv[3]) if len(sys.argv) > 3 else 0.0
t_to = float(sys.argv[4]) if len(sys.argv) > 4 else None
w = wave.open(path, 'rb')
ch, sw, sr, n = w.getnchannels(), w.getsampwidth(), w.getframerate(), w.getnframes()
f_from = int(t_from * sr)
f_to = n if t_to is None else min(n, int(t_to * sr))
w.setpos(f_from)
raw = w.readframes(f_to - f_from)
w.close()
count = (f_to - f_from) * ch
if sw == 2:
    vals = struct.unpack('<%dh' % count, raw)
    scale = 32768.0
elif sw == 4:
    vals = struct.unpack('<%di' % count, raw)
    scale = 2147483648.0
else:
    sys.exit('unsupported sample width %d' % sw)
step = int(sr * win_s)
print(f'{path.split("/")[-1]}: {ch} ch {sr} Hz {n / sr:.1f} s')
frames = f_to - f_from
for f0 in range(0, frames, step):
    f1 = min(frames, f0 + step)
    acc = 0.0
    pk = 0.0
    for i in range(f0 * ch, f1 * ch):
        v = vals[i] / scale
        acc += v * v
        if v < 0:
            v = -v
        if v > pk:
            pk = v
    rms = math.sqrt(acc / max(1, (f1 - f0) * ch))
    db = 20 * math.log10(rms) if rms > 1e-9 else -99
    pkdb = 20 * math.log10(pk) if pk > 1e-9 else -99
    print(f'{(f_from + f0) / sr:7.1f}s rms {db:6.1f} dB pk {pkdb:6.1f} ' + '#' * max(0, int((db + 60) / 2)))
