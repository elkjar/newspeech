#!/usr/bin/env python3
"""Turn up to 8 Sequence kits into Bitbox Micro multisample folders.

    python3 -I tools/bitbox/bitbox-preset.py [options] KIT [KIT ...]

KIT (in pad order — pad 1 / MIDI ch 1 first) is any of:
  - a kit folder containing kit.seqkit           pads/monolith
    (relative paths resolve against the SAMPLES library in Dropbox)
  - a waves.html PRINT zip                        ~/Downloads/glass.zip

Per kit: root notes come from kit.seqkit (so the Bitbox maps notes exactly
like Sequence — C1 = MIDI 24, C4 = 60), audio is summed to mono, the silent
tail (< -60 dBFS) is trimmed with a 50 ms fade, and each file is written as
<name>-NNN.wav (NNN = MIDI root) with smpl + inst chunks carrying the root.
Sources are only read, never modified.

Round-robin kits (waves PRINT): the Bitbox has no round-robin. Default keeps
take 1 per root. --takes N keeps N takes and splits the velocity range
between them (file names <name>-NNN-LO-HI.wav + inst chunk), so how hard a
note is hit picks the take — a pseudo round-robin at N x the memory.

Fitting 8 long kits (waves prints run ~19 MB each) into one preset:
--every N keeps every Nth root (2 = 8 of the 16 C/E/G# roots, 8 semitones
apart, so no note is pitched more than ±4), --max-secs S caps each file at
S seconds with a 1 s fade (cuts into a printed reverb tail, not the hold).

Output: OUT/<pad>-<name>/ per kit (numbered so the Bitbox's alphabetical
file list matches pad order). On the Bitbox: open any file in a folder,
File -> Load All, set that pad's MIDI channel. Keep the total under the
Micro's 64 MB RAM; past that, samples stream from the card (8 voices max).
"""
import argparse, array, json, os, re, shutil, struct, subprocess, sys, tempfile, wave, zipfile

SAMPLES = os.path.expanduser(
    "~/Library/CloudStorage/Dropbox-Personal/___MUSIC/___NEWSPEECH/__SEQUENCE/SAMPLES")
THRESH_DB = -60.0
FADE_S = 0.05
CAP_FADE_S = 1.0
RAM_MB = 64


def find_kit_dir(arg, tmp):
    """Folder holding kit.seqkit for a kit folder, a relative library path, or a zip."""
    path = os.path.expanduser(arg)
    if not os.path.exists(path) and os.path.exists(os.path.join(SAMPLES, arg)):
        path = os.path.join(SAMPLES, arg)
    if zipfile.is_zipfile(path):
        dest = os.path.join(tmp, f"zip{len(os.listdir(tmp))}")
        with zipfile.ZipFile(path) as z:
            z.extractall(dest)
        path = dest
    if os.path.isfile(os.path.join(path, "kit.seqkit")):
        return path
    hits = [r for r, _, fs in os.walk(path) if "kit.seqkit" in fs]
    if len(hits) != 1:
        sys.exit(f"{arg}: expected exactly one kit.seqkit, found {len(hits)}")
    return hits[0]


def last_audible(path):
    w = wave.open(path, "rb")
    n, ch, sr, sw = w.getnframes(), w.getnchannels(), w.getframerate(), w.getsampwidth()
    raw = w.readframes(n)
    w.close()
    if sw == 2:
        a, full = array.array("h", raw), 32768
    elif sw == 3:  # 24-bit: keep the top 16 bits, plenty for a -60 dB gate
        a, full = array.array("h", b"".join(raw[i + 1:i + 3] for i in range(0, len(raw), 3))), 32768
    elif sw == 4:
        a, full = array.array("i", raw), 2 ** 31
    else:
        return n / sr, n / sr
    thr = full * 10 ** (THRESH_DB / 20)
    for i in range(len(a) - 1, -1, -1):
        if abs(a[i]) > thr:
            return (i // ch) / sr, n / sr
    return 0.0, n / sr


def add_chunks(path, root, vel_lo, vel_hi):
    d = bytearray(open(path, "rb").read())
    assert d[:4] == b"RIFF" and d[8:12] == b"WAVE"
    sr, i = None, 12
    while i + 8 <= len(d):
        sz = struct.unpack("<I", d[i + 4:i + 8])[0]
        if d[i:i + 4] == b"fmt ":
            sr = struct.unpack("<I", d[i + 12:i + 16])[0]
        i += 8 + sz + (sz & 1)
    # smpl: manufacturer, product, period ns, unity note, pitch fraction,
    # SMPTE fmt/offset, 0 loops, 0 sampler data — no loop, so no looping
    smpl = struct.pack("<9I", 0, 0, round(1e9 / sr), root, 0, 0, 0, 0, 0)
    # inst: unshifted note, fine tune, gain, low/high note, low/high velocity
    inst = struct.pack("<BbbBBBB", root, 0, 0, 0, 127, vel_lo, vel_hi) + b"\x00"
    d += b"smpl" + struct.pack("<I", len(smpl)) + smpl
    d += b"inst" + struct.pack("<I", 7) + inst  # 7 data bytes + pad byte
    d[4:8] = struct.pack("<I", len(d) - 8)
    open(path, "wb").write(d)


def vel_ranges(n):
    edges = [round(1 + 127 * k / n) for k in range(n + 1)]
    return [(edges[k], edges[k + 1] - 1 if k < n - 1 else 127) for k in range(n)]


def convert(kit_dir, pad, out, takes, mono, every=1, max_secs=None):
    kit = json.load(open(os.path.join(kit_dir, "kit.seqkit")))
    voices = list(kit["voices"].values())
    roots = voices[0]["roots"]
    for v in voices[1:]:  # extra voices (e.g. a granular variant) share the files
        if v.get("roots") != roots:
            sys.exit(f"{kit_dir}: voices disagree on roots — pick one kit per voice")
    name = re.sub(r"[^a-z0-9]", "", kit.get("name", os.path.basename(kit_dir)).lower()) or "kit"
    odir = os.path.join(out, f"{pad}-{name}")
    os.makedirs(odir)
    seen, nfiles = set(), 0
    for r in roots[::every]:
        midi = r["midi"]
        if midi in seen:
            sys.exit(f"{kit_dir}: duplicate root {midi}")
        seen.add(midi)
        files = r["files"][:takes]
        layered = len(files) > 1
        for (lo, hi), f in zip(vel_ranges(len(files)), files):
            src = os.path.join(kit_dir, f)
            end, dur = last_audible(src)
            keep = int(min(dur, end + FADE_S) * 10000) / 10000  # never past the end
            fade = FADE_S
            if max_secs and keep > max_secs:
                keep, fade = max_secs, CAP_FADE_S
            stem = f"{name}-{midi:03d}" + (f"-{lo:03d}-{hi:03d}" if layered else "")
            dst = os.path.join(odir, stem + ".wav")
            with tempfile.TemporaryDirectory() as td:
                tmp = os.path.join(td, "x.wav")
                # sox writes only fmt/data — drops cue/LIST/bext and other
                # exporter chunks; remix - = mono mixdown with headroom
                # -D: no dither, so re-running gives byte-identical files
                cmd = ["sox", src, "-D", "-b", "16", tmp] + (["remix", "-"] if mono else []) + [
                    "trim", "0", f"{keep:.4f}", "fade", "t", "0", f"{keep:.4f}", f"{fade}"]
                subprocess.run(cmd, check=True)
                add_chunks(tmp, midi, lo if layered else 0, hi if layered else 127)
                shutil.move(tmp, dst)
            nfiles += 1
    size = sum(os.path.getsize(os.path.join(odir, f)) for f in os.listdir(odir))
    return os.path.basename(odir), nfiles, size, min(seen), max(seen)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("kits", nargs="+", help="kit folders / library paths / PRINT zips, pad order")
    ap.add_argument("-o", "--out", default="~/Desktop/bitbox-preset", help="output folder (must not exist)")
    ap.add_argument("--takes", type=int, default=1, help="round-robin takes to keep per root, as velocity layers")
    ap.add_argument("--every", type=int, default=1, help="keep every Nth root (2 = half the roots, half the memory)")
    ap.add_argument("--max-secs", type=float, help="cap each file at this many seconds (1 s fade)")
    ap.add_argument("--stereo", action="store_true", help="keep stereo files (default: sum to mono)")
    a = ap.parse_args()
    if len(a.kits) > 8:
        sys.exit("the Bitbox Micro has 8 pads — pass at most 8 kits")
    out = os.path.expanduser(a.out)
    if os.path.exists(out):
        sys.exit(f"{out} already exists — pick another --out (renders are never overwritten)")
    os.makedirs(out)
    total = 0
    with tempfile.TemporaryDirectory() as tmp:
        for pad, k in enumerate(a.kits, 1):
            folder, n, size, lo, hi = convert(find_kit_dir(k, tmp), pad, out, max(1, a.takes), not a.stereo,
                                              max(1, a.every), a.max_secs)
            total += size
            print(f"pad {pad} / ch {pad}  {folder:22s} {n:3d} files  {size / 1048576:5.1f} MB  roots {lo}-{hi}")
    mb = total / 1048576
    print(f"TOTAL {mb:.1f} MB -> {out}")
    if mb > RAM_MB:
        print(f"  over the Micro's {RAM_MB} MB RAM: extra streams from the card (8 voices max) —"
              " drop --takes, or trim long pads")


if __name__ == "__main__":
    main()
