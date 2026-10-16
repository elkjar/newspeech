"""Record every SysEx from one MIDI input into a .syx file (rtmidi assembles whole messages).
Prints progress every 2000 messages; stops after IDLE seconds of silence once data has started."""
import sys, time, rtmidi
port_name, out_path = sys.argv[1], sys.argv[2]
IDLE = float(sys.argv[3]) if len(sys.argv) > 3 else 60
mi = rtmidi.MidiIn(rtmidi.API_MACOSX_CORE, queue_size_limit=65536)
idx = [i for i, p in enumerate(mi.get_ports()) if p == port_name][0]
mi.ignore_types(sysex=False, timing=True, active_sense=True)
f = open(out_path, 'wb'); n = 0; total = 0; last = None; bad = 0
def cb(ev, _):
    global n, total, last, bad
    msg = bytes(ev[0])
    if msg[:1] != b'\xf0': return
    if msg[-1:] != b'\xf7': bad += 1
    f.write(msg); n += 1; total += len(msg); last = time.time()
    if n % 2000 == 0: f.flush(); print(f'{n} msgs, {total:,} bytes', flush=True)
mi.set_callback(cb); mi.open_port(idx)
print(f'recording {port_name} -> {out_path}', flush=True)
try:
    while True:
        time.sleep(1)
        if last and time.time() - last > IDLE: break
finally:
    mi.close_port(); f.close()
    print(f'DONE {n} msgs, {total:,} bytes, {bad} without F7', flush=True)
