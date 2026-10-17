import sys, glob, struct, zlib, os, numpy as np, crcmod.predefined as P
fns = {n: P.mkPredefinedCrcFun(n) for n in P._crc_definitions_by_name if P.Crc(n).digest_size == 4}
def sections(b):
    """cmtd + every inner tagged section (tag, size, cksum) found by walking the payload"""
    out = [('cmtd', 0, struct.unpack('<I', b[4:8])[0])]
    p = 0x18
    for o in range(0x10, 0x200, 4):            # inner sections: 4 lowercase letters + 'mtd', size fits
        t = b[o:o + 4]
        if len(t) == 4 and t.endswith(b'mtd') and t != b'cmtd':
            sz = struct.unpack('<I', b[o + 4:o + 8])[0]
            if o + sz <= len(b): out.append((t.decode(), o, sz))
    # walk on from each found section to catch ones further in
    i = 0
    while i < len(out):
        n, o, sz = out[i]
        if n != 'cmtd':
            q = o + sz
            if b[q:q + 4].endswith(b'mtd') and all(q != x[1] for x in out):
                out.append((b[q:q + 4].decode(), q, struct.unpack('<I', b[q + 4:q + 8])[0]))
        i += 1
    return out
hits, report = [], []
for f in sorted(glob.glob(sys.argv[1] + '/*/*.dec') + glob.glob(sys.argv[1] + '/*/*/*.dec')):
    b = open(f, 'rb').read(); name = os.path.basename(f)[:-4]
    for tag, o, sz in sections(b):
        sec = b[o:o + sz]; want = sec[8:12]; report.append(f'{name:30s} {tag} @{o:#x} size {sz:#x} cksum {want.hex()} field12 {sec[12:16].hex()}')
        for fill in (None, b'\0' * 4, b'\xff' * 4):
            v = bytearray(sec)
            if fill: v[8:12] = fill
            for a in (0, 4, 8, 12, 16):
                x = bytes(v[a:])
                a4 = np.frombuffer(x[:len(x) // 4 * 4], '<u4').astype(np.uint64)
                c = {nm: fn(x) for nm, fn in fns.items()} | {'sum8': int(np.frombuffer(x, 'u1').astype(np.uint64).sum()) & 0xffffffff,
                     'sum32': int(a4.sum()) & 0xffffffff, 'adler': zlib.adler32(x)}
                for nm, val in c.items():
                    for e in ('little', 'big'):
                        for inv in (0, 1):
                            if ((val ^ 0xffffffff) if inv else val).to_bytes(4, e) == want: hits.append((name, tag, nm, fill, a, e, inv))
print(*report, sep='\n'); print('HITS:', *hits, sep='\n') if hits else print('no hits on any image')
