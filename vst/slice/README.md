# slice

A free macOS audio effect plugin (AU + VST3) by [newspeech](https://www.newspeechsound.com) — the plugin form of [slice](https://www.newspeechsound.com/slice.html). Type a message and it plays as a tempo-locked rhythm; the pattern gates a tone or your input, then MANGLE erodes it:

- **pattern** — MORSE (dits and dahs; letter and word spacing fall out for free), BITS (each character as its 8 ASCII bits), DATA (paste a numeric series — the threshold decides the hits). DAH / GAP / LETTER / WORD are the spacing ratios; 3/1/3/7 is regulation morse and every one of them can break.
- **clock** — locked to the host transport (position = song position, so the pattern sits on the grid and survives loops). Stopped, or in the standalone, it free-runs at the host bpm or the BPM knob. RATE and FEEL pick the dit.
- **source** — TONE (SIN/TRI/SQR/SAW, FREQ, DAH± = long hits at an offset pitch) or INPUT.
- **capture** (INPUT) — GATE gates the live input (DAH± bends its speed for the length of a long hit). CHOP and SCAN slice the *previous pass* of input: CHOP punches in where continuous playback would be, SCAN grabs from a random spot. FREEZE holds that loop.
- **shape** — ATTACK, RELEASE, DEPTH (bleed between hits), LEVEL.
- **mangle** — FLIP / RATCHET / DROP dice per pass, SCRAMBLE corrupting the message itself; DECAY on = the corruption accumulates, off = fresh dice against the original every pass. RESTORE puts the message back.

Part of the newspeech plugin suite alongside `vibe`, `saturate`, and `glitch`. The UI is the shared kit in [`../common`](../common). No Faust here — slice is a plain JUCE project (`juce/slice/Source`).

## Build

JUCE at `~/JUCE` with Projucer built, full Xcode:

```sh
bash build.sh                 # build + install to ~/Library/Audio/Plug-Ins (ad-hoc signed)
STANDALONE=1 bash build.sh    # also build the standalone app (for screenshots)
SIGN=1 bash build.sh          # + Developer-ID sign, notarize, staple (needs ../common/dist/.signing-config)
```

## License

GPLv3 — see [LICENSE](LICENSE). Free for everything you make with it; if it ends up on something cool, share it.
