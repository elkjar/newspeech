# saturate

A free macOS audio effect plugin (AU + VST3) by [newspeech](https://www.newspeechsound.com). Drive morph into a Blades-style filter, with a PurPLL-flavoured micro-loop that grabs and repeats slices when the signal crosses a threshold:

- **loop** — threshold-triggered micro-loop capture, diced by `chance`, windowed and divided against the host BPM.
- **destroy** — tilt, bias, and drive into the saturation curve.
- **filter** — tone and body.
- **out** — trim and mix.

Part of the newspeech plugin suite alongside `vibe`, `glitch`, and `slice`. The UI is the shared kit in [`../common`](../common).

## Build

Same Faust → JUCE pipeline as vibe (`brew install faust`, JUCE at `~/JUCE` with Projucer built, full Xcode):

```sh
bash build.sh          # build + install to ~/Library/Audio/Plug-Ins (ad-hoc signed)
SIGN=1 bash build.sh   # + Developer-ID sign, notarize, staple (needs ../common/dist/.signing-config)
```

## License

GPLv3 — see [LICENSE](LICENSE). Free for everything you make with it; if it ends up on something cool, share it.
