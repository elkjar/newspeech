"""Split a LIVEN full backup (.syx) into its transfers, verify each one's size + CRC-32, and
unpack them: patterns → <out>/patterns/NNN-<name>.bin, samples → <out>/samples/NN-<name>.wav,
anything else → <out>/other/. Incomplete transfers (a cancelled run) are reported and skipped.
usage: backup.py backup.syx outdir"""
import sys, os, struct, zlib, wave, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lvn import msgs, unpack

src, out = sys.argv[1], sys.argv[2]
ms = msgs(open(src, 'rb').read())
xfers, cur = [], None
for m in ms:
    if len(m) < 8: continue
    t = m[7]
    if t == 1: cur = {'hdr': bytes(m[:7]), 'start': unpack(m[8:]), 'data': [], 'end': None}; xfers.append(cur)
    elif cur is None: continue
    elif t == 2: cur['data'].append(unpack(m[8:]))
    elif t == 3: cur['end'] = unpack(m[8:]); cur = None
print(f'{len(ms)} messages, {len(xfers)} transfers')
kinds, bad = collections.Counter(), []
for d in ('patterns', 'samples', 'other'): os.makedirs(os.path.join(out, d), exist_ok=True)
n_pat = n_smp = 0
for i, x in enumerate(xfers):
    kind, size = struct.unpack('<II', x['start'][:8])
    body = b''.join(x['data'])
    ok_size = len(body) == size
    ok_crc = x['end'] is not None and x['end'][:4] == zlib.crc32(body).to_bytes(4, 'little')
    kinds[kind] += 1
    if x['end'] is None: bad.append((i, kind, 'incomplete (no end message)')); continue
    if not (ok_size and ok_crc): bad.append((i, kind, f'size {len(body)}/{size} crc {"ok" if ok_crc else "BAD"}')); continue
    if kind == 0 and body[:4] == b'LDKS':
        name = body[0x20:0x28].split(b'\0')[0].decode('ascii', 'replace')
        open(os.path.join(out, 'patterns', f'{n_pat:03d}-{name}.bin'), 'wb').write(body); n_pat += 1
    elif kind == 2 and len(body) == 16 + 2 * 192000:
        name = body[:8].split(b'\0')[0].decode('ascii', 'replace'); frames = struct.unpack('<I', body[8:12])[0]
        w = wave.open(os.path.join(out, 'samples', f'{n_smp + 1:02d}-{name or "empty"}.wav'), 'wb')
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(32000); w.writeframes(body[16:16 + 2 * frames]); w.close(); n_smp += 1
    else:
        open(os.path.join(out, 'other', f'{i:03d}-kind{kind}.bin'), 'wb').write(body)
print('kinds:', dict(kinds), f'→ {n_pat} patterns, {n_smp} samples')
print('problems:' if bad else 'all transfers verified', *[f'\n  #{i} kind {k}: {why}' for i, k, why in bad])
