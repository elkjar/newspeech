# glitch

A free macOS audio effect plugin (AU + VST3) by [newspeech](https://www.newspeechsound.com) — the plugin form of [glitch](https://www.newspeechsound.com/glitch.html), the audio destruction engine, re-anchored from a dropped file to your session's bars.

Six stages in a fixed serial order — **CRUSH → NOISE → DRIVE → CHOP → GLITCH → FEEDBACK** — each a lane on a grid of 1–8 bars. Draw a block and the stage is in the signal path for that span, with its own settings: band scope (LO/HI), MIX, the stage's knobs and switches, and optionally an accumulator that climbs one knob every time the block fires. Every pass through the pattern is a generation: each lane's MUTATE reshapes its blocks (shift, resize, split, rarely add, easily remove) while the grid keeps showing what you drew. A six-hex SEED populates the grid with random glitches and drives every dice roll, so a seed is a take; AUTO re-seeds on every transport start.

- **crush** — bit depth, sample-rate division, bitrot (crackle, then dropouts).
- **noise** — the Mörser: clocked digital noise into a squelching filter, edge-pinged by the signal; FREE or SIGNAL clock.
- **drive** — boost / tube / fuzz / square.
- **chop** — a bar-locked gate (period in grid cells) or a threshold gate.
- **glitch** — repeats cut from the input: stutter, reverse, octaves, silence, tape stop, shuffle; chance per capture.
- **feedback** — the output back into the chain, delayed and toned; runs away past 100.

Part of the newspeech plugin suite alongside `vibe`, `saturate`, and `slice`. The UI is the shared kit in [`../common`](../common). Plain JUCE, no Faust (`juce/glitch/Source`).

## Build

JUCE at `~/JUCE` with Projucer built, full Xcode:

```sh
bash build.sh                 # build + install to ~/Library/Audio/Plug-Ins (ad-hoc signed)
STANDALONE=1 bash build.sh    # also build the standalone app (for screenshots)
SIGN=1 bash build.sh          # + Developer-ID sign, notarize, staple (needs ../common/dist/.signing-config)
```

## License

GPLv3 — see [LICENSE](LICENSE). Free for everything you make with it; if it ends up on something cool, share it.
