"""Unpack a LIVEN system-firmware image (decoded with lvn.py) into its load sections and disassemble.
usage: fw_extract.py fw.bin outdir   → outdir/sect_<addr>.bin + main.s (largest section)
needs: brew install binutils  (objdump with the tic6x target)"""
import sys, os, struct, subprocess
b = open(sys.argv[1], 'rb').read(); out = sys.argv[2]; os.makedirs(out, exist_ok=True)
o = b.index(b'mmtd'); p = b.index(b'sect', o); sects = []
while b[p:p + 4] == b'sect':
    addr, ln = struct.unpack('<II', b[p + 4:p + 12]); sects.append((addr, ln))
    open(f'{out}/sect_{addr:08x}.bin', 'wb').write(b[p + 12:p + 12 + ln]); p += 12 + ln
print('entry', hex(struct.unpack('<I', b[o + 0x1c:o + 0x20])[0]), [f'{a:#x}+{l:#x}' for a, l in sects])
a, l = max(sects, key=lambda s: s[1])
with open(f'{out}/main.s', 'w') as f:
    subprocess.run(['/opt/homebrew/opt/binutils/bin/objdump', '-b', 'binary', '-m', 'tic6x', '-EL', f'--adjust-vma={a:#x}', '-D', f'{out}/sect_{a:08x}.bin'], stdout=f, check=True)
