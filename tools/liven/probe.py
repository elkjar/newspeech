"""Mapping round: give every Texture Lab CC a distinct value (seeded), send it, save what was sent.
After the unit's P.EXP is recorded, solve.py lines the export up against the rounds.
usage: probe.py SEED rounds_dir [key=index …]   (force options, e.g. modSync=0)"""
import sys, json, random, subprocess, os
here = os.path.dirname(os.path.abspath(__file__))
schema = json.load(open(os.path.join(here, '..', 'rack', 'devices', 'texturelab.json')))
SKIP = {'efxMode', 'freeze', 'prmLock', 'seqMode'}             # performance states / undocumented
seed, out = int(sys.argv[1]), sys.argv[2]
rnd = random.Random(seed)
params = [p for p in schema['params'] if p.get('cc') is not None and p['key'] not in SKIP]
cont = [p for p in params if not p.get('options')]
params_by = {p['key']: p for p in params}
vals = rnd.sample(range(2, 126), len(cont))                     # distinct, away from the 0/127 ends
sent = {}
for p, v in zip(cont, vals): sent[p['key']] = {'cc': p['cc'], 'value': v, 'ccval': v}
for p in params:
    if p.get('options'):
        n = len(p['options']); i = rnd.randrange(1, n) if n > 2 else rnd.randrange(n)
        step = 127 // (n - 1); ccv = 127 if i == n - 1 else i * step
        sent[p['key']] = {'cc': p['cc'], 'value': i, 'ccval': ccv}
for kv in sys.argv[3:]:
    k, v = kv.split('='); p = next(q for q in params if q['key'] == k); n = len(p['options']); i = int(v)
    sent[k] = {'cc': p['cc'], 'value': i, 'ccval': 127 if i == n - 1 else i * (127 // (n - 1))}
# modes first (a filter-type / voice-mode / sync change resets the controls under it), knobs after; twice
order = [k for k in sent if params_by[k].get('options')] + [k for k in sent if not params_by[k].get('options')]
prog = ['dev "micro lite Port 5"', 'ch 1'] + [f'cc {sent[k]["cc"]} {sent[k]["ccval"]}\n+00.004' for k in order * 2]
os.makedirs(out, exist_ok=True)
open(os.path.join(out, f'round{seed}.json'), 'w').write(json.dumps(sent, indent=1))
open(os.path.join(out, f'round{seed}.txt'), 'w').write('\n'.join(prog) + '\n')
subprocess.run(['sendmidi', 'file', os.path.join(out, f'round{seed}.txt')], check=True)
print(f'round {seed}: sent {len(sent)} params')
