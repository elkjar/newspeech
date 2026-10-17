import json, sys
ASSIGN = ["off", "size", "timing", "density", "diffusion", "pitch", "position", "length/fb", "speed", "shape", "jitter", "cutoff", "reso", "blend"]
WAVES = ["sine", "square", "tri", "saw", "rev saw", "random", "smooth rnd", "log", "rev log", "pulse 10%", "pulse 25%", "pulse 75%", "pulse 90%",
         "2 steps", "3 steps", "4 steps", "5 steps", "6 steps", "7 steps", "steps up", "steps down", "keyboard"]
DIR = ["→ · →", "→ · ←", "← · →", "← · ←", "→ · rnd", "← · rnd", ">< · →", ">< · ←", ">< · ><", ">< · rnd", "<> · →", "<> · ←", "<> · <>", "<> · rnd", "random"]
# slots 1-15 factory; 16-32 = WAVES tables loaded 2026-10-16 (tools/liven/tlwavetable.py, waves/*.wav)
FACTORY = ["EPIC", "SKY", "WIDE", "FIZZ", "A.SYN", "CHR.S", "HELL", "VOIZ", "VR.TX", "BELL", "VOID", "PSY.B", "WTR.D", "C.GTR", "WORD",
           "W.MNL", "W.SCP", "W.GRD", "W.PLK", "W.OMN", "W.GLS", "W.TRI", "W.FRS", "W.PLT", "W.ENC", "W.PLS", "W.MDB", "W.PNO", "W.PEA", "W.INV", "W.DRM", "W.SUB"]
SLOTS = [f"{i+1:02d} {FACTORY[i]}" if i < len(FACTORY) else f"{i+1:02d}" for i in range(32)]

def knob(key, name, group, cc, note, panel, default=64, **kw):
    return {"key": key, "name": name, "group": group, "min": 0, "max": 127, "cc": cc, "default": default, "note": note, "panel": panel, **kw}
def enum(key, name, group, cc, options, note, panel, default=0, **kw):
    return {"key": key, "name": name, "group": group, "min": 0, "max": len(options) - 1, "cc": cc, "options": options, "default": default, "note": note, "panel": panel, **kw}
OFFON = ["off", "on"]

params = [
  # sample — what the grains are cut from
  enum("sample", "Sample", "sample", 32, SLOTS, "which of the 32 sample slots the grains are cut from. In EFX mode this knob is line-in level instead", "SRC/IN LVL knob", 0),
  knob("pitch", "Pitch", "sample", 37, "transposes the grains, ±2 octaves (−24.0 … +24.0 semitones); noon = original pitch", "PITCH knob", 64, display="bipolar", valueOffset=-64),
  knob("position", "Position", "sample", 38, "where in the sample grains start — 0 … 6 s across the knob. EFX mode: delay time before the first grain (4 ms … 5.9 s)", "POSITION knob", 0),
  knob("length", "Length / Feedback", "sample", 39, "how wide a window after POSITION the grains are drawn from — small = one focused spot, large = smeared across the sample. EFX mode: feedback", "LENGTH/FB knob", 127),
  knob("blend", "Blend", "sample", 41, "plain sample vs grains: 0 = the sample playing straight, 127 = grains only", "BLEND knob", 127),
  # grain
  knob("size", "Size", "grain", 33, "length of each grain, 2 ms … 1 s. Short = buzzy, pitched texture; long = smooth overlapping chunks", "SIZE knob"),
  knob("shape", "Shape", "grain", 42, "the fade-in/out window on every grain: clicky and hard ↔ soft and blurred", "shift + SIZE"),
  knob("timing", "Timing", "grain", 34, "how often new grains start. Noon = LUSH (densest); left = longer free intervals (M values); right = tempo-synced 1/32 … 1/1", "TIMING knob"),
  knob("jitter", "Jitter", "grain", 43, "random wobble on when each grain starts — 0 = a steady stream, up = scattered", "shift + TIMING", 0),
  knob("density", "Density", "grain", 35, "how many grains overlap, 1 … 64 (cap depends on voice mode: poly 16/voice, mono 32, legato 64). Past noon it also detunes them", "DENSITY knob"),
  knob("diffusion", "Diffusion", "grain", 36, "stereo spread — grains scattered across left/right", "DIFFUSION knob"),
  knob("speed", "Speed", "sample", 40, "playback speed, ¼× … 4×; noon = normal (the manual calls it grain playback speed — it also drives the plain sample). Off in EFX mode", "SPEED knob", 64, display="bipolar", valueOffset=-64),
  enum("dir", "Direction", "sample", 44, DIR, "first arrow = which way grains travel through the sample, second = which way each grain plays. >< and <> bounce; rnd = random. EFX mode uses only the first three", "shift + SPEED", ccSteps=16),
  # random
  knob("posRate", "Pos Rnd Rate", "rnd", 45, "how fast the grain position jumps around randomly", "shift + POSITION", 0),
  knob("posDepth", "Pos Rnd Depth", "rnd", 46, "how far those random position jumps reach", "shift + LENGTH/FB", 0),
  knob("rndSize", "Grain Rnd Size", "rnd", 47, "random variation of SIZE, rolled per grain", "FUNC + step 3, then VALUE", 0),
  knob("rndShape", "Grain Rnd Shape", "rnd", 48, "random variation of SHAPE, rolled per grain", "FUNC + step 4, then VALUE", 0),
  # mod 1
  enum("m1assign", "Mod 1 Assign", "mod1", 49, ASSIGN, "what LFO 1 moves", "FUNC + step 5, then VALUE"),
  enum("m1shape", "Mod 1 Shape", "mod1", 50, WAVES, "LFO 1 waveform; steps = stepped random-ish staircases, keyboard = follows the key played", "FUNC + step 6, then VALUE"),
  knob("m1rate", "Mod 1 Rate", "mod1", 53, "LFO 1 speed (4/1 … 1/32 of a bar when MOD SYNC is on)", "shift + DENSITY"),
  knob("m1depth", "Mod 1 Depth", "mod1", 54, "how far LFO 1 moves its target", "shift + DIFFUSION", 0),
  knob("m1fade", "Mod 1 Fade In", "mod1", 51, "LFO 1 eases in over 0 … 8 s after each note", "FUNC + step 7, then VALUE", 0),
  enum("m1retrig", "Mod 1 Retrig", "mod1", 52, OFFON, "restart LFO 1 on every note", "FUNC + step 8"),
  # mod 2
  enum("m2assign", "Mod 2 Assign", "mod2", 55, ASSIGN, "what LFO 2 moves", "FUNC + step 9, then VALUE"),
  enum("m2shape", "Mod 2 Shape", "mod2", 56, WAVES, "LFO 2 waveform", "FUNC + step 10, then VALUE"),
  knob("m2rate", "Mod 2 Rate", "mod2", 58, "LFO 2 speed", "shift + SRC/IN LVL"),
  knob("m2depth", "Mod 2 Depth", "mod2", 59, "how far LFO 2 moves its target", "shift + PITCH", 0),
  enum("m2retrig", "Mod 2 Retrig", "mod2", 57, OFFON, "restart LFO 2 on every note", "FUNC + step 11"),
  enum("modSync", "Mod Sync", "mod2", 60, OFFON, "lock both LFO rates to the tempo (4/1 … 1/32)", "FUNC + step 12"),
  # envelope / filter / reverb
  knob("attack", "Attack", "eg", 61, "fade-in of each note, 0 … 5 s. Off in EFX mode", "shift + RELEASE", 0),
  knob("release", "Release", "eg", 62, "two zones: 0–41 = gate time (notes cut to 10–90% of their length), 42–127 = release tail 0 … 5 s after the key lets go", "RELEASE knob", 80),
  enum("ftype", "Filter Type", "filter", 68, ["off", "lpf", "hpf", "bpf"], "low pass, high pass or band pass — off bypasses it", "FUNC + step 13, then VALUE"),
  knob("cutoff", "Cutoff", "filter", 69, "filter frequency, 70 Hz … 14.4 kHz", "CUTOFF knob", 127),
  knob("reso", "Resonance", "filter", 70, "filter peak (Q 0.3 … 10); on BPF it sets the band's width instead", "shift + CUTOFF", 0),
  enum("rtype", "Reverb Type", "reverb", 71, ["off", "hall", "room", "arena", "plate", "tunnel", "infinite"], "reverb space — infinite never decays", "FUNC + step 14, then VALUE", 1),
  knob("shimmer", "Shimmer", "reverb", 72, "how much octave-up shimmer feeds the reverb", "SHIMMER knob", 0),
  knob("rmix", "Reverb Mix", "reverb", 73, "reverb level", "shift + SHIMMER", 40),
  knob("lineRev", "Line In → Reverb", "reverb", 74, "sends whatever is on LINE IN straight into the reverb", "FUNC + step 15, then VALUE", 0),
  # voice
  enum("vmode", "Voice Mode", "voice", 26, ["poly", "mono", "legato", "arp"], "poly = 4 voices; mono retriggers each note; legato glides without retriggering; arp arpeggiates held keys", "FUNC + step 1, then VALUE"),
  knob("vadj", "Voice Adjust", "voice", 27, "depends on voice mode — mono/legato: glide time 0 … 10 s; arp: arp type (up, down, up-down, … random, play order) in 12 steps across the knob", "FUNC + step 2, then VALUE", 0),
  enum("octave", "Octave", "voice", 28, ["−3", "−2", "−1", "0", "+1", "+2", "+3"], "keyboard octave", "< / > (OCTAVE) buttons", 3, norandom=True),
  knob("velocity", "Velocity", "voice", 5, "the fixed velocity the keyboard plays at", "shift + BLEND", 100, norandom=True),
  # pattern
  knob("ptnLevel", "Pattern Level", "pattern", 20, "this pattern's output level (before VOL)", "FUNC + step 16, then VALUE", 100, norandom=True),
  knob("swing", "Swing", "pattern", 24, "delays every even step, 0 … 75%", "FUNC + key 6 (SETTING) → SWNG, then VALUE", 0),
  enum("transpose", "Transpose", "pattern", 25, [f"{n:+d}" if n else "0" for n in range(-12, 13)], "shifts the sequence's notes in semitones", "FUNC + key 6 (SETTING) → TRPS, then VALUE", 12, norandom=True),
  enum("rndStep", "Random Step", "pattern", 23, ["off", "1", "2", "4", "8", "16"], "the chunk size the sequence random function shuffles, in steps (random itself: FUNC + 1/5)", "FUNC + key 6 (SETTING) → RND.S, then VALUE"),
  knob("seqMode", "Seq Mode", "pattern", 22, "not documented — probably normal / random / stutter (the FUNC + 1/5 and 2/6 functions)", "FUNC + 1/5 (random), FUNC + 2/6 (stutter)", 0, norandom=True, notInPatch=True),
  enum("prmLock", "Param Lock", "pattern", 21, OFFON, "plays back per-step knob values recorded into the pattern — while on, a locked control snaps back every step, so turning it sounds jumpy (factory patterns are full of them); turn off to tweak freely. Record one: hold a step key + turn a knob; clear all: CLR + PRM LOCK", "PRM LOCK button", 1, norandom=True, notInPatch=True),
  # efx / performance
  enum("efxMode", "EFX Mode", "efx", 29, OFFON, "granulates LINE IN live instead of a sample; POSITION becomes delay time, LENGTH/FB feedback", "EFX MODE button", 0, norandom=True, notInPatch=True),
  enum("efxNote", "EFX Note", "efx", 30, OFFON, "in EFX mode, the keys repitch the effect relative to the low C", "FUNC + step 1 (in EFX mode)", 0, norandom=True),
  *[{"key": f"name{i}", "name": f"Name {i + 1}", "group": "name", "min": 32, "max": 126, "display": "char", "default": 32} for i in range(16)],
  enum("freeze", "Freeze", "efx", 31, OFFON, "stops the grain position where it is (EFX mode: freezes the 6 s input buffer). On the unit, hold FREEZE + OK to latch it", "FREEZE button", 0, norandom=True, notInPatch=True),
]

schema = {
  "id": "texturelab",
  "name": "Sonicware LIVEN Texture Lab",
  "transport": "liven",
  "folder": "Sonicware LIVEN Texture Lab",
  "source": "Sonicware LIVEN Texture Lab manual r2 + MIDI implementation chart (sonicware.co.jp/DL/LIVEN_TextureLab/DOC/); CC spacing for stepped options measured on hardware 2026-10-16 (filter type 0/42/84/127, mod assign 0,9…108,127)",
  "liveNote": "the Texture Lab can't be asked for its settings — knobs follow its panel as you turn them, send pushes every control, patterns live in edit's library",
  "setup": [
    "DIN both ways: interface out → Texture Lab MIDI IN, its MIDI OUT → interface in.",
    "On the unit, FUNC + key 10 (MIDI), pressed repeatedly to step through: RX.CH = edit's channel (or ALL), TX.CH = the same channel, TX.CC = ON (so panel moves reach edit), M.OUT = OUT.",
    "Pattern select rides channel 16 — the unit's PC.CH, which resets to 16 at every power-on — so leave PC.CH alone. It needs M.PC = RX.TX (check it if the dropdown does nothing). While a pattern plays, a change waits for the pattern's end.",
    "Nothing can be read back: when you connect, edit's knobs are guesses until you move them (on either side) or press send.",
    "edit keeps your patterns (Dropbox): store files the current sound under the pattern number; selecting that number later loads the unit's pattern and pushes edit's sound on top — no button on the unit, so it works racked. (The Texture Lab itself can only save from its panel: FUNC + PTN, then OK.)",
    "Hover any control: the line under the program bar says what it does and where it lives on the unit (shift = hold A/a, FUNC = hold func)."
  ],
  "groups": [{"id": g, "name": n} for g, n in [("sample", "Sample"), ("grain", "Grain"), ("rnd", "Random"), ("mod1", "Mod 1"), ("mod2", "Mod 2"),
                                               ("eg", "Envelope"), ("filter", "Filter"), ("reverb", "Reverb"), ("voice", "Voice"), ("pattern", "Pattern"), ("efx", "EFX"), ("name", "Name")]],
  "programs": {"banks": [{"label": "patterns", "count": 128, "write": True}], "perBank": 16, "bankCCs": [], "channel": 16,
               "note": "program change 0-127 on channel 16 = 8 banks × 16 patterns, shown bank·step as on the unit (bank 1 = factory). Needs M.PC = RX on the unit"},
  "params": params,
}
json.dump(schema, open(sys.argv[1] if len(sys.argv) > 1 else __file__.rsplit("/", 2)[0] + "/rack/devices/texturelab.json", "w"), indent=2, ensure_ascii=False)
print(len(params), "params")
