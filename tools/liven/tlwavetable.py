"""WAVES wave table (32 x 2048 single cycles) -> Texture Lab sample laid out for POSITION scanning.
32 regions x 6000 frames @32k; each region = phase-continuous oscillator at C4 reading one cycle,
band-limited to <15 kHz, short crossfade between neighbouring waves. Pure stdlib (no numpy here).
usage: tlwavetable.py table.wav NAME out.syx [--hz 261.6256] [--xf 256]"""
import sys, wave, struct, math
sys.path.insert(0, __file__.rsplit('/', 1)[0]); from tlsample import syx, FRAMES, SR
a = sys.argv[1:]; src, name, out = a[0], a[1].upper(), a[2]
hz = float(a[a.index('--hz') + 1]) if '--hz' in a else 261.6256
xf = int(a[a.index('--xf') + 1]) if '--xf' in a else 256
w = wave.open(src); assert w.getsampwidth() == 2 and w.getnchannels() == 1
raw = struct.unpack('<%dh' % w.getnframes(), w.readframes(w.getnframes()))
N = 2048; H = int(15000 // hz)
cs = [[math.cos(2 * math.pi * h * n / N) for n in range(N)] for h in range(H + 1)]
sn = [[math.sin(2 * math.pi * h * n / N) for n in range(N)] for h in range(H + 1)]
tabs = []
for k in range(32):                                   # band-limit each cycle: keep harmonics 1..H, drop DC
    c = raw[k * N:(k + 1) * N]
    co = [(2 / N * sum(c[n] * cs[h][n] for n in range(N)), 2 / N * sum(c[n] * sn[h][n] for n in range(N))) for h in range(1, H + 1)]
    tabs.append([sum(A * cs[h][n] + B * sn[h][n] for h, (A, B) in enumerate(co, 1)) for n in range(N)])
REG = FRAMES // 32; inc = hz * N / SR
def osc(k, i):
    p = (i * inc) % N; i0 = int(p); f = p - i0; t = tabs[k]
    return t[i0] * (1 - f) + t[(i0 + 1) % N] * f
y = [0.0] * FRAMES
for k in range(32):
    lo, hi = k * REG, (k + 1) * REG
    for i in range(lo, hi):
        v = osc(k, i)
        if k < 31 and i >= hi - xf:                    # fade into the next wave over the last xf frames
            g = 0.5 - 0.5 * math.cos(math.pi * (i - (hi - xf)) / xf); v = v * (1 - g) + osc(k + 1, i) * g
        y[i] = v
for j in range(40): y[FRAMES - 40 + j] *= 0.975 - 0.025 * j
pk = max(abs(v) for v in y)
pcm = struct.pack('<%dh' % FRAMES, *[max(-32768, min(32767, round(v / pk * 32767))) for v in y])
body = name.encode().ljust(8, b'\0') + struct.pack('<Ii', FRAMES, 0) + pcm
open(out, 'wb').write(syx(body))
ww = wave.open(out.rsplit('.', 1)[0] + '.wav', 'wb'); ww.setnchannels(1); ww.setsampwidth(2); ww.setframerate(SR); ww.writeframes(pcm); ww.close()
print(f'{name}: {H} harmonics @ {hz:.2f} Hz, 32 waves x {REG} frames ({REG/SR*1000:.0f} ms each) -> {out}')
