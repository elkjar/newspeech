"""Texture Lab pattern bytes → edit's param values (CC domain; option index for lists).
Mapped 2026-10-16 from 5 probe rounds (probe.py / solve.py) against P.EXP exports.
Offsets are into each chunk's body (after its 8-byte tag+size)."""
import struct

def s8(b): return b - 256 if b > 127 else b
def speed(b): b = s8(b); return b + 63 if b < 0 else b + 64          # stored v-63 below noon, v-64 above
def pitch(b): return max(0, min(127, 64 + round(s8(b) / 0.935)))       # ±1 — small curve near centre
def swing(b): return min(127, round((b + 0.5) * 127 / 75))             # stored as whole % (0-75): ±2
# assign: off = 255, size…reso = 0…11, blend = 13 (12 never seen)
def assign(b): return 0 if b == 255 else 13 if b >= 12 else b + 1

# key: (chunk, offset, decode)
MAP = {
  'sample': ('SQPM', 8, None), 'position': ('SQPM', 9, None), 'length': ('SQPM', 10, None), 'density': ('SQPM', 11, None),
  'size': ('SQPM', 12, None), 'pitch': ('SQPM', 13, pitch), 'speed': ('SQPM', 14, speed), 'diffusion': ('SQPM', 15, None),
  'blend': ('SQPM', 16, None), 'shape': ('SQPM', 17, None), 'dir': ('SQPM', 18, None), 'rndSize': ('SQPM', 19, None),
  'rndShape': ('SQPM', 20, None), 'timing': ('SQPM', 21, None), 'jitter': ('SQPM', 22, None),
  'm1assign': ('SQPM', 32, assign), 'm1shape': ('SQPM', 33, None), 'm1fade': ('SQPM', 34, None),
  'm1retrig': ('SQPM', 35, None), 'm1rate': ('SQPM', 36, 'rate'), 'm1depth': ('SQPM', 37, None),
  'm2assign': ('SQPM', 38, assign), 'm2shape': ('SQPM', 39, None), 'm2retrig': ('SQPM', 41, None),
  'm2rate': ('SQPM', 42, 'rate'), 'm2depth': ('SQPM', 43, None), 'posRate': ('SQPM', 44, 'rate'), 'posDepth': ('SQPM', 45, None),
  'modSync': ('SQPM', 46, None), 'ftype': ('SQPM', 47, None), 'cutoff': ('SQPM', 48, None), 'reso': ('SQPM', 49, None),
  'vmode': ('SQPM', 50, None), 'vadj': ('SQPM', 51, 'vadj'), 'attack': ('SQPM', 53, None), 'release': ('SQPM', 54, None),
  'octave': ('SQPM', 55, lambda b: s8(b) + 3),
  'ptnLevel': ('SQPS', 10, None), 'rtype': ('SQPS', 11, None), 'shimmer': ('SQPS', 12, None), 'rmix': ('SQPS', 13, None),
  'lineRev': ('SQPS', 14, None),
  'swing': ('SQPR', 13, swing), 'transpose': ('SQPR', 14, lambda b: s8(b) + 12), 'rndStep': ('SQPR', 17, None),
}

def chunks(body):
    out, off = {}, 0x10
    while off + 8 <= len(body):
        tag = body[off:off + 4].decode('ascii', 'replace'); sz = struct.unpack('<I', body[off + 4:off + 8])[0]
        out[tag] = body[off + 8:off + sz]; off += sz
        if tag == 'SQSD' or sz < 8: break
    return out

def decode(body):
    """→ (name, bpm, values) for one LDKS pattern body"""
    c = chunks(body)
    name = c['SEQN'][8:].split(b'\0')[0].decode('ascii', 'replace')
    bpm = struct.unpack('<H', c['SQPS'][8:10])[0] / 10
    sync = c['SQPM'][46]
    vals = {}
    for k, (t, i, f) in MAP.items():
        b = c[t][i]
        if f == 'rate': v = b * 9 + 5 if sync else b                  # synced: division = (cc-1)//9
        elif f == 'vadj':                                              # glide in mono/legato; arp type isn't here
            if c['SQPM'][50] == 3: continue
            v = b
        elif f: v = f(b)
        else: v = b
        vals[k] = v
    return name, bpm, vals
