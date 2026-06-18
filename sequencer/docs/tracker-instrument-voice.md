# Tracker instrument voice + `.pti` export

Goal: a **Polyend Tracker instrument voice type** inside Sequence. Author and audition a sound
locally (Sequence audio = design monitor), then write a `.pti` the Tracker loads and play it on
hardware over MIDI. Ordering decision (2026-06-17): build the Tracker voice **before** generic
instrument-mode upgrades; granular comes **after** the format round-trip, before slice.

This doc is the grounded spec from the 2026-06-17 research pass. Status: **format layer scaffolded
+ verified headless; engine DSP + UI + hardware verification not started.**

## The library

`@polyend/tracker-lib` v0.1.1 (MIT, ESM-only, `node >=20`) — installed into the sequencer
(`package.json` dependency). It IS the data model; we don't hand-roll the `.pti` binary.

Public API (`dist/index.d.ts`):
- `Tracker.createInstrument(wavBuffer?, slices?) → InstrumentData` — build with sane defaults
- `Tracker.writeInstrument(instrument, filename?) → Promise<void>` — Node writes a file path; browser path emits a download/`File`
- `Tracker.readInstrument(file: string | File) → Promise<InstrumentData | null>`
- `Tracker.createPattern(numTracks, numSteps)` / `read/writePattern` — **numTracks = 12 (OG Tracker) or 16 (Tracker+/Mini)**, numSteps 1–128. (Corrects the earlier "8 tracks" assumption.)
- `Tracker.createProject(name)` / `read/writeProject`
- `AudioUtil.createWavFile(Float32Array, {numChannels, sampleRate, bitsPerSample}) → ArrayBuffer`,
  `AudioUtil.getWavInfo(wav) → WavInfo`

**Sample constraint:** the `.pti` `wav` field must be a **16-bit 44.1kHz WAV**. Convert on export.

## `.pti` instrument schema (`InstrumentData`)

- `playmode: InstrumentPlayMode` — `OneShot 0 · ForwardLoop 1 · BackwardLoop 2 · PingpongLoop 3 · Slice 4 · BeatSlice 5 · Wavetable 6 · Granular 7`
- `volume` 0.0–2.0 (0.0 = 0 dB) · `panning` -1.0–1.0 · `overdrive` 0–100 · `delaySend`/`reverbSend` 0.0–1.0
- Filter: `filterEnabled` · `filterType` (`LowPass 0 · HighPass 1 · BandPass 2`) · `cutoff` 0.0–1.0 · `resonance` 0.0–4.3
- Tuning: `tune` -24..24 semitones · `finetune` -100..100 cents
- Sample window: `startPoint`/`endPoint`/`loopPoint1`/`loopPoint2` — 0–65535 frames · `bitdepth` 4–16
- Slices: `slices[48]` (0–65535 each) · `numSlices` 0–47 · `selectedSlice`
- `granular: Granular` (below) · `wavetableCurrentWindow`
- `sample: SampleBankSlot` { type (WaveFile/Wavetable), filename ≤32 bytes, length, channels, wavetable{windowSize ∈ {32..2048}, windowCount} }
- `automations: Automation[]` (below) · `header` (auto-created, ignore)

### Automations — 6 fixed positional slots

`automations[i]` targets are **fixed by index**:

| idx | target |
|-----|--------|
| 0 | Volume |
| 1 | Panning |
| 2 | Cutoff |
| 3 | Wavetable Position |
| 4 | **Granular Position** |
| 5 | Finetune |

Each `Automation` = `{ enabled, isLFO, envelope, lfo }`. If `isLFO` use `lfo`, else `envelope`.
- `Envelope` = `{ amount 0–1, delay, attack, decay (ms ints), sustain 0–1, release (ms) }`
- `LFO` = `{ shape (RevSaw/Saw/Triangle/Square/Random), speed (clock-divided enum 1/128…128), amount 0–1 }`

### Granular — the whole model (single-grain)

```
Granular = {
  grainLength:     44–44100 samples (1ms–1s),
  currentPosition: 0–65535 (position into sample),
  shape:           Square 0 | Triangle 1 | Gauss 2   // grain window / crossfade
  type:            Forward 0 | Backward 1 | PingPong 2 // read direction
}
```

**Reverse-engineering conclusion: no firmware work needed — the format is the spec.** The Tracker's
granular engine is documented single-grain (one grain at a time, not a cloud). The DSP is: a single
windowed read of `grainLength` samples at `currentPosition`, shaped by Square/Triangle/Gauss, read
Forward/Backward/PingPong, with position swept by `automations[4]` (envelope or LFO). That's a
windowed read-head — a couple dozen lines, not a grain scheduler. Only the exact Gauss width and the
grain-repeat behavior need by-ear calibration on hardware later; everything else is pinned.

Implication for our local audition: the native engine's tape-grain pool is a *multi-grain random
texture* generator — the **wrong** primitive. The Tracker voice's granular preview should be a new
single windowed read-head, NOT a fork of the tape pool.

## Mapping to Sequence's voice model

Sequence today (per the 2026-06-17 code map): `VoiceDef` (`src/audio/voices.ts`) has no explicit
playback-mode enum — modes are implicit (one-shot / `VoiceLoop` / multisample `roots[]`). Track
sources are `{kind:'voice'}` (internal audio) | `{kind:'instrument'}` (MIDI-out) — which already
gives the **dual output** (audition-local vs play-the-Tracker-over-MIDI) for free. Audition is also
already there: `src/audio/monitor.ts` plays any voice off-transport with sustain + soft release.

Net-new for the voice type: explicit playmode + per-mode params mirroring `InstrumentData`, the
single windowed read-head DSP (native `audio.rs`), per-instrument filter/env/LFO authoring, slice
markers, and the `.pti` read/write + authoring UI.

## In-app exporter — LANDED 2026-06-18 (pending hardware test)

"Export focused track → `.pti`" now lives in the app. Files:
- **`src/tracker/exportPti.ts`** — `exportVoiceToPti(voiceId)` + `voiceIsExportable(voiceId)`.
  Resolves the voice via `getRegisteredKits()` (median root for multisampled `roots[]`, else flat
  `files[0]`), reads bytes (`invoke('read_audio_file')` for `source:'user'`, `fetch` for `'bundled'`),
  decodes+resamples to 44.1k by `decodeAudioData` inside a `new OfflineAudioContext(2,1,44100)`
  (resamples to context rate — browser-quality, no custom DSP; mono stays mono), `createWavFile` →
  `createInstrument` (playmode OneShot, volume 1, **tune 0**, `sample.filename` = sanitized voice label
  ≤32B) → `Tracker.writeInstrument` (browser `<a download>` path — same mechanism as the JSON
  instrument export).
- **`src/components/RowPanel.tsx`** — `ExportPtiButton` (label `.pti` → `✓`/`✗`/`…`, under a `tracker`
  caption) added to the existing `isTauri() && voiceId` section (next to the output picker). Disabled
  for sampleless voices.
  `tsc` clean.

Verified: lib import is jszip-free (the only jszip importer, `io/project.js`, is commented out of the
lib's index). **PENDING:** hardware test (export a voice → load on Tracker). **Known v1 limit:** writes
via download (lands in the download dir → copy to SD). Save-dialog-direct-to-SD is the obvious
follow-up but needs the `.pti` bytes (the lib's public API only writes/downloads — would need a blob
capture or a Rust `save_binary_file`). Granular/playback editor is the next phase.

## Instrument editor — PLAY/PREVIEW is a first-class requirement (2026-06-18)

Chris: the Sandroid "Instrumented" tool has no play/preview (it's a pure file editor with no audio
engine). **Our editor MUST include preview** — and that's the whole advantage of building it inside
Sequence, which already has the engine. Preview = the editor's spine, not a bolt-on. Two tiers:
1. **Sample preview (free, day one):** play the focused voice via `monitor.ts` (`monitorNote`/
   `monitorDrum` + `monitorRelease`) at a chosen note. Raw sample, zero new DSP.
2. **Parameter-accurate preview (grows with the editor):** as each `.pti` control is added (playmode,
   filter type/cutoff/res, envelope, tune, start/end/loop, granular) the preview HONORS it → you hear
   what the Tracker will do. This is the "Tracker-flavored voice" doing triple duty: preview engine +
   audition + `.pti` serializer are ONE object. Granular = the single windowed read-head DSP
   (approximate audition OK, faithful serialization is what matters).

**Trigger method (DECIDED 2026-06-18 — mirror the Tracker hardware):** the hardware preview button
fires a fixed note (~C3) while the pad grid stays live for real-note previewing. Ours:
- **Fixed-note preview button** in the editor (default C3, verify/make configurable) → `monitorNote`.
- **Live play** via controllers (keyboard/Launchpad already drive `monitorNote`).
- **Auto-engage the Launchpad keyboard page on editor entry, restore the previous page on exit.** The
  keyboard page already exists ([[project-launchpad]], landed 2026-06-02, scale-quantized live play,
  side[6] toggle, monitor-only). Wire via the same page-switch helper the side button uses
  ([[feedback-hardware-via-helper]]) — editor open → keyboard page; close → restore. No on-screen
  mini-keyboard needed.

## ARCHITECTURE FINALIZED 2026-06-18 — editable instruments, NO separate type

Decided with Chris: there is **no "Tracker instrument" species**. Instead, **all instruments become
fully editable** with the complete `.pti` param set (playmode, sample window/loop, slices, filter
LP/HP/BP + tune + volume, granular, the 6 automations). The Tracker is just the hardware target;
`.pti` is a file format, not a type.

- **Edits are GLOBAL + in-place** (consistent with [[reference-global-expression-layer]]): editing
  hydra-plaits into a granular pad makes hydra-plaits that everywhere.
- **Save-As forks a new instrument that is IDENTICAL to a file-added sample-library instrument**
  (Chris's words). hydra-plaits → edit → Save-As "hydra-grains" → shows up like any other library
  instrument. So **persistence = the existing sample-library mechanism** (user samples dir + on-disk
  manifest). The param model extends `ManifestVoiceMeta`; edits + Save-As write the user-kit
  `manifest.json`. `.seq` keeps referencing instruments by id (portable; a machine without the library
  gets the stock instrument — fine for a personal tool).
- **One engine, grown additively** — new params **no-op by default** so untouched instruments behave
  exactly as today (zero blast radius). **One editor**, universal. **Export feeds effective params**
  (the `.pti` button already built). Multisample instruments stay multisample for keyboard play;
  `.pti` from one = the median-root snapshot.
- **Editor placement (lean):** a dedicated editor dialog launched from the instrument-details menu
  (where the `.pti` button lives). Adjustable.

### Phased plan (build order CONFIRMED — cheap params first, granular later)

Chris: "even without granular this gives some real control over the instruments and the output of
each sample and sound."

- **Phase A — cheap params end-to-end:** volume, tune, sample start/end trim, loop modes
  (fwd/bwd/pingpong) + the editor shell + preview (fixed-note C3 button + live play) + **Launchpad
  auto-key-mode on editor entry** + Save-As + persist to library manifest. Establishes the whole
  pipeline before any new DSP.
- **Phase B — per-instrument filter (LP/HP/BP) + envelope + LFO** (the automations layer).
- **Phase C — granular** (single windowed read-head + position automation `automations[4]`) — marquee,
  Chris's priority DSP.
- **Phase D — slice / beatslice / wavetable.**

### Follow-up agreed for AFTER this build: per-instrument reverb send

Detach reverb from the global FX bus → **per-instrument reverb send** (and likely delay send). Direct
synergy: `.pti` already carries per-instrument `reverbSend` + `delaySend` (0–1), so per-instrument
sends align Sequence's engine with the instrument format. Design when Phase A–C land. (Engine note:
[[reference-bank-swap-filter-graphs]] — per-track filter graphs are stable/persistent; per-instrument
sends should follow that stability discipline.)

## A3 — start/end trim + loop modes — BUILT 2026-06-18 (pending app test)

Slice A3 adds a per-instrument **sample window** (start/end) + **loop mode** (off/fwd/bwd/pingpong),
auditioned through the native engine and serialized to `.pti`. App-only, like A1/A2.

- **Store (`voiceEditsStore.ts`):** `VoiceEdit` gains `start?` / `end?` (0..1 fractions, default 0/1)
  + `loopMode?: LoopMode` (`'off'|'fwd'|'bwd'|'pingpong'`, default `'off'`). `LOOP_MODE_CODE` maps
  those to the native/`.pti` codes (off 0 · fwd 1 · bwd 2 · pingpong 3 — identical to
  `InstrumentPlayMode`). New `voiceTrim(voiceId) → { start, end, loop }` accessor.
- **Chokepoint (`samplePlayer.pickNativeSample`):** also returns `{ start, end, loop }`. All six
  native trigger sites (3 in `App.tsx` playback, 3 in `monitor.ts` preview/chord) forward them to
  `triggerSample` as `start`/`end`/`loopMode` opts → `audio_trigger_sample` as `startFrac`/`endFrac`/
  `loopMode` (nullable; defaults 0/1/0 = unchanged full one-shot).
- **Native engine (`audio.rs`):** `Trigger` cmd + `PendingTrigger` + `Voice` carry `play_start`/
  `play_end` (frames, resolved from the fractions at queue time) + `loop_mode` + `play_dir` (±1 read
  direction). `claim_voice_slot` seeds position at the window start (or `play_end` for backward loops,
  dir −1). The per-frame loop wraps (fwd/bwd) or bounces (pingpong, flipping `play_dir`) inside
  `[play_start, play_end]`; one-shots terminate at `play_end`. Advance is `position += rate * play_dir`.
  Declick out-fade targets `play_end` for one-shots and is **skipped for loops** (a fade at each wrap
  would dip). `play_end` clamps to `frame_count − 2` so a backward loop starting at the end can't trip
  the interpolator's `i0+1 >= frame_count` bound.
- **Editor (`InstrumentEditorDialog.tsx`):** start/end sliders (0–100%, mutually clamped 0.1% apart)
  + a 4-way loop segmented toggle (off/fwd/bwd/ping). Preview button + live play already honor edits
  via the chokepoint.
- **Export (`exportPti.ts`):** now feeds **effective params** — `inst.playmode = trim.loop`,
  `volume = voiceGainOverride`, `tune = voiceTune` (clamped ±24), `startPoint`/`endPoint` =
  `round(frac × min(frames−1, 65535))`, `loopPoint1/2` pinned to start/end. Samples > 65535 frames
  clamp (the device's 16-bit point addressing — the known long-sample limit).

**⚠️ Known caveat (flag to Chris, iterate if it bites):** a **flat (non-enveloped) voice** with loop
on never self-terminates — melodic voices stop at their envelope/gate and editor preview stops on
note-off, but a looped **drum** in pattern playback drones until the voice pool steals its slot
(self-limiting, no lockup). Loop is meant for sustained/held/enveloped sources. If flat looped drums
need bounding, synthesize a gate from the step length (follow-up).

### Waveform display + live playhead (added same session, 2026-06-18)

Editing trim/loop blind is rough, so the editor now shows the waveform with draggable handles + a
live playhead reflecting the real read direction.
- **`src/tracker/waveformPeaks.ts`** — `loadVoicePeaks(voiceId, columns)` resolves the same sample
  the export uses (`resolveExportSample`/`readBytes`, now exported from `exportPti.ts`), decodes via a
  throwaway `OfflineAudioContext`, reduces to per-column min/max (mono downmix). Cached by
  `voiceId@columns`.
- **`src/components/Waveform.tsx`** — canvas (ResizeObserver → ~1 column/px). Dims outside
  `[start,end]`, draws start/end handles with grab tabs (pointer-drag → `onChange`, mutually clamped),
  overlays the playhead + a direction caret. **Direction is inferred from the position delta** so the
  caret is correct for fwd/bwd AND pingpong (sign flips at the turns; native only reports position,
  not direction).
- **Native playhead readback** — `audio.rs` statics `MONITOR_NOTE_ID` + `MONITOR_POS` (f32 bits, <0 =
  none). The editor sets the preview voice's `note_id` via `audio_set_monitor_voice`; the audio thread
  publishes that voice's normalized read position **once per block** (−1 on deactivation).
  `audio_monitor_playhead` reads it; `nativeEngine.ts` wraps both. Editor polls at ~30Hz
  (`setInterval`) only while the preview button is held; clears the monitor voice on release/close.

### Loop-seam crossfade (the click/pop fix, 2026-06-18)

Chris flagged that trimmed loop points click unless start/end land on zero crossings. Fixed with an
**equal-power crossfade at the loop seam** in `audio.rs` (`LOOP_XFADE_SECS = 0.02`, capped at half the
loop span). The per-frame read was refactored into a `read_at(pos)` closure (captures `frames_slice`,
disjoint from the `&mut v` field writes) serving both the primary head and the crossfade head. In the
last `xf` frames before the jump edge, the tail blends (cos/sin) into the material one span away —
`sample[pos − span]` for forward, `sample[pos + span]` for backward — so at the seam the output is
exactly the wrap target and playback is continuous. **Pingpong is exempt** (it reverses continuously —
no jump, no click). One-shots never reach it. This means trim points no longer need to be on zero
crossings.

`tsc` + `cargo check` both clean. **PENDING:** Chris reload-the-app test (samplePlayer + audio.rs edits
need a full Tauri rebuild, not just HMR — see reference-engine-hmr-stale). Then: hear trim/loop on
playback + preview, watch the playhead track fwd/bwd/ping, confirm loops don't click on off-zero trim
points, and re-export a trimmed/looped voice to confirm the `.pti` carries the window + playmode on
hardware.

## B1 — per-instrument filter — BUILT 2026-06-18 (pending app test)

First slice of Phase B: a per-instrument **LP / HP / BP filter** with cutoff + resonance, authored in
the editor, auditioned through the native engine, serialized to `.pti`. **Distinct from the per-track
mixer ladder filter** (`trackFilter`/`TrackParams`) — this one lives on the voice, ahead of the
channel strip. App-only, same plumbing shape as trim/loop.

- **Store:** `VoiceEdit` gains `filterType` (`'off'|'lp'|'hp'|'bp'`, default off) + `cutoff` (0..1,
  default 1 = open) + `resonance` (0..1, default 0). `FILTER_TYPE_CODE` maps to native codes (0 off ·
  1 lp · 2 hp · 3 bp) and to `.pti` `InstrumentFilterType` (LowPass/HighPass/BandPass). `voiceFilter()`
  accessor.
- **Chokepoint/IPC:** `pickNativeSample` returns `{filterType, cutoff, resonance}`; the 6 trigger
  sites forward them → `triggerSample` (`filterType`/`cutoff`/`resonance`) → `audio_trigger_sample`
  (`instFilterType`/`instCutoff`/`instResonance`, nullable; defaults off).
- **Native (`audio.rs`):** the existing RBJ `Biquad` got `#[derive(Clone, Copy)]`, a `set_bandpass`,
  and `reset_state`. `cutoff_norm_to_hz` (50–18k log, shared with the track filter) maps cutoff;
  `resonance_norm_to_q` maps res 0..1 → Q 0.707..~25 (extreme end is genuinely screaming, per
  broken-ranges). Coefficients are built **once at queue time** in the `Trigger` handler and stored on
  `PendingTrigger`; `claim_voice_slot` copies them into the voice's stereo `inst_filter_l/r` (delay
  lines cleared). The read loop applies them right after sample reconstruction (post-crossfade,
  pre-ladder). Bypassed (no-op) when `inst_filter_on` is false.
- **Export:** `exportPti.ts` sets `filterEnabled`/`filterType`/`cutoff` (0..1 direct)/`resonance`
  (our 0..1 × 4.3 → the `.pti` ceiling).
- **Editor:** filter type segmented toggle (off/lp/hp/bp) + cutoff + reso sliders (shown only when a
  type is selected).

**⚠️ Known limitation (flag, iterate if wanted):** like trim/loop, the filter **bakes at trigger** —
coefficients are fixed when the note fires, so dragging cutoff/reso during a *held* preview note won't
sweep that note (re-press to hear the change). Live cutoff sweep would need per-voiceId shared atomics
(essentially the automations layer / Phase B2-3); deferred. `tsc` + `cargo check` clean. Reload the app
(engine rebuild). NEXT in Phase B: per-instrument **envelope + LFO** (the `automations[]` layer).

## B2 (envelope) — per-instrument amplitude ADSR — BUILT 2026-06-18

First slice of the modulation/automation layer: a per-instrument **amplitude envelope** (ADSR) that
overrides the manifest envelope.

- **Store:** `VoiceEdit.ampEnv: { on, attack, decay, sustain, release }` (seconds; `DEFAULT_AMP_ENV`
  for the toggle-on shape). `resolveVoiceEnvelope(voiceId)` returns the authored env when `on`, else the
  manifest envelope, else undefined (flat voice). This **overrides** the manifest envelope globally.
- **Call sites:** every `voiceEnvelope(...)` trigger site (App.tsx arp + main + chord-register;
  monitor.ts note + chord + release-fade) calls `resolveVoiceEnvelope`.
- **Engine (`audio.rs`):** standard ADSR state machine (attack ramp → decay → sustain hold → release),
  `hold_end` = gate-derived release start.
- **Export:** `automations[0]` (Volume, envelope mode) written from the resolved env — attack/decay/
  release as integer **ms**, `sustain` 0..1, `amount` 1, **delay 0** (see below). Flat voices keep the
  lib default.
- **Editor:** "amp env" ○/● toggle + **draggable ADSR graph** (`EnvelopeGraph.tsx`) + a compact ms/%
  readout.

### Delay probe RESOLVED + delay REMOVED (2026-06-18)

The `.pti` envelope has a `delay` field that's **not on the Tracker's UI** — open question was whether
the firmware honors it. **Answer (hardware-tested by Chris): it does NOT** — the exported instrument
maps correctly but the delay does nothing on the device (vestigial / internal field). It *did* work
locally in Sequence (DADSR), but Chris saw no use for a Sequence-only delay, so **the delay stage was
removed entirely** — `AmpEnvEdit`, the engine `EnvelopeSpec`/`Voice` delay state + state-machine stage,
the IPC `envelopeDelay`, the editor handle/readout, all stripped; the export writes `delay: 0`. The
envelope is now a plain **ADSR**. (Lesson logged: a correct-looking `.pti` map does NOT prove a field
is honored — non-UI fields need a listen-test.)

`tsc` + `cargo check` clean. Reload the app (engine rebuild).

## B2 (cutoff LFO) — per-instrument filter LFO — BUILT 2026-06-18 (pending app test)

A free-running LFO modulating the per-instrument filter cutoff — the first LFO primitive + the live
per-voice cutoff-modulation path (which a filter *envelope* will reuse). Only meaningful with the
filter on (it modulates that cutoff).

- **Store:** `VoiceEdit.filterLfo: { on, shape, division, depth }` (shape `revsaw|saw|tri|square|random`
  = `.pti` LFO_SHAPE codes; **`division`** = a tempo-synced musical rate `1/1…1/32`, one cycle per that
  note value; depth 0..1 bipolar). `voiceFilterLfo()` derives the engine Hz via
  `lfoDivisionToHz(division, BPM)` (reads the live transport BPM) and returns it + the division. Off
  (depth 0) unless both the LFO and filter are on.
- **Plumbing:** `pickNativeSample` → `lfoShape/lfoRateHz/lfoDepth` → 6 trigger sites → `triggerSample`
  → `audio_trigger_sample`. The engine stays Hz-based — only the *source* of the Hz changed (BPM ×
  division at trigger), so the tempo-sync is a pure JS-side derivation; no engine change.
- **Engine:** `Voice` carries the LFO + the base filter params (`inst_filter_type/inst_cutoff_norm/
  inst_q`) so it can **recompute** the biquad. Per sample the LFO phase advances (`lfo_eval` →
  revsaw/saw/tri/square/random S&H); every `LFO_RECOMPUTE_SAMPLES` (32) the coefficients are rebuilt
  from `cutoff_norm + depth × lfo` (coeffs only — the delay line keeps running, click-free). Gated by
  `lfo_on` (filter on + depth/rate > 0); zero cost otherwise. This is also the live-cutoff path B1
  lacked.
- **Export:** `automations[2]` (Cutoff), LFO mode — shape 1:1, depth → amount, **division → LFO_SPEED
  by name** (`DIVISION_TO_SPEED`: `1/4`→`S1_4`, etc.). Now **exact**, not a Hz guess — both sides are
  "one cycle per this note value".
- **Editor:** under the filter block — ○/● toggle, a **live shape plot** (`LfoShapePlot.tsx`, same
  visual language as the global LFO panel's WaveformPlot — gridlines + bold one-cycle curve + phase dot
  at the synced rate, amplitude scaled by depth; built fresh rather than reusing that component, which
  is bound to the global LFO store + sine/tri/saw/square set), shape selector, **rate as a division
  selector** (`1/1…1/32`) with a live `≈X.X Hz` hint at the current BPM, depth knob.

**Tempo-synced (updated 2026-06-18 per Chris — faithfulness).** Rate is a musical division locked to
the transport; the local Hz is derived from BPM × division at trigger, so it matches the Tracker's
synced LFO and the `.pti` speed transfers by name. **Caveats:** (1) rate is baked at trigger — a BPM
change mid-note won't retune that note's LFO; (2) phase resets per note (note-synced), not locked to
absolute bar position — true transport-phase-lock would need the engine to know song position (a later
refinement if cross-voice phase alignment ever matters).

`tsc` + `cargo check` clean. Reload the app. NEXT in B: a **filter envelope** (cutoff swept by a DADSR,
reusing this live-cutoff path + the EnvelopeGraph UI) and **pitch** modulation.

## B2 (full grid) — generic modulation + all controls revealed — BUILT 2026-06-18

Chris chose the **full automation grid**: each renderable `.pti` target (Vol/Pan/Cutoff/Pitch) carries
an envelope and/or an LFO. Built on a **generic `Modulator`** (env OR lfo) over a fixed 6-slot array
(`MOD_SLOTS`): `0 vol-LFO(tremolo) · 1 pan-env · 2 pan-LFO · 3 cutoff-env · 4 pitch-env · 5 pitch-LFO`.
The two originals stay separate, NOT in the array: **vol-ENV = the amp envelope**, **cutoff-LFO = the
bespoke `filterLfo`**.

- **Store:** `EnvMod`/`LfoMod` + the six slots on `VoiceEdit`; `voiceMods(voiceId) → ModSpec[]`
  (resolves LFO Hz from BPM). `MOD_SLOT` index map shared with Rust.
- **IPC (no param explosion):** a single `mods` array on `audio_trigger_sample` (`ModSpecIpc`, serde
  camelCase) → built into a `[Modulator; 6]` **on the command thread** (Copy, so the audio thread only
  copies — no heap on the realtime path) → `MixerCommand`/`PendingTrigger`/`Voice`.
- **Engine:** per sample, tick all mods then accumulate per target — tremolo (amp ×), pan offset
  (recompute pan gains around a new `pan_base`), cutoff offset (folds into the existing cutoff
  recompute), pitch semitones (`2^(±/12)` on the position advance). Mod envelopes clock off
  `frames_played` + `mod_hold_samples` (= amp-env hold, else sustain).
- **Editor:** reusable `ModEnvSection` / `ModLfoSection` (`ModSection.tsx`) reuse the EnvelopeGraph +
  LfoShapePlot; `EnvelopeGraph` decoupled to a structural `EnvShape`. **All conditional hiding removed**
  (the `filterType`/`lfoOn`/`envOn` guards) so every control is visible for the Figma screenshot.

**⚠️ Export NOT wired for the 6 new mods.** `exportPti` still writes only amp-env→`automations[0]` and
cutoff-LFO→`automations[2]`. pan→[1] / pitch→[5] / tremolo / cutoff-env are unserialized; slots 0 and 2
are env-XOR-LFO so need pick logic. **Deferred until hardware-verified** — per the delay lesson, some
`.pti` automation slots may be vestigial, so prove each on the device before trusting the export.

## Phase A — execution plan (mapped 2026-06-18, ready to build)

Slice order within Phase A (smallest audible first; build-and-test each with Chris):
- **A1 — volume:** global per-voice gain override. **A2 — tune:** semitone offset (pure JS, folds into
  the pitch the engine already applies). **A3 — start/end trim + loop modes** (needs `audio.rs` work).
  Then the editor dialog + preview + Launchpad auto-key wrap A1/A2 so they're usable.

Insertion points (from the extension map):
- **Edit store (new):** `src/.../voiceEdits` — localStorage-backed like `userInstrumentsStore.ts`
  (app-wide = "edits are global"). `Record<voiceId, { gain?; tune?; ... }>` + setter + subscribe.
- **Accessors (`voices.ts`):** `voiceGain()` (line 340) merges the override (× manifest gain); add
  `voiceTune()`. ⚠️ **GOTCHA — two gain paths:** playback uses `voiceGain()` (samplePlayer:294) but the
  native preview path `pickNativeSample` returns `data.gain` (samplePlayer:607) consumed by
  `monitor.ts:86` — the override must be applied in BOTH or playback/preview disagree. Tune: apply the
  offset to `pick.pitch` in monitor AND to the pitch calc in `samplePlayer.trigger` (~line 455).
- **Editor dialog (new):** portal + backdrop pattern from `PerformanceDialog.tsx`; monochrome
  (`bg-[#0a0a0a] border border-white/15`). Opened from the instrument-details menu (RowPanel, beside
  the `.pti` button). Volume + tune controls; fixed-note **C3 preview button** + held-note live preview
  via `monitorNote`/`monitorRelease` (`monitor.ts`).
- **Launchpad auto-key:** ⚠️ `setDeviceMode` (launchpadBindings:654) is **not exported** — export it;
  on editor open save `deviceMode[device]` then `setDeviceMode(dev,'keyboard')`; on close restore.
- **Persist:** A1/A2 in the edit store (localStorage). **Manifest-write persistence + Save-As**
  (`save_text_file` to a user-kit `manifest.json`, then `rescanAllKits()`) is its own slice after the
  edit loop feels right — the `.pti` param set must extend `ManifestVoiceMeta` for that.

## Build increments (revised 2026-06-17)

1. **Format round-trip (de-risk).** Minimal forward/loop instrument: load WAV → author
   volume/ADSR/LP-HP/loop → audition via `monitor.ts` → `writeInstrument` → **verify it loads on the
   real Tracker** → read back. Near-zero new DSP. *(format layer proven headless below — hardware
   load is the open verification.)*
2. **Granular** (Chris's priority). New single windowed read-head in `audio.rs` for local audition
   (approximate is fine) + **faithful `Granular` + `automations[4]` serialization** (the hardware
   renders the real grains, so format fidelity is what matters).
3. **Slice mode** (reuse the `slice-samples` pipeline for markers → `slices[48]`).

## Verified headless (2026-06-17)

A round-trip smoke test (synth 220Hz sine → `createInstrument` → Granular mode + grain params +
position-LFO on `automations[4]` + filter → `writeInstrument` → `readInstrument`) **passed** — every
granular field, the position automation, and the filter survived write→read (88,592-byte `.pti` for
a 1s mono sample). The library and the format layer work end-to-end in Node. The remaining truth —
the file loading on actual Tracker hardware — is the gating manual verification.

## Real-sample export + the resample requirement (2026-06-17)

Exported two **real Sequence samples** to `.pti` for a hardware load test (files on Chris's Desktop:
`NS-Kick.pti` = blck_noir KICK-1 one-shot; `NS-Rhodes-C5.pti` = Rhodes Mk1 C5, ~5.2s sustained).

**Key feature constraint learned:** Sequence samples are **48 kHz**, instruments are **stereo**, but
`.pti` requires **16-bit 44.1 kHz**. The export path therefore MUST: decode → (downmix or keep
stereo) → **resample 48k→44.1k** → re-encode 16-bit via `AudioUtil.createWavFile`. The native engine
also runs at 48k device rate. The test used a quick linear resampler + mono downmix; the in-app
exporter needs a proper resampler. The Rhodes is a deliberate long-sample case: probes whether the
16-bit (0–65535) start/end/loop addressing truncates samples > 65,535 frames.

**CHANNELS DECISION (2026-06-18): export STEREO by default.** Chris has the original Tracker (mono —
auto-downmixes on load), but exporting stereo future-proofs for Tracker+/Mini at no cost now (orig.
Tracker = mono-only; Tracker+ and Mini = full stereo). Verified headless: `AudioUtil.createWavFile`
takes **interleaved** Float32 (L,R,L,R) with `numChannels:2`; `Tracker.createInstrument` auto-derives
`sample.channels=2` from the WAV; a stereo `.pti` round-trips write→read (channels + filename intact).
So the exporter: decode source → keep both channels interleaved → resample each to 44.1k →
`createWavFile(…,{numChannels:2})` → `createInstrument` → set `sample.filename`. No manual channel
field bookkeeping needed.

## Multisample → single sample: which root to pick (2026-06-18)

A `.pti` holds ONE sample, but Sequence melodic voices are multisampled (`roots:[{midi,files}]`). The
Tracker pitch-shifts the single sample across the whole range, so picking the TOP root (Chris's first
export = Rhodes MIDI 84 / "C5") stretches everything downward → wild artifacting 4 octaves down in the
low registers.

**Rule: pick the MEDIAN root and set `tune` to keep it in tune.** Trust the manifest `midi` field, NOT
the filename note-suffixes (Rhodes suffixes are inconsistent — `040-E1` etc.; the `midi` values
36→84, step 4, are correct). Rhodes median = **MIDI 60**.

**Tuning — CORRECTED 2026-06-18 by hardware test.** My first theory (set `tune = topRoot − chosenRoot`
to "compensate") was WRONG. Exporting MIDI 60 with `tune=+24` played **2 octaves SHARP** on hardware.
Lesson: **the Tracker does NOT normalize pitch by the sample's recorded pitch** — it has no per-sample
root-note field (the `.pti` has only `tune`/`finetune`, no rootNote), and our generated WAVs carry no
`smpl` chunk. It plays whatever sample is loaded at the pitch of the played note; `tune` is a plain
global transpose. **So multisample export = pick the chosen root and leave `tune=0`.** Sample choice
changes which source recording (timbre/frequency content) gets stretched, NOT the musical pitch.

**CONFIRMED 2026-06-18 by hardware A/B (`NS-Rhodes-Mid.pti`, MIDI60/tune=0):** in tune AND the low
registers sound better than the C5 export. **RULE (final): multisample → single `.pti` = export the
MEDIAN root, `tune=0`, stereo, resampled to 44.1k, `sample.filename` set.** The lower-freq mid source
survives downshift more gracefully; no tune compensation (the Tracker transposes by played note, not
by recorded pitch). If a play range is known to skew very low/high, the exporter could bias the
chosen root that way, but median is the default. (Splitting across multiple `.pti`s not needed.)

**HARDWARE TEST RESULT (2026-06-17): both `.pti` files LOAD + PLAY on the device. Format proven on
real content.** One fix: they first read as **"untitled"** — the device's instrument display name
comes from `sample.filename` (≤32 bytes), which `createInstrument` leaves blank. The exporter MUST
set `inst.sample.filename`. Re-exported with names set; **Chris confirmed on hardware the names display
correctly (2026-06-17). Increment 1 is DONE + hardware-validated.**

## Open / gated on hardware (Chris)

- **PENDING:** confirm `NS-Kick.pti` + `NS-Rhodes-C5.pti` load + play on the Tracker (copy to SD
  `Instruments/`). Kick = does our `.pti` work at all; Rhodes = long-sample truncation behavior.
- After load confirmed: build in-app "Export focused track → `.pti`" (Tauri save dialog + binary fs
  write + proper resampler), then the granular voice.
- By-ear calibration of Gauss grain width + grain-repeat behavior for the local audition.
- `npm audit` flagged advisories on install (likely transitive dev deps via jszip/typedoc) — review,
  do **not** run `audit fix --force` blind.
