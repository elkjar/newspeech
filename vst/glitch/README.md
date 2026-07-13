# glitch

A free macOS audio effect plugin (AU + VST3) by [newspeech](https://www.newspeechsound.com). Three destruction stages in series:

- **tape** — a loop buffer that grabs incoming audio and mangles it: position/length scrubbing, granular layer, hold, reverse.
- **glitch** — tempo-synced beat repeat, diced per trigger by `chance`, locked to the host session BPM.
- **reverb** — a Griesinger-style plate to smear whatever survives.

Nothing about it is subtle or transparent. That's the point.

## Build

Faust → JUCE pipeline, macOS only:

- `brew install faust` (needs `FAUST_INSTALL=/opt/homebrew`)
- JUCE cloned at `~/JUCE` with Projucer built (`extras/Projucer/Builds/MacOSX`)
- full Xcode (not just Command Line Tools)

```sh
bash build.sh          # build + install to ~/Library/Audio/Plug-Ins (ad-hoc signed)
SIGN=1 bash build.sh   # + Developer-ID sign, notarize, staple (needs dist/.signing-config)
```

`build.sh` regenerates the JUCE wrapper from `dsp/combined.dsp` via faust2juce, patches in the custom editor (`juce/combined/Source/GlitchEditor.*`), host-tempo override, hidden-parameter filtering, and a zone-backed `getValue()`, then builds universal (arm64 + x86_64) AU and VST3 targets.

## License

GPLv3 — see [LICENSE](LICENSE). The build patches the Faust-generated architecture section, so the whole work is distributed under plain GPL terms (the Faust architecture exception doesn't apply), which also satisfies JUCE's open-source tier.
