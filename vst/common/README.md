# vst/common

The shared UI kit for every newspeech plugin (vibe, saturator, and the ports to
come). One copy, referenced from each plugin's `.jucer` by relative path, so the
suite reads as one instrument and a style change lands everywhere at once.

The look is the Sequence app's (`sequencer/src`): white-on-ink, opacity tiers
instead of colours, square 1px `white/15` borders, SF Mono at 9/10/11/12px with
wide tracking, the ring/arc/tick knob, the dot toggle.

- `ui/NewspeechColors.h` — palette, opacity tiers, type scale, `monoFont()`.
- `ui/NewspeechLookAndFeel` — knob, dot toggle, bordered text button.
- `ui/NewspeechKnob` / `NewspeechToggle` — parameter-bound cell with label below.
- `ui/NewspeechSectionPanel` — a control group with a centred heading.
- `ui/NewspeechButton` — bordered uppercase momentary/latching button.
- `ui/NewspeechEditor` — base editor: frame, crumb, datafield,
  `placeRow()` layout helper, `paramByName()`.

Wiring a plugin: add the `ui/*.cpp|h` files and the asset to the `.jucer`
(`file="../../../common/ui/…"`), set `headerPath="../../../common/ui"` on the
Xcode exporter, derive the editor from `NewspeechEditor`.

`ui/NewspeechDatafield` is the live block in the bottom-right corner (version,
site, sample rate / block / host bpm / transport, and a barcode of recent output
peaks). It reads `newspeech::Telemetry` from the processor, which
`patch-telemetry.sh` wires into a faust2juce-generated processor at build time —
call it from the plugin's `build.sh` right after the host-tempo patch.
