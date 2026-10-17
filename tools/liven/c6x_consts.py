"""Rebuild 32-bit constants from mvk/mvkl + mvkh pairs in a tic6x objdump listing."""
import sys, re, collections
lines = open(sys.argv[1]).read().splitlines()
ins = []
for l in lines:
    m = re.match(r'\s*([0-9a-f]{8}):\s+[0-9a-f]{4,8}\s+(.*)', l)
    if m: ins.append((int(m[1], 16), m[2].strip()))
consts = collections.defaultdict(list); last_lo = {}
for addr, txt in ins:
    txt = txt.lstrip('| ').split(' || ')[0]   # parallel slots are prefixed '||'
    m = re.match(r'(?:\[[!ab0-9]+\]\s*)?(mvkl?|mvkh|mvklh)\s+\.\S+\s+(-?\d+),([ab]\d+)', txt)
    if not m: continue
    op, val, reg = m[1], int(m[2]), m[3]
    if op in ('mvk', 'mvkl'): last_lo[reg] = (addr, val & 0xffff)
    elif op == 'mvkh' and reg in last_lo and addr - last_lo[reg][0] < 0x200:
        consts[((val & 0xffff0000) | last_lo[reg][1]) & 0xffffffff].append(addr)
want = {'cmtd': 0x64746d63, 'pmtd': 0x64746d70, 'mmtd': 0x64746d6d, 'sect': 0x74636573, 'LDKS': 0x534b444c, 'SEQN': 0x4e514553,
        'crc32 refl 0xEDB88320': 0xedb88320, 'crc32 norm 0x04C11DB7': 0x04c11db7, 'crc32c': 0x82f63b78, 'fnv offset': 0x811c9dc5, 'fnv prime': 0x01000193}
print(len(ins), 'instructions,', len(consts), 'distinct 32-bit constants')
for n, v in want.items(): print(f'{n:24s} {v:#010x}:', [hex(a) for a in consts.get(v, [])][:8] or '—')
if len(sys.argv) > 2:
    for v in sys.argv[2:]: print(v, [hex(a) for a in consts.get(int(v, 16), [])])
