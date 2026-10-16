"""WAV -> LIVEN Texture Lab sample .syx (matches Sonicware's Audio file converter byte layout).
usage: tlsample.py in.wav NAME out.syx [--start SEC] [--no-norm]
       tlsample.py --raw body.bin out.syx   (re-pack a decoded body, for round-trip tests)"""
import sys, struct, zlib, subprocess, re
FRAMES, SR = 192000, 32000
HDR = bytes([0xF0, 0x00, 0x48, 0x04, 0x00, 0x00, 0x06, 0x60])

def pack7(chunk):
    out = []
    for g in range(0, len(chunk), 7):
        grp = chunk[g:g+7]; msb = 0
        for k, b in enumerate(grp): msb |= (b & 0x80) >> (k + 1)
        out += [msb] + [b & 0x7F for b in grp]
    return bytes(out)

def msg(cmd, payload): return HDR + bytes([cmd]) + pack7(payload) + b'\xF7'

def syx(body, kind=2):
    out = msg(1, struct.pack('<II', kind, len(body)))
    for i in range(0, len(body), 210): out += msg(2, body[i:i+210])
    return out + msg(3, struct.pack('<I', zlib.crc32(body)))

def body_from_wav(path, name, start=0.0, norm=True):
    if not re.fullmatch(r'[A-Z0-9 ]\.?[A-Z0-9 ]\.?[A-Z0-9 ]\.?[A-Z0-9 ]', name.upper()):
        sys.exit('name must be 4 chars, optional dots: e.g. WAVE, W.AV.E, DR.N1')
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(start), '-i', path, '-t', '6',
                          '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True, check=True).stdout
    x = list(struct.unpack('<%df' % (len(raw) // 4), raw))[:FRAMES]
    n = len(x)
    g = 1.0
    for i in range(max(0, n - 40), n): g -= 0.025; x[i] *= g          # converter's 40-sample tail fade
    pk = max((abs(v) for v in x), default=0)
    s = (1 / pk) if (norm and pk > 0) else 1.0
    pcm = [max(-32768, min(32767, int(v * s * 32767))) for v in x] + [0] * (FRAMES - n)
    nm = name.upper().encode().ljust(8, b'\0')
    return nm + struct.pack('<Ii', n, 0) + struct.pack('<%dh' % FRAMES, *pcm), n

if __name__ == '__main__':
    a = sys.argv[1:]
    if a[0] == '--raw':
        open(a[2], 'wb').write(syx(open(a[1], 'rb').read())); sys.exit()
    start = float(a[a.index('--start') + 1]) if '--start' in a else 0.0
    body, n = body_from_wav(a[0], a[1], start, '--no-norm' not in a)
    open(a[2], 'wb').write(syx(body)); print(f'{a[1].upper()}: {n} frames = {n/SR:.2f}s -> {a[2]}')
