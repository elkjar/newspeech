"""Line mapping-round exports up against what probe.py sent: for every param, the byte offsets
(in SQPS / SQPM / SQPR) holding the sent value or option index in EVERY round.
usage: solve.py rounds_dir N [N…]   (rounds_dir has roundN.json + exportN.syx)"""
import sys, os, json, struct, zlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lvn import msgs, unpack
def body_of(path):
    ms = msgs(open(path, 'rb').read())
    data = [m for m in ms if m[7] == 2]; end = [m for m in ms if m[7] == 3]
    b = b''.join(unpack(m[8:]) for m in data)
    assert end and unpack(end[0][8:])[:4] == zlib.crc32(b).to_bytes(4, 'little'), f'{path}: CRC failed'
    return b
def chunks(b):
    out, off = {}, 0x10
    while off < len(b):
        tag = b[off:off + 4].decode(); sz = struct.unpack('<I', b[off + 4:off + 8])[0]; out[tag] = b[off + 8:off + sz]; off += sz
        if tag == 'SQSD': break
    return out
d, ns = sys.argv[1], sys.argv[2:]
rounds = [(json.load(open(os.path.join(d, f'round{n}.json'))), chunks(body_of(os.path.join(d, f'export{n}.syx')))) for n in ns]
cells = [(t, i) for t in ('SQPS', 'SQPM', 'SQPR') for i in range(len(rounds[0][1][t]))]
for key in rounds[0][0]:
    hits = [f'{t}+{i}' for t, i in cells if all(r[1][t][i] in (r[0][key]['value'], r[0][key]['ccval']) for r in rounds)]
    how = {f'{t}+{i}': ('index' if all(r[1][t][i] == r[0][key]['value'] for r in rounds) else 'ccval') for t, i in cells if f'{t}+{i}' in hits}
    print(f'{key:10s} cc{rounds[0][0][key]["cc"]:<3d} sent {",".join(str(r[0][key]["value"]) for r in rounds):12s} → {", ".join(f"{h} ({how[h]})" for h in hits) or "—"}')
