import sys, zlib, crcmod.predefined as P, numpy as np
b = open(sys.argv[1], 'rb').read()
secs = {'cmtd': (0, len(b)), 'pmtd': (0x48, 0x97948), 'mmtd': (0x97990, 0x1118e9)}
want = {n: b[o + 8:o + 12] for n, (o, l) in secs.items()}
fns = {n: P.mkPredefinedCrcFun(n) for n in P._crc_definitions_by_name if P.Crc(n).digest_size == 4}
fns |= {'crc16x2': None}
del fns['crc16x2']
def cands(x):
    a = np.frombuffer(x[:len(x) // 4 * 4], '<u4').astype(np.uint64)
    out = {nm: f(x) for nm, f in fns.items()}
    out |= {'sum8': sum(x) & 0xffffffff, 'sumw': int(a.sum()) & 0xffffffff, 'adler': zlib.adler32(x),
            'xorw': int(np.bitwise_xor.reduce(a.astype(np.uint32))) if len(a) else 0}
    return out
hits = []
for n, (o, l) in secs.items():
    sec = b[o:o + l]
    for fill in (None, b'\0' * 4, b'\xff' * 4):
        v = bytearray(sec)
        if fill: v[8:12] = fill
        for a in (0, 4, 8, 12, 16, 20, 24):
            for e in (0, 4, 8):
                x = bytes(v[a:len(v) - e])
                for nm, c in cands(x).items():
                    for endian in ('little', 'big'):
                        for inv in (0, 1):
                            if ((c ^ 0xffffffff) if inv else c).to_bytes(4, endian) == want[n]:
                                hits.append((n, nm, fill.hex() if fill else 'raw', a, e, endian, inv))
print(len(fns), 'CRC-32 defs + 4 sums,', 3 * 3 * 7 * 3, 'ranges per section')
print('HITS:', *hits, sep='\n') if hits else print('no hits')
