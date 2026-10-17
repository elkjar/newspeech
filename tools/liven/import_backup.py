"""Fill edit's Texture Lab library from a full backup: every pattern edit doesn't already hold
becomes an entry with source "unit" (shown on switch, never pushed). Patterns you stored in edit
are left alone. Keeps a copy of the old library.json beside it.
usage: import_backup.py backup.syx library.json"""
import sys, os, json, struct, zlib, shutil, datetime
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from lvn import msgs, unpack
from patmap import decode
src, lib_path = sys.argv[1], sys.argv[2]
ms = msgs(open(src, 'rb').read())
end = [m for m in ms if m[7] == 3][-1]
body = b''.join(unpack(m[8:]) for m in ms if m[7] == 2)
assert unpack(end[8:])[:4] == zlib.crc32(body).to_bytes(4, 'little'), 'backup CRC failed — not importing'
lib = json.load(open(lib_path)) if os.path.exists(lib_path) else {}
if os.path.exists(lib_path): shutil.copy(lib_path, lib_path.replace('.json', f'.before-import-{datetime.date.today()}.json'))
at = datetime.datetime.now(datetime.timezone.utc).isoformat()
added = kept = 0
for i in range(128):
    key = f'0-{i}'
    if key in lib and lib[key].get('source') != 'unit': kept += 1; continue
    name, bpm, vals = decode(body[0x1000 + i * 0x2000: 0x1000 + i * 0x2000 + 5816])
    for j in range(16): vals[f'name{j}'] = ord(name[j]) if j < len(name) and 32 <= ord(name[j]) < 127 else 32
    lib[key] = {'values': vals, 'at': at, 'source': 'unit', 'bpm': bpm}; added += 1
tmp = lib_path + '.tmp'; json.dump(lib, open(tmp, 'w')); os.replace(tmp, lib_path)
print(f'{added} patterns from the unit, {kept} of yours kept → {lib_path}')
