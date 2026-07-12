# Tracker instrument voice + `.pti` export

Goal: a **Polyend Tracker instrument voice type** inside Sequence. Author and audition a sound
locally (Sequence audio = design monitor), then write a `.pti` the Tracker loads and play it on
hardware over MIDI. Ordering decision (2026-06-17): build the Tracker voice **before** generic
instrument-mode upgrades; granular comes **after** the format round-trip, before slice.

This doc is the grounded spec + build journal that began with the 2026-06-17 research pass. The
per-section entries below are kept chronological (they record the design rationale); their original
"BUILT / pending app test / NOT committed" tags are point-in-time and **superseded by the status
block immediately below** — everything through the full modulation grid, granular, Save/Save-As, and
per-instrument reverb/delay sends is now shipped on `main`.

## STATUS — 2026-06-22 (shipped through 0.8.2)

**Everything below the format-research sections is built, committed, and in `main`.** Commit map:

| Increment | Commit | State |
|-----------|--------|-------|
| `@polyend/tracker-lib` + `.pti` export module | `a62f4d2` | shipped + hardware-validated |
| `.pti` export button + A1/A2 (volume, tune) | `61979c3` | shipped |
| A3 trim/loop + waveform editor + B1 per-instrument filter | `9337783` | shipped |
| B2 amp ADSR + per-instrument cutoff LFO | `1457372` | shipped |
| Remove vestigial envelope delay (DADSR → ADSR) | `5704f97` | shipped |
| B2 full per-instrument modulation grid + redesigned editor | `3bc43c7` | shipped |
| Phase C granular playmode (single-grain read-head) | `0e4b0c0` | shipped |
| Save / Save-As to the global sample library | `524e575` | shipped |
| Editor → `[params]` / `[automation]` tabs in the channel screen (0.8.0) | `9482a36` | shipped |
| Per-instrument reverb + delay sends (0.8.2) | `ef98a6b` | shipped, delay aux audible |

**Hardware-validated:** `.pti` files load + play + name correctly on the real Tracker (2026-06-17);
the B1/B2 param serialization (filter, amp env → `automations[0]`, synced cutoff LFO →
`automations[2]`, trim/loop → playmode + start/end) maps correctly on the device (2026-06-18).

**Save / Save-As IS wired and the round-trip is sound** (`saveInstrument.ts` ↔ `voiceEditsStore.ts`):
Save bakes `resolvedVoiceEdit` into the user-kit `manifest.json` `edits` field; the Rust scanner reads
the manifest verbatim, the registry re-namespaces the voice keeping `.edits`, and `resolvedVoiceEdit`
reads it back so playback / preview / `.pti` export all honor saved edits. Save-As forks a new
library voice and repoints the focused track to it.

### Genuinely still open

1. ~~**Slice + wavetable playmodes**~~ **DONE.** Slice shipped 0.15.0 (see "Slice mode — execution
   plan" below). **Wavetable BUILT 2026-07-12** (app-only, not committed; pending app audition +
   hardware verify) — the last playmode, and it wired the final automation target `WtPos →
   automations[3]`. See "Wavetable mode — BUILT 2026-07-12" below. All four playmodes (sample / slice /
   wavetable / granular) are now live.
2. **Generic-mod `.pti` automation export wiring** — `exportPti.ts` writes only `automations[0]`
   (amp env), `[2]` (cutoff LFO) and `[4]` (granular pos). The rest of the *modulation grid* (pan → [1],
   tremolo → [0] LFO side, cutoff-env → [2] env side, pitch → [5] Finetune) is **unserialized**. The
   editor already enforces env-XOR-LFO per slot (`setMutex`), so no pick ambiguity — just replicate the
   slot-[4] write pattern per slot. **Modulated pitch caveat:** the only pitch *automation* target is
   slot [5] Finetune (±100 cents), so a pitch env/LFO can sweep at most ±1 semitone regardless of the
   app's ±24-semitone depth — clamp + document. Still gated on a per-slot device listen (delay-probe
   lesson). *Note: static tune + finetune are a separate, fully-wired thing — see below.*
3. ~~Hardware A/B of granular + `automations[4]`~~ **DONE (Chris, 2026-06-22)** — not perfect but
   close enough to understand how it resolves on the device. Delay + reverb sends likewise confirmed to
   map onto the hardware effects. Local audition is approximate-not-parity by design; the `.pti`
   fidelity carries.
4. **Save-dialog-direct-to-SD for `.pti`** — export still downloads to the default dir (copy to SD by
   hand). Needs the `.pti` bytes via a blob capture or a Rust `save_binary_file`.
5. **Launchpad auto-key on editor entry — DROPPED.** It was a Phase A line item for the *modal* editor;
   the editor became always-visible `[params]`/`[automation]` tabs (`9482a36`), so there's no
   open/close event to hook. Live play already works via the existing keyboard page + preview button.
6. **In progress — instrument params as app LFO destinations:** increment 1 (per-note drift of grain
   length + position via the global LFO) BUILT 2026-06-22, app-only, not committed; increment 2
   (continuous in-note sweep, needs engine work) deferred. See the dedicated section below.
7. **Parked enhancements:** gate-synthesis to bound flat looped drums; `npm audit` advisory review.

### Static fine pitch — tune + finetune (2026-06-22, app-only, not committed)

The editor had only a coarse **tune** knob locked to integer semitones — useless for pitch-correcting a
recorded sample. Added a dedicated **finetune** control (cents, ±100, integer steps), mirroring the
Tracker's own Tune/Finetune split and the `.pti`'s two static fields (`tune` ±24 st, `finetune` ±100 c).
- `VoiceEdit.finetune` (cents) + `voiceFinetune()` accessor (`voiceEditsStore.ts`).
- Audio path: `samplePlayer.ts` folds both into one multiply — `pitch ×= 2^((tune + finetune/100)/12)`
  (no Rust change; the engine already takes the final pitch). Works for melodic + drums.
- Export: `exportPti.ts` writes `inst.finetune` (clamped ±100, integer) straight across — no
  decomposition, since both models keep tune + finetune as separate static fields.
- Editor: `finetune` `TopKnob` (cents, bipolar) next to `tune` in the level grid.
`tsc` clean. Distinct from the *modulated* pitch limit in open-item 2 — this is the static base offset,
full-range and lossless. Reload the app (samplePlayer edit). NOT committed.

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

## In-app exporter — SHIPPED (`61979c3`; hardware-validated 2026-06-17)

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

### Follow-up: per-instrument reverb + delay sends — SHIPPED (0.8.2, `ef98a6b`)

Reverb detached from the global FX bus → **per-instrument reverb AND delay sends**, aligning Sequence's
engine with the `.pti` per-instrument `reverbSend` + `delaySend` (0–1). Both are stored in `VoiceEdit`,
read on the audio path (`voiceReverbSend`/`voiceDelaySend`), and exported. The native delay aux is
built and audible (`audio.rs` `delay_send_eff`/`delay_send()`, consumed in the mix at ~`5089`) — the
old `voiceEditsStore` comment calling delay "not yet audible" is stale. (Engine discipline followed
per [[reference-bank-swap-filter-graphs]] — per-track graphs stay stable/persistent.)

## A3 — start/end trim + loop modes — SHIPPED (`9337783`)

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

## B1 — per-instrument filter — SHIPPED (`9337783`)

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

## B2 (envelope) — per-instrument amplitude ADSR — SHIPPED (`1457372`)

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

## B2 (cutoff LFO) — per-instrument filter LFO — SHIPPED (`1457372`)

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

## B2 (full grid) — generic modulation + all controls revealed — SHIPPED (`3bc43c7`)

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

## Editor in the tabbed area — SHIPPED (0.8.0, `9482a36`)

The instrument editor moved out of the RowPanel `[...]` modal and into the main `ChannelScreen` as two
always-visible tabs, **[params]** and **[automation]**, alongside `roll / lfo / fx / master`. The channel
screen is scoped to the focused track and the editor is per-focused-voice, so it fits that context and is
now discoverable instead of buried. **The modal is gone.**

**Decisions (Chris, 2026-06-19):**
- **Replace the modal** (not keep both). The RowPanel `edit` button now focuses that track
  (`setFocusedTrackId`) + jumps the screen to the params tab (`setScreenMode('params')`) — no dialog.
- **Automation layout = stacked** (LFO over ENV per target, NOT side-by-side), visualizers **shrunk to
  fit** the 280px, and **per target the LFO and ENV are MUTUALLY EXCLUSIVE** — enabling one disables the
  other (one modulator at a time; also matches the `.pti` env-XOR-lfo slot model). Chris: crowding is
  expected; "look at having another UI element afterwards if this is too crowded" → iterate later.

**Files:**
- **`InstrumentEditor.tsx`** (renamed from `InstrumentEditorDialog.tsx`, modal chrome stripped) — resolves
  the focused voice track itself (`resolveEditorTrack`: focused track if it's a `kind:'voice'`, else first
  voice track; placeholder if the focused track isn't a voice). Takes a `view: 'params' | 'automation'`
  prop and renders that half + a shared compact **action bar** (preview · export .pti · unsaved · revert ·
  save · save as) at the bottom of both. `setMutex(lfoKey, envKey)` builds the per-target XOR handlers;
  cutoff handlers also `ensureFilterOn()`. Preview cleanup keyed on `voiceId` (stops a held note when the
  focused instrument changes), holds the started-on track in a ref so release survives a focus change.
- **`ChannelScreen.tsx`** — `params` + `automation` added to `MODES`; both render ONE mounted
  `<InstrumentEditor view={screenMode}/>` (single slot so a held preview survives switching the two halves).
- **`store.ts`** — `ScreenMode` += `'params' | 'automation'`.
- **`Track.tsx`** — dropped the `<InstrumentEditorDialog>` render + `editorOpen` state; `onOpenEditor` →
  focus + params tab.
- **`EnvelopeGraph.tsx`** — optional `height` prop (default 64; threaded through `geometry`); **`ModSection.tsx`**
  — `compact` prop on both sections (h-11 plot / 44px graph + tighter margins) for the 280px tab.

Shipped as 0.8.0. The 280px automation fit was accepted (crowding noted; "another UI element" left as a
later iterate-if-it-bites). The secondary LFO-destinations idea (below) remains the open enhancement now
that params live in the tabbed area.

**Params-tab layout iterated to final (2026-06-19, Chris-approved):** left→right —
1. **waveform** (`flex-[6]`),
2. **playmode** vertical button stack (`PlaymodeTabs vertical`), label on top, directly right of the visualizer,
3. **control columns** (`flex-[7]`), vertical stacks separated by `<Divider/>` rules, fixed order
   **level · filter · mode-specific** so the first two columns don't move when the playmode changes:
   - **level** — `volume` + `tune` knobs (`ControlStack`, knob-over-label).
   - **filter** — `LabeledStack` (label on top): off/lp/hp/bp row, then `cutoff` + `reso` knobs side-by-side.
   - **mode-specific:** sample → **loop** (`LabeledStack`, off/fwd/bwd/ping buttons stacked vertically);
     granular → **direction** (`LabeledStack`, fwd/bwd/ping stacked) · **grain** (`LabeledStack`: shape
     row + scatter knob).
   Helpers added in-file: `ControlStack` (centered col), `LabeledStack` (label-on-top col), `Divider`
   (vertical rule), `SegButton`. The instrument-name label was removed from this tab (was truncating).
   Two label conventions coexist: single-selector columns put the name on top (the header *is* the label);
   knob/grouped columns keep per-control labels underneath.

**Granular direction — CONFIRMED wired + audible (2026-06-19):** answering "does direction do anything" —
yes. `audio.rs:5225-5231` flips the per-grain read offset sign (fwd reads `[base, base+grain_len]`, bwd
reads the same span reversed, ping alternates per grain via `gran_ping_fwd`). The grain *window* is always
applied forward (symmetric gauss/tri → identical amplitude envelope all 3 modes), so it's a per-grain
content reversal, **subtle at the 80ms default, obvious toward the 1s max grain.** Not a transport reversal.

**Instrument params as APP LFO destinations (Chris, 2026-06-18) — INCREMENT 1 BUILT 2026-06-22 (per-note
drift), app-only, not committed.** The global LFO system can now route to two per-instrument knobs:
**grain length** and **grain position**. Chris chose per-note drift first (vs continuous in-note sweep)
as the lowest-risk audible increment. Shape:
- **New destination category** `LFODestKnobInstrument = 'grainLength' | 'grainPosition'` (`lfo.ts`),
  added to the `LFODestKnob` union, `VALID_KNOBS` (persist across reload, `hydrate.ts`), and the LFO
  panel `KNOB_LABELS`. Kept SEPARATE from `LFODestKnobTrack` so TrackKnob's read/write switches stay
  exhaustive — these live on the voice (voiceEdits), not on `TrackData`.
- **Apply point = trigger time** (`samplePlayer.pickNativeSample`, new optional `trackId` arg): when
  granular is on and a routing track is known, `modulated()` samples the LFO at trigger and drifts the
  grain position (0..1 direct) + length (normalized over [1,1000]ms). No-op fast path when nothing is
  routed; **no engine/Rust change.** All 6 trigger sites pass a trackId — playback (`ev.trackId` ×2,
  `chord.trackId`) and preview (`track.id` ×3 in monitor.ts).
- **UI:** `GranLfoKnob` in the editor's granular column — LFO-bindable length + position knobs (live
  modulated readout, click-to-bind under `selectingLFO`, hand-drag marks a manual override). Keyed to
  the focused track's id. `scatter` stays a plain local knob.
- **Waveform mapping:** the editor computes the live modulated grain position + length (`useLFOValue`
  on the routed LFOs, hooks placed before the focus guard) and feeds them to the `Waveform` granular
  prop + caption, so the **position cursor travels the sample and the grain window resizes in real time**
  as the LFO drifts — even off-transport. No re-render when nothing's routed (`useLFOValue` bails on an
  unchanged base; the Waveform redraw deps already include `granular.position`/`grainMs`).
- **Caveat (by design, per the chosen increment):** a *held* granular note doesn't sweep mid-note — the
  drift is sampled per trigger. Composes with the per-instrument `granPosLfo`/`granPosEnv` (which DO
  sweep position in-engine within a note via `automations[4]`); the app LFO sets the drifting start.
- `tsc` clean. Reload the app (samplePlayer edit; no cargo rebuild).

**INCREMENT 2 (follow-up) — continuous in-note sweep.** Push the modulated grain length/position to the
engine every frame (the `fxModulation.ts` RAF loop, the same path the per-track filter uses), with a
per-track grain offset read in the `audio.rs` granular read-head + a new IPC command, so a sustained
granular drone sweeps in real time. Bigger build (engine work); deferred until the per-note drift feel
is confirmed. Export still writes only the base level + the Tracker's fixed `automations[]` slots.

**Principle (unchanged):** app modulation destinations ⊇ `.pti` automation targets — the app modulates
anything (it's its own engine); on export, anything the Tracker can't automate projects down to its base
value (or the nearest supported `automations[]` slot). Same app-only-enrichment / faithful-where-it-can
stance as per-grain scatter + the live cutoff LFO. Other per-instrument knobs (finetune, instrument
cutoff, etc.) are candidate destinations for later — the `GranLfoKnob` + trigger-time pattern generalizes.

## Phase C — GRANULAR playmode — SHIPPED (`0e4b0c0`)

The granular playmode + its single windowed read-head DSP + the playmode selector are in. Chris chose
"build the full granular mode in one pass" (no Figma — built from the existing tab pattern). App-only,
same plumbing shape as trim/loop/filter. **Hardware A/B DONE (Chris, 2026-06-22):** the granular sound
+ `automations[4]` resolve close enough on the device to be usable (approximate-not-parity as designed);
the grain-param fidelity carries via the `.pti`.

**Data model (`voiceEditsStore.ts`):**
- `Playmode = 'sample' | 'slice' | 'wavetable' | 'granular'` (+ `PLAYMODE`-style intent; only granular is
  wired in the engine, sample is default). `GranularEdit = { grainMs 1..1000, position 0..1, shape
  square/triangle/gauss, direction fwd/bwd/pingpong }`; `GRAIN_SHAPE_CODE`/`GRAIN_DIR_CODE` map 1:1 to the
  `.pti` `GranularShape` (0/1/2) and `GranularType` (0/1/2). `DEFAULT_GRANULAR = {80ms, 0.25, gauss, fwd}`.
- `VoiceEdit` += `playmode?`, `granular?`, `granPosLfo?`, `granPosEnv?`. Two new `MOD_SLOT`s: **granPosLfo=6,
  granPosEnv=7** (sweep the granular read position → `.pti` automations[4]). `voiceMods` appends slots 6/7
  **only in granular mode**. New `voiceGranular(voiceId)` accessor (`on` = playmode is granular).

**IPC:** `pickNativeSample` returns a `granular` object → `triggerSample` `granular?` opt → `audio_trigger_sample`
(`granOn/granGrainMs/granPosition/granShape/granDir`). Forwarded at all 6 native trigger sites (3 App.tsx
+ 3 monitor.ts) as `granular: pick.granular`.

**Engine (`audio.rs`) — the single windowed read-head:** `MOD_SLOTS` 6→8. `Voice`/`Trigger`/`PendingTrigger`
carry `gran_on/gran_grain_frames/gran_pos_norm/gran_shape/gran_dir` + runtime `gran_read`/`gran_ping_fwd`.
grain length resolves ms→frames at the device rate (clamped 2..fc-2) at queue time. In the read loop the
mod block was **moved to the top of the frame** (so the granular read can use the position offset); a new
`if v.gran_on { … } else { <normal trim/loop read> }` branch:
- grain reads `gran_grain_frames` source frames from `base = (gran_pos_norm + mod_granpos)·(fc-2)`, windowed
  by `grain_window(shape, phase)` (square = flat w/ raised-cosine edges; triangle; gauss bell), read fwd/bwd/
  ping; `gran_read += rate·pitch_factor`, wraps (re-triggers) at grain_len (pingpong flips dir on wrap).
- the base position does NOT advance with playback (the head holds; grains repeat) — only slots 6/7 sweep it.
- **grain-position automation is UNIPOLAR/forward (2026-06-18, matches the Tracker "amount"):** the read scans
  forward from the set position, NOT a bipolar wobble around it like pan/pitch/cutoff depths. The env (slot 7)
  is already a positive 0..depth ramp; the LFO (slot 6) is remapped `((lfo+1)/2)·depth` so it only pushes
  forward. The editor's grain-pos LFO knob is `DEPTH_UNIT` (0..100%), not bipolar.
- **grain RATE tracks pitch (TRIED decoupling, REVERTED 2026-06-18):** I briefly decoupled grain rate from
  pitch (phase in OUTPUT samples → fixed `1/grain_len`, matching Sandro's `grainPos = elapsed mod grainLength`)
  to chase a "hardware sounds faster" note. Chris then confirmed on the real hardware that **grain speed DOES
  change with pitch** — so it's reverted: `gran_read` advances at `rate·pitch` and wraps at `grain_len` SOURCE
  frames (grain duration = `grain_len/(rate·pitch)`), so higher notes fire grains faster, lower notes slower.
  This is the pitch-coupled model; Sandro's pitch-independent rate is NOT what the Polyend does. Don't
  re-decouple.
- **grain scatter / spray (2026-06-18):** Chris: ours "tracks through the sample forward" vs the hardware
  "jumping around the start point." Sandro's read math is structurally identical to ours (`latchedStart +
  grainPos·pitch`, sweep-fwd-then-snap-back) AND is itself only an approximation of the Polyend — so rather
  than copy it, refined ours toward the hardware feel with a per-grain **position scatter**: at each grain
  re-latch the start jumps to `target_base ± rand·spray·sampleLen` (dedicated `gran_rng`, not the LFO's), so
  successive grains scatter around the point instead of all reading one forward span. `GranularEdit.spray`
  (0..1, default 0.1 = audibly scattered out of the box; 0 = frozen single grain); "scatter" knob in the
  granular header. LOCAL-ONLY (no `.pti` spray field — the hardware has its own inherent scatter; this tunes
  the design-monitor feel, not the export). Threaded through the same granular IPC chain.
- **overlap-add was TRIED and REVERTED (2026-06-18):** to fix "rougher than hardware" I added a 2nd grain
  staggered half a grain (window-sum-normalized overlap-add). It **broke the sound** — Chris reverted to the
  single-grain latched read (what Sandro's `granular.ts` actually does: ONE windowed read head, no overlap).
  Roughness is still open, but match Sandro's single-grain model first; don't reintroduce overlap-add.
- **LFO division set = full Tracker LFO_SPEED (2026-06-18):** Chris flagged the Tracker speed list is far larger
  than our 6. `LfoDivision` now mirrors all 29 `LFO_SPEED` members (`128 … 1 … 1/64`, incl. dotted 3/2·3/4·3/8·
  3/16 + triplet 1/3·1/6·1/12·1/24); `'1/1'` kept as a legacy alias of `'1'`. Beats-per-cycle in BARS (`1` = a
  bar = 4 beats). `DIVISION_TO_SPEED` (export) is built by-name (`S${label.replace('/','_')}`). The editor's
  rate control changed from a button column to a **`select-chevron` dropdown** (29 options) + live ≈Hz hint;
  this is in `ModLfoSection` so ALL LFOs (vol/pan/pitch/cutoff/granpos) get the full set. Affects every LFO,
  not just granular.
- **grain start is LATCHED per grain (2026-06-18, fixes "doesn't sound like the Tracker"):** `gran_base_latched`
  holds the grain's start position for the whole grain; the position automation is re-latched only at each
  grain wrap (and seeded at note-on in `claim_voice_slot`). Recomputing base every sample (the original) slid
  the position continuously through each grain = a smooth scrub, not discrete grains. **Verified against
  Sandro's `tracker-pti-editor` granular** (github.com/sandroidmusic/tracker-pti-editor,
  `src/audio/playmodes/granular.ts`, Elementary Audio): it does `el.latch(grainWrap, clampedPos)` for the start
  + `modulatedPos = basePosition + posAutomation·sampleLength` (unipolar add) — confirms both the latch and the
  forward-unipolar polarity. NOTE: that repo is a FULL granular engine (Elementary `el.*`), not the
  no-audio "Instrumented" — good DSP reference for the remaining playmodes.
- `v.position = base` published for the editor playhead; the normal position-advance + one-shot termination +
  loop-seam crossfade + declick-out-fade are all skipped for granular (it rings until env/note-off/steal).
`grain_window` is a free fn near `lfo_eval`.

**Editor (`InstrumentEditorDialog.tsx` + `Waveform.tsx`):**
- **`PlaymodeTabs`** = the `ScreenModeTabs` segmented-tab visual (sample/slice/wavetable/granular); sample +
  granular live, slice/wavetable **disabled** (scaffolded). Sits top-right of the title row.
- **Layout shift by mode:** sample shows the loop toggle; granular shows grain-length slider + position knob
  + shape selector + direction selector (the loop/grain clusters swap). A **contextual 5th automation column
  (grain pos lfo + env)** appears only in granular mode.
- **`Waveform` granular view = the primary control (Chris, 2026-06-18):** a `granular={position,grainMs}` prop
  replaces the trim handles with a grain-window band whose **two edges drag directly** — left edge/body =
  read position (`onGranularPosition`), right edge = grain length (`onGranularGrain`, width→ms via
  `frac·frames/44100·1000`). The header grain-slider + position-knob were REMOVED (the visualizer IS the
  control; header just shows a `ms · %` readout). The playhead shows the live mod-swept position.

**Export (`exportPti.ts`):** `inst.playmode = gran.on ? Granular(7) : trim.loop`; writes `inst.granular`
(grainLength=ms→44.1k frames clamped 44..44100, currentPosition=position·65535, shape/type codes 1:1) and
the granular-position automation → **automations[4]** (LFO if `granPosLfo.on`, else envelope if `granPosEnv.on`).

**⚠️ Caveats / still open:**
- A **flat (non-enveloped) granular voice drones** in pattern playback until voice-steal (same as flat looped
  voices) — granular is for sustained/enveloped sources; preview note-off releases fine.
- Local audition is **approximate** (device-rate grain, single read-head); the `.pti` granular-param fidelity
  is what matters (the hardware renders the real grains). Per the delay-probe lesson, **hardware-verify** that
  granular + automations[4] sound right on the Tracker before trusting the export.
- **slice / wavetable** still unbuilt (the disabled tabs). WtPos→automations[3] still unwired.
- The 6 generic-mod export slots (pan/pitch/tremolo/cutoff-env) remain unwired pending hardware verification.

## Wavetable mode — BUILT 2026-07-12 (app-only, not committed; pending app audition + hardware verify)

The **last playmode** — closes the set (sample / slice / wavetable / granular all live) and wired the
final unwired automation target `WtPos → automations[3]`. `cargo check` + `tsc` both clean. Mirrors the
granular pattern end-to-end (store → accessor → `samplePlayer` → IPC → `audio.rs` read-head → editor →
export). Needs a **full app reload** (samplePlayer + `audio.rs` = full Tauri rebuild, not HMR).

**The model — single-cycle wavetable oscillator.** The sample becomes a bank of fixed-size windows
(`windowSize ∈ {32,64,128,256,512,1024,2048}` frames, each = one cycle). The **played note sets the
pitch** — the in-window phase advances `windowSize · noteHz / deviceRate` per output sample and wraps at
one window, so the fundamental is note-driven and window-size-independent (higher notes sweep the window
faster). This means the sample's own duration/rate **no longer drives playback** — a 2 s pad becomes a
static timbre at the note pitch, scannable only via `WtPos`. Faithful to the Tracker; local audition is
approximate-not-parity as usual, the `.pti` carries the truth.

**Decisions (Chris, 2026-07-12):** (1) **WtPos sweep = morph toggle, crossfade default** — `morph` on
crossfades the two nearest windows (smooth, Serum-style); off snaps to the nearest window (stepped,
grittier). Per-instrument, defaults on. (2) **Scope = wavetable only** — the 4 remaining generic-mod
export slots (open item 2) stay deferred (hardware-gated, Tracker not on hand).

**Files / shape:**
- **Store** (`voiceEditsStore.ts`): `WavetableEdit {windowSize, position, morph}` + `DEFAULT_WAVETABLE`
  (2048 / 0 / morph on) + `WT_WINDOW_SIZES`; `wavetable?`/`wtPosLfo?`/`wtPosEnv?` on `VoiceEdit`;
  `voiceWavetable()` accessor (gated on `playmode === 'wavetable'`). New engine mod slots **8 (wtPos-LFO)
  / 9 (wtPos-env)** in `MOD_SLOT`; `voiceMods` appends them only in wavetable mode.
- **`samplePlayer.ts`**: returns a `wavetable {on, windowFrames, position, morph, hz}` block; `hz` from
  the played `midiNote` (fallback: scene root for an un-noted drum-row trigger).
- **IPC** (`nativeEngine.ts` + `TriggerSpec`): `wtOn/wtWindowFrames/wtPosNorm/wtMorph/wtHz` threaded to
  the command; all 6 trigger call sites (3 App.tsx + 3 monitor.ts) forward `pick.wavetable`.
- **Engine** (`audio.rs`): `MOD_SLOTS 8 → 10`; `wt_*` fields on `Voice`/`MixerCommand::Trigger`/
  `PendingTrigger` + `wt_phase` runtime; `claim_voice_slot` resets phase; read loop gains a
  `if v.wt_on {…} else if v.gran_on {…} else {…}` branch (morph = lerp two `read_at` windows, else the
  rounded window; phase advances `wf·hz/sr`, wraps at `wf`); `mod_wtpos` accumulated from slots 8/9;
  declick out-fade + normal position-advance skipped for wavetable (it scans, never reads through —
  rings until env / note-off / steal, like granular).
- **Editor** (`InstrumentEditor.tsx`): wavetable tab `ready: true`; mode-specific column = window-size
  selector (2-col grid) + **position control that steps through whole windows** (`win k/N`, snapped) +
  `●/○ morph` toggle; readout shows the window + its sample range; contextual **WT POSITION** automation
  column (wtPos LFO/env) on the automation tab.
- **Waveform** (`Waveform.tsx`): 4th display mode — **the current window fills the whole visualizer,
  zoomed in, Tracker-style** (reuses the slice-zoom windowed-peak loader; `viewStart`/`viewSpan` = the
  window span). Dragging the canvas scans window-by-window across the table; live playhead shows the
  read position within the displayed cycle; a `win k/N` corner label orients the scan. (Rev 2026-07-12
  per Chris: the first cut drew the window as a tiny band across the whole sample — wrong; the Tracker
  zooms so one window = full width, and **WtPos is a hard window index** — window 1 = frames
  `[0, windowSize)`, window 2 = `[windowSize, 2·windowSize)`, …, not a continuous scrub.)
- **Export** (`exportPti.ts`): playmode precedence gran > slice > **wt** > loop; `sample.type =
  Wavetable`, `sample.wavetable = {windowSize (snapped), windowCount = floor(frames/windowSize)}`,
  `wavetableCurrentWindow` from position; WtPos → `automations[3]` (env-XOR-LFO, mirrors the granular
  `[4]` block).

**Position modulation — added 2026-07-12 (same session, Chris):**
- ~~**`deviation` self-morph**~~ **REMOVED 2026-07-12** (Chris: "the deviation thing is not working,
  let's just remove that. The LFO does the job."). Was a per-instrument engine-side random-walk drift of
  the scan; ripped out of the whole chain (`WavetableEdit`, `samplePlayer`, IPC, `audio.rs` `wt_dev*` +
  drift state + `WT_DEV_HZ`, editor knob). The `MONITOR_WT_SCAN` live-scan readback was KEPT — it still
  drives the visualizer from the continuous LFO + automation.
- **Visualizer tracks the live scan** — the engine publishes the resolved scan (`MONITOR_WT_SCAN`, incl.
  the continuous LFO + wtPos automation) for the monitored voice via `audio_monitor_wt_scan`; the editor
  polls it (`getMonitorWtScan`, ~30 Hz while previewing) and drives the zoomed window + readout from it
  (`wtEffPos = wtLiveScan ?? modWtPos`), so a held preview with a routed LFO visibly sweeps the window.
- **`wtPosition` as a global app-LFO destination — CONTINUOUS in the engine (revised 2026-07-12 on
  Chris's "for this to work as an oscillator it needs the LFO applied constantly vs every step-fire").**
  First cut sampled it per-note in `samplePlayer` (frozen for the note's duration — wrong for a held
  oscillator note). Now it's a **native per-track LFO destination** (`TrackWtPosition`), computed every
  block on the audio thread exactly like `TrackTune`: `TrackParams.wt_pos_mod` (bipolar deviation, LFO
  compute writes `(apply_lfo(0.5,…) − 0.5) × total_depth` — the extra `× total_depth` makes the response
  **quadratic in depth** so low depths are gentle and full depth still sweeps the whole table; Chris
  2026-07-12 "does A LOT with very little"), and the wt voice adds `track_params.wt_pos_mod()` to its
  scan **every frame** (frozen voices exempt) — so a routed LFO sweeps the window through a held note.
  `samplePlayer` no longer JS-modulates the position (would double-apply); it sends the static base and
  the engine folds in the LFO + the per-instrument automation (slots 8/9) + deviation. Wiring:
  `LfoDestKind::TrackWtPosition` + `is_per_track` + reset pass + compute-loop case (`audio.rs`),
  `'trackWtPosition'` in `nativeEngine.ts` LfoDestKind + `App.tsx` KNOB_MAP + per-track dest filter.
  Editor position control is an `LfoBindKnob` (click-to-route); the visualizer follows the live engine
  scan (`MONITOR_WT_SCAN`) while previewing, so the continuous sweep is visible. Distinct from the
  per-instrument wtPos automation (slots 8/9 → `.pti[3]`, also continuous, what serializes to hardware).

**Wavetable "crunch" — FIXED IN CODE 2026-07-12 (pending ear-verify).** The intermittent crunch was the
k-rate `TrackWtPosition` LFO write stepping the scan at every block edge (plus, in stepped mode, per-frame
window re-picks splicing content mid-cycle) — proven and measured by an offline port of the read branch
(clicks up to 0.58 FS, ~25/s under a sweep; a truly static read renders with zero discontinuities). Fixes:
(1) `wt_track_scan` one-pole (~4 ms) smooths the track LFO deviation per frame; (2) stepped mode latches
the destination window at seam entry and switches exactly on the phase wrap via the seam crossfade
(`wt_wi_cur`/`wt_wi_next`; window switches now quantize to cycle boundaries). Static-scan behavior is
bit-identical. A `[wt-dbg]` jump-detector (monitored voice, ≤2 logs/s) stays in until confirmed. Full
analysis + verify steps in **`docs/wavetable-crunch-debug.md`**.

**⚠️ Still owed:** app audition by ear (does the osc pitch-track + morph feel right); **hardware verify**
— load a wavetable `.pti` on the Tracker, confirm it reads as Wavetable playmode with the right window
size and the WtPos automation moves (delay-probe lesson: a correct-looking map ≠ honored on device).

## NEXT PHASE (historical) — wavetable + slice playback (granular DONE 2026-06-18)

The editable-instrument foundation (params + modulation grid + redesigned editor) and **granular** are in.
Next: the remaining `.pti` playmodes — **Wavetable (6)** and **Slice (4/5)** — wavetable also activates the
last unwired automation target (`WtPos` → `automations[3]`). *(Both now built — see the wavetable section
above and the slice execution plan below.)*

**UI direction (Chris, 2026-06-18):**
- A **playmode selector is the first choice, sitting next to the sample visualizer** (sample / slice /
  wavetable / granular).
- Selecting a playmode **triggers a layout shift** to that mode's param set (sample-window/trim vs
  wavetable window vs granular grain controls — these are mutually exclusive).
- Use the **main-screen tabbed-view feel** (the roll / lfo / fx / master tab pattern) for the
  playmode switch — find and reuse that existing tab component rather than inventing one.

**Open UI questions to resolve when we pick it up:**
1. Exactly how much of the editor is mode-specific vs shared (filter/amp/pitch mods are shared; the
   grain/window clusters are per-mode).
2. What the **waveform display becomes per mode** — granular: position cursor + grain window over the
   sample; wavetable: current window of a multi-window table. (Current `Waveform` is the sample-trim
   view.)
3. **Contextual automation targets** — WtPos / GranularPos should appear *only in their mode* rather
   than as permanent grid columns (lean: contextual, not a fixed 6-wide grid).

**DSP (the marquee piece):** granular = a **single windowed read-head** in `audio.rs` (NOT the
tape-grain pool — the Tracker is single-grain), approximate-but-characterful locally, faithful in the
`.pti`. Build iteratively (smallest audible grain first). Ties into the still-deferred WtPos/GranularPos
export wiring + hardware verification.

## Slice mode — execution plan (firmed 2026-07-07)

Scope: **Slice (playmode 4) only** — BeatSlice (5) deferred, wavetable after slice. Hardware fact
established (manual + Backstage): the Tracker's own sample editor auto-slices from transients
(hand-adjustable, up to 48), but its detection has **no sensitivity control** — so the app's value-add
is authoring: better/tunable slicing on the laptop, auditioned natively, landing on the device as-is
via `slices[48]`. Same author-here/render-there philosophy as granular.

**S1 — slices data + playback — BUILT 2026-07-11 (app-only, not committed; PENDING app audition).**
Zero-Rust, reuses the A3 trigger machinery verbatim; `tsc` clean. Files: `voiceEditsStore.ts`,
`samplePlayer.ts`, `Waveform.tsx`, `InstrumentEditor.tsx`.
- `voiceEditsStore.ts`: `VoiceEdit.slices?: number[]` (sorted 0..1 fractions, ≤48) + `voiceSlices()`
  accessor (gated on `playmode === 'slice'`, returns `[]` otherwise). `PlaymodeTabs` slice →
  `ready: true`.
- `samplePlayer.pickNativeSample` (the single chokepoint): `sliceMode = slices.length > 0 && midiNote`.
  When on, **both the nearest-root bank selection AND the note→pitch derivation are bypassed** — every
  note reads **bank 0** at pitch 1 (tune/finetune still apply as static offsets) — and the returned
  `start`/`end`/`loop` are overridden with the mapped slice's window (`[slices[i], slices[i+1] ??
  trim.end)`, `loop = off`). **Mapping = SCALE-DEGREE, not chromatic (Chris, 2026-07-11):** `deg =
  scaleDegreeOf(note, rootNote, scale)` (octave-aware degree above the scene tonic; off-scale notes
  `snapToScale` first), `i = ((deg % n) + n) % n`. So consecutive scale steps walk slices one-by-one and
  **every slice is reachable from a quantized `.seq`** (a chromatic-scale voice degrades to the old
  semitone-per-slice behavior, since degree == semitone there). Reads the live `rootNote`/`scale` from
  the store at trigger. **S1 limit:** a multisample voice reads only bank 0 in slice mode (slice targets
  are single-sample breaks); the RR index still advances (harmless on 1-path banks). Both flow to every
  native trigger site for free (playback + preview).
- **Live active-slice highlight (2026-07-11):** `pickNativeSample` also returns `sliceIndex`; the App.tsx
  playback + arp dispatch paths `emitSliceHit(voice, index)` (`src/audio/sliceHits.ts`, a bare pub/sub,
  no-op when nobody subscribes). The editor `Waveform` subscribes (filtered to its voice), holds the
  last-fired index with a ~260ms clear timer, and washes that cell bright — so you watch the pattern
  walk the break. Darkens when playback stops.
- `Waveform.tsx`: new `slices?: number[] | null` prop = third display mode (precedes granular/trim) —
  whole waveform bright, a marker line + top grab-tab at each slice start, faint alternating cell
  shading. **Display-only in S1** (pointer handlers early-return; manual marker editing is S2). Playhead
  still sweeps the played slice.
- `InstrumentEditor.tsx`: slice cluster in the mode-specific column = **÷4 / ÷8 / ÷16 equal-grid buttons
  + clear** (`gridSlices(n) = [0, 1/n, …]`) + a `N slc` readout. Loop cluster now gated `playmode ===
  'sample'` (was `!isGran`). `EMPTY_SLICES` module const keeps the slice-less Waveform prop stable.
- **Audition checklist:** reload the Sequence app (samplePlayer edit needs a JS reload, no cargo
  rebuild); slice a break voice ÷8, play a chromatic run from C1 up — each semitone should fire the next
  slice, wrapping after 8; confirm the markers render and the playhead sweeps the fired slice; confirm
  sample-mode voices are untouched.

**S2 — auto-slice from transients + sensitivity + manual marker editing.**

**S2a (auto-slice + sensitivity) — BUILT 2026-07-11 (app-only, not committed; PENDING app audition).**
`tsc` clean; HMR-live. Files: `waveformPeaks.ts`, `sliceDetect.ts` (NEW), `voiceEditsStore.ts`,
`InstrumentEditor.tsx`.
- `waveformPeaks.loadVoiceMono(voiceId)`: decodes + downmixes to a cached mono `Float32Array` (at the
  44.1k decode rate), retained separately from the peaks cache so detection doesn't re-decode.
- `sliceDetect.ts`: split EXPENSIVE/CHEAP so the knob re-slices live. `analyzeVoiceOnsets(voiceId)` (once
  per voice, cached) = ~5ms-hop RMS envelope → **log-energy positive-difference novelty** (log
  compression makes soft ghost-notes comparable to loud kicks, so sensitivity behaves across the dynamic
  range). `pickOnsets(analysis, sensitivity)` (cheap) = local-max peak-pick with an adaptive
  trailing-mean threshold `factor` (3.5→1.1) + absolute `floor` (0.28·max→0.03·max), both eased by
  sensitivity, ~30ms min-gap guard, always leads with slice 0, keeps the strongest ≤ `MAX_SLICES`.
  **`MAX_SLICES = 48` (the .pti format bound, Chris 2026-07-11).** Considered a tighter playability cap
  (slices trigger by scale-degree; the step grid clamps pitch to ±14 degrees, so ~15 slices are reachable
  straight up from root and ~29 with below-root wrap) but Chris chose to keep the full 48 — the per-track
  OCTAVE shift (±4) plus the degree wrap make the upper slices reachable as a deliberate register move,
  and he likes that feel. Density is tuned with sensitivity, not a count cap.
- `VoiceEdit.sliceSensitivity?` (0..1, default 0.5) — a tool param, remembered per voice; re-runs
  detection only when the knob is turned or AUTO pressed, never on load (so it can't clobber slices on
  focus).
- Editor slice cluster: **AUTO button** (detect at the stored sensitivity) + **sens knob** (twisting
  re-slices live — the control the hardware lacks), alongside the S1 ÷4/÷8/÷16 grid fallbacks + clear.
  `sliceAnalysis` ref caches the analysis keyed by voiceId (re-analyzes on focus change).
- **Audition:** slice a break → AUTO → play a chromatic run from C1 (each key = the next onset); turn
  sens up/down to add/remove hits; ÷N grid still there as a fallback.

**S2b (manual marker editing + click-preview) — BUILT 2026-07-11 (app-only, not committed).** `tsc`
clean; HMR-live. Files: `Waveform.tsx`, `InstrumentEditor.tsx`. The slice-mode Waveform pointer handlers
(display-only stubs in S1) now edit: **drag a marker** to move it (clamped between neighbours, ~20ms
min-gap, order stays sorted so the index is stable) · **double-click** empty space to add a marker
(rejected if it would stack within min-gap or exceed 48) · **alt/⌘-click** a marker to remove it ·
**single-click a region** to audition that slice. New props `onSlicesChange`/`onSlicePreview`; the editor
wires `onSlicesChange → setVoiceEdit({slices})` and `onSlicePreview → previewSlice(index, on)`, which
fires `monitorNote(track, quantize(rootNote, scale, index), …)` on its own `slicePreviewId`/track (so it
doesn't tangle with the held-C3 preview button) — the quantized note maps back through `pickNativeSample`
to exactly slice `index`. Cursor is `pointer` in slice mode; `stopPreview` also releases a held slice
audition on unmount.

**S3 — export + save — BUILT 2026-07-11 (app-only, not committed); HARDWARE VERIFY still owed.** `tsc`
clean. File: `exportPti.ts`.
- Playmode precedence now **granular (7) > slice (4) > loop-derived**: `isSlice = voiceSlices(id).length
  > 0` → `inst.playmode = InstrumentPlayMode.Slice`. Slice points → `inst.slices` (a fresh 48-length
  array, fraction → frame point via the same `last`/`PTI_MAX_POINT` ceiling as start/end),
  `inst.numSlices`, `inst.selectedSlice = 0`.
- **numSlices is documented 0..47** (the `slices` array has 48 slots but the count field caps at 47), so
  a maxed 48-slice edit exports **47** (last cut dropped → final two slices merge). Flagged.
- **Save round-trips for free:** `slices` is a `VoiceEdit` field, and `saveInstrument` bakes the whole
  `resolvedVoiceEdit` into the manifest `edits` (JSON), so the array survives save → rescan →
  `resolvedVoiceEdit` with no extra code. (Bench-verify the array actually round-trips.)
- ⚠️ **Open format question, verify on device:** points are written as raw 44.1k frame offsets clamped
  to 65535 (~1.49s). Slicing long breaks is THE slice use case, so a >1.5s sliced sample is the
  hardware test: do points resolve as raw frames (long samples truncate) or normalized units? The
  Rhodes long-sample probe (2026-06-17) was exported but the addressing result was never recorded —
  this test answers both. Also confirm on device whether numSlices actually caps at 47 or allows 48.

**`breaks/` category — BUILT 2026-07-11.** A sixth top-level sample category, sibling to
`drums/`/`pads/`/etc., that scans as **drum-category** so break-loop voices land on the RHYTHM
(drum) track section — the natural home for a chopped break. Wiring: `samples.rs` `CATEGORIES` gains
`("breaks", "drum")` (so the scanner descends into `breaks/` and pre-seeds the folder on first
launch); `manifestRegistry.ts` `inferCategoryFromKitPath` + `inferRoleFromKitPath` map `breaks/` →
category `'drum'` / role `'drum'` (DRUM_MUTATION; kick/hat id-heuristics no-op on break names);
`SampleLibraryPane.tsx` `FOLDER_ORDER` lists it after `drums`. The VoicePicker drum section already
filters `category === 'drum'`, so break kits appear there with no picker change. **Layout:** each
break needs its own SUBFOLDER (subfolder-per-voice), e.g. `breaks/<pack>/amen/amen.wav` → kit
`<pack>`, one voice per break — loose WAVs directly in a kit folder merge into a single round-robin
voice. Workflow: pick a break onto a rhythm track → slice-mode editor (AUTO/sens or ÷N) → play.

**Per-step slice sequencing on the rhythm side — BUILT 2026-07-11 (app-only, not committed).** `tsc`
clean. The gap: a break on a drum row dispatched with NO note (`rootMidi` only ever set inside
`tick.ts`'s `if (melodic)` branch), so `samplePlayer`'s slice path (gated on `midiNote`) never engaged
— every step played the whole loop from the top, with no way to pick a chop. Fix, three files:
- `engine/tick.ts`: compute `sliceCount = voiceSlices(voiceId).length`; add an `else if (sliceCount > 0)`
  note-resolution branch that sets `rootMidi = quantize(root, scale, idx)` — which round-trips through
  samplePlayer's degree→slice map so slice == `idx`. `idx` = `step.sliceRandom ? floor(rand*n) :
  step.pitch mod n`. Random re-rolls per fire (tick runs per dispatch). Track OCTAVE shift deliberately
  skipped for slice voices so the Inspector dropdown addresses slices 1:1.
- `state/store.ts`: `Step.sliceRandom?: boolean` (sparse plock, sits beside `chordVoicing`/`accumulator`)
  + `setStepSliceRandom` (false collapses to undefined). Slice INDEX reuses `step.pitch` (0-based) — no
  new field, `setStepPitch` doesn't clamp so indices past the melodic ±14 are fine. `hydrate.ts`
  round-trips the flag; export is a wholesale `JSON.stringify` so the index + flag both persist.
- `components/StepInspector.tsx`: for a slice voice (sliceCount>0) the melodic note editors are replaced
  by a **`slice` dropdown (1…N)** + a **`○/● random` modifier toggle** (labeled-circle, no border per
  convention). Big label shows `SL n` / `RND`. Click any drum step (handleClick isn't section-gated) →
  pick its chop. Selection persists under the random toggle (dropdown dims when random is on).
- **Audition (needs a FULL app reload — engine edit is stale under HMR):** slice a break ÷8 → drop it on
  a rhythm row → click steps, set each to a different slice (or flip `random`) → play; watch the editor
  waveform's live slice-highlight walk the pattern.

**S4 — deferred:** BeatSlice (5); piano-roll slice-number ergonomics; Launchpad slice pads.

Decisions taken 2026-07-07 (revisit if they feel wrong in use): chromatic-from-C1 wrap mapping;
slices play unpitched; grid-slice buttons ship in v1 alongside AUTO.

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

## Open / remaining (current — see the STATUS block up top)

Resolved since the original list: `NS-Kick.pti` + `NS-Rhodes` **loaded + played on hardware**
(2026-06-17); the in-app exporter **shipped** (`61979c3`, OfflineAudioContext resampler, stereo,
median-root); the granular voice **shipped** (`0e4b0c0`). What's still owed:

- **Slice + wavetable playmodes** (disabled scaffolds) + the `WtPos` → `automations[3]` export wiring.
- **Generic-mod `.pti` export** — wire pan/pitch/tremolo/cutoff-env into `automations[]`
  (env-XOR-LFO pick logic for slots 0/2), **after** each is hardware-verified (delay-probe lesson).
- ~~Hardware A/B of granular + `automations[4]`~~ DONE 2026-06-22 (close enough; delay/reverb mapping
  also confirmed).
- **Save-dialog-direct-to-SD for `.pti`** — currently downloads to the default dir (copy to SD by
  hand); needs blob capture or a Rust `save_binary_file`.
- **By-ear calibration** of Gauss grain width + grain-repeat for the local audition.
- **Instrument params as app LFO destinations:** increment 1 (per-note grain length/position drift)
  BUILT 2026-06-22; increment 2 (continuous in-note sweep) deferred — see the section above.
- `npm audit` advisories (transitive dev deps via jszip/typedoc) — review, do **not** run
  `audit fix --force` blind.
