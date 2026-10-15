# Channel strip: track bus + EQ + FAT saturator

Status: P3 (FAT) + per-track COMP built 2026-10-12, released in 0.20.0 (2026-10-15). P1 (EQ) + P2 (spectrum) + strip bypass SHIPPED 2026-10-12. P0 (null bus) SHIPPED 2026-10-12 — null check max |diff| 7e-7 over ~100 s of a dense song, shadow path removed. Design 2026-10-04. Chosen over a Wavestation-style wave-sequencing
voice. Wave sequencing is parked: hardware route = a Wavestation SR via
`tools/rack`; software route = a "stepped" scan mode on the existing wavetable
voice.

Goal: Chris mixed the EP in Logic with **Kilohearts Faturator + EQ on almost
every track**. Bring those two in-app as a per-channel strip so the mix can
happen in Sequence. The EQ is a **utility** (the no-transparent-effects rule
doesn't apply). Per-track BOUM compression comes after; see Later.

## Decisions (Chris, 2026-10-04)

- **Lives on the channel, not the instrument.** Instrument edits are global
  (saved in `kit.seqkit` by `saveInstrument.ts`) and shape *the sound*. The
  strip is *mix fit*, which depends on the song, so it's saved in the `.seq`.
- **Per track slot, not per bank.** Chris rarely uses banks. Saved as a
  top-level `channelStrips: Record<trackId, ChannelStrip>` in the `.seq`,
  OUTSIDE the `Track` objects that `cloneTrack` snapshots into banks. So a
  bank swap never changes the mix.
- **Sends post-strip.** Reverb/delay/mangler hear the EQ'd, saturated track.
- **Stems post-strip.** Per-track stems record what you hear.
- **Order:** voice → (per-voice filter, unchanged) → track bus → COMP →
  FAT ⇄ EQ → sends / stems / output. (COMP added 2026-10-12, Chris: "should
  we also add a compressor at the start of this?" — so each note hits FAT at
  a more even level.) **FAT defaults BEFORE the EQ, with a pre/post
  toggle** (Chris, 2026-10-12: "it would make sense to have the saturation
  sit before this as well — or have an option for pre-post"; the EQ then
  shapes the saturated sound, like the instrument drive he already sees in
  the spectrum).
- **Whole-strip bypass** (2026-10-12): `ChannelStrip.bypass`, one button in
  the eq tab; fades the strip out with all settings kept.

## Engine today (what changes)

There is no per-track summing point. In the voice loop (`audio.rs` ~7464 /
~8180), each voice writes `ls·gain·pan·dry_scale` straight into the device
`buf` at its own `out_first`/`out_stereo`. It also accumulates into `fxbus`
(mangler, `fx_send` crossfade), `rev_send`, `delay_send`, the
`rhythm`/`melody` section taps and (when recording) `stem[rec_track]`. The
master (`MasterStage`, ~2568) only processes channels 0+1. Tracks routed
elsewhere with multi-out already bypass it; that stays true.

## P0: null bus (sounds identical)

The risky refactor. It ships alone, with no processing.

- **Bus slots.** `TrackParams` gets a `bus_slot` assigned at
  `get_or_create_track_params` (first-come, cap `MAX_BUSES = 32`;
  over-cap falls back to the direct path). Like `rec_track`, but
  permanent.
- **Scratch.** Preallocated `bus_l/bus_r[MAX_BUSES][REVERB_SCRATCH]`
  (~2 MB) plus a per-slot `touched` flag. Only touched slots get cleared and
  processed, so 16 idle tracks cost ~nothing.
- **Voices write to the bus.** Stereo-routed: `ls·gain·pan` (pre-send).
  Mono-routed (multi-out on, single output): the track **ignores pan**
  (Chris, 2026-10-12: "multi out should ignore panning and send mono
  center"). Voices enter the bus centre-panned (`×√½` each side), and the
  output fold `(L+R)·√½` is exactly today's unpanned `0.5·(L+R)·gain`. The
  sends hear the centred signal too, which only differs from before on a
  mono-routed track whose pan knob is off-centre. The bus also records the
  track's `out_first` / `out_stereo` / `section` from the first voice to
  touch it in a block.
- **After the voice loop, per touched slot:**
  `dry_scale`/`fx_send` crossfade into `fxbus`, `reverb_send`/`delay_send`
  into their aux buses, section tap, stem tap, then the output write with the
  same multi-out / out-of-range fold logic as today. Sends are linear and
  every voice of a track shares one `TrackParams`, so this is mathematically
  the same mix.
- **Voices with no `track_params`** (instrument preview/monitor, click,
  manual panel triggers) keep the existing direct path.
- **Bank-swap freeze.** `frozen_params` keeps freezing *filter*
  cutoff/res (still per-voice). The frozen **send** values are dropped:
  after a swap, a track's tails follow its live sends. This is the one
  audible behaviour change. Accepted because sends are now post-strip and
  banks are rarely used.
- **Null check.** In debug builds, render the old direct path into a shadow
  buffer in the same callback and log the per-block max |diff|. Ship when
  it's ≤ ~1e-6 (float summation order differs, nothing more) and it sounds
  identical by ear. Then delete the shadow path.

## P1: EQ (engine + visual editor)

- **Bands:** HP + LP (12/24 dB slopes) + 4 parametric bands, each
  bell / low-shelf / high-shelf / notch, each with on/off. Covers the
  Pro-Q workflow without unlimited nodes.
- **DSP: Simper/Cytomic trapezoidal SVF**, not biquads. It stays stable
  and zipper-free under fast drags. Also, f32 biquads are marginal at very
  low frequencies (see the master lo-cut DC drift, 2026-09-08). Floor HP at
  20 Hz. Coefficients are recomputed per block on change and smoothed over
  the block.
- **Bypass is free:** no bands on means the slot skips the EQ.
- **State:** `ChannelStrip.eq = { bands: EqBand[6] }` with `{ on, type,
  freq, gainDb, q, slope? }`. `hydrate.ts` defaults a missing strip to flat,
  so every existing `.seq` sounds identical.
- **IPC:** `audio_set_channel_strips_bulk`, the same pattern as
  `setTrackFiltersBulk` (pushed from `paramPush.ts` on change, snake_case
  serde).
- **UI:** a new `eq` tab in `ChannelScreen` (the existing screen-mode row
  of params / roll / lfo / fx / master …) that edits the **focused track**.
  - The curve is drawn in JS from the same SVF magnitude math, with no
    audio data needed. Drag a node for freq/gain, scroll for Q. Double-click
    the empty curve to enable the nearest free band, double-click a node to
    turn it off.
  - **Monochrome**, per the sequencer UI rule: bright-white curve,
    outlined-circle nodes, filled when selected, no per-band colours. Text
    labels on every control while building.

### P1 as built (2026-10-12)

- Rust: `BusEq` per bus slot (6 × `EqBandRt`, Cytomic SVF), params smoothed
  and coefficients recomputed every 16 frames, 10 ms band on/off crossfade.
  Strip settings live on `TrackParams` as a seqlock (`strip_ver` +
  `strip_words`), read at a bus's first touch each block. IPC
  `audio_set_channel_strips_bulk` (whole strip per changed track; paramPush
  diffs by object identity).
- Tails: a bus whose strip is on keeps running for 1 s after its last voice
  (`STRIP_TAIL_SECS`) so resonant bands / steep low HPs ring out.
- Band layout: [0] HP, [1] LP (12/24 dB; Q = resonance, 24 dB = Butterworth
  pair with Q scaling the resonant stage), [2..5] bell/low-shelf/high-shelf/
  notch. Ranges: 20 Hz–20 kHz, ±18 dB, Q 0.1–18.
- UI: `eq` tab (`EqPanel.tsx`), focused track. Strips are global per .seq
  like the master (BROADCAST applies them at song swap); init clears them.

### P2 as built (2026-10-12, alongside P1 — Chris asked to see the audio)

- Rust: `STRIP_AN_SLOT` picks one bus; the bus pass writes its mono pre- and
  post-strip signal into two atomic rings (`strip_an_push`), silence when the
  track is idle. lib.rs level emitter runs `StripAnalyser::frame()` (2048-pt
  radix-2 FFT, Hann, 96 log bins 20 Hz–20 kHz, peak-per-band, fast attack /
  ~300 ms release) → `audio:strip-spectrum` at ~30 Hz, only while on.
- IPC `audio_set_strip_analyser(trackId | null)`, driven by EqPanel's
  mount + focused track.
- UI: canvas under the curve — post-strip soft fill + line, pre-strip dashed
  line; own scale −84..0 dBFS with a +4.5 dB/oct tilt around 1 kHz.

## P2: spectrum behind the curve

- FFT runs on the **focused track's bus only** (one analyser), post-strip,
  with an optional faint pre-strip trace.
- Rust: a 2048-pt Hann FFT, folded into ~96 log-spaced bins with
  attack/release smoothing, emitted as a small `f32` array event at ~30 Hz.
  It's a tiny payload, so it avoids the slow binary-IPC path.
- JS draws it as a low-opacity white fill under the curve.

## P3: FAT saturator (Faturator-style, per track)

Modelled on [Faturator](https://kilohearts.com/docs/faturator)'s controls,
not an emulation. Its key property is that **it preserves dynamics**, which
is why it can sit on every track.

Chain (per track, stereo), where on/off is a modifier toggle placed first and
mix is last:
1. **color**: a bell boost (+9 dB, Q ~0.8, freq 80 Hz–8 kHz) into the
   shaper, with the inverse bell after it. This generalises the master's
   fixed 3 kHz pre/de-emphasis into a tunable control.
2. **drive**: 0–40 dB into an asymmetric soft clipper (tanh family, small
   bias with DC block after, the same flavour as BOUM Tube).
3. **fuzz**: a parallel HP (~2 kHz) of the driven signal through a hard
   clipper, blended in. Adds high-frequency fuzz.
4. **2× oversampling** around steps 2–3 using a polyphase halfband FIR (~31
   taps). Hard clipping needs real oversampling; the master's linear-interp
   2× is too weak for this.
5. **Dynamics restore**: RMS followers on the input and output (~10 ms).
   Gain = env_in / env_out, smoothed (1 ms attack / 40 ms release) and
   clamped to ±12 dB. Drive adds density and harmonics without flattening
   transients or jumping level.
6. **turbo**: a Haas widener that delays one wet channel 0–12 ms (the sign
   of the control picks the side).
7. **mix**: equal-power dry/wet, reusing `master_dist_mix_gains`.

State: `ChannelStrip.fat = { on, drive, fuzz, color, turbo, mix }`, off by
default. UI goes in the same `eq` tab, as a labelled knob row under the curve.

### P3 as built (2026-10-12)

- Both passes in one go (Chris: "let's roll those together"). Color is the
  defining control (Chris: "the key feature … is the specific frequency
  selector") — drawn as a dotted `fat` marker on the EQ curve.
- `BusFat` per bus: color bells at 1×, drive (asymmetric tanh, bias 0.2) +
  fuzz (2 kHz HP, hard clip) at 2× via the shared `Halfband2x` (factored out
  of the master inflator), de-bell, 10 Hz DC block, stereo-linked RMS restore,
  turbo Haas, equal-power mix with the dry delayed 23 samples. **The track is
  23 samples (~0.5 ms) late while FAT is on.**
- Restore deviates from the plan: it may cut as far as the drive boosts (+12
  dB spare), not ±12 dB, and rises in 3 ms, not 40 — both were needed for the
  "keeps dynamics at full drive" test (24 dB burst/bed ratio in, within 3 dB
  out). Boost is still capped at +12 dB.
- **Retuned the same day for "girth"** (Chris: "this sounds very fizzy" →
  "heavily increasing harmonic overtones and a feeling of girth vs just
  adding high end hiss"). Faturator's internals aren't published, so the
  target became the description. Changes, each measured with the ignored
  `fizz_report` test (`cargo test --lib fizz_report -- --ignored
  --nocapture`): lopsided tanh (neg ceiling 0.55) + envelope bias shift
  INTO the lopsided side (keeps the 2nd harmonic at any drive), only the
  shaper's added residual low-passed at 6× color (12 dB/oct), drive taper
  ^1.5, restore boost range = drive + 12 dB. 1 kHz-at-color default drive
  went from h3 −4 / h5 −10 / h7 −17 dB (fizz) to h2 −6 / h3 −11 / h5 −32 /
  h7 −43 dB; bass 110 Hz heavy: h2 −11, h3 −15.
- **Blown zone** (Chris: "I'd like this to be able to absolutely blow out a
  signal", was running drive at 40 dB): drive now 0–60 dB, 40 dB at 0.8 of
  the knob (taper 1.817). Past 40 dB: bias shift ×1..2.3, residual LP opens
  6× → 16× color, RMS windows 10 → 150 ms (dynamics flatten). The residual is
  now taken against the shaped wave LEVEL-MATCHED to the input by envelope —
  scaling by 1/drive collapsed at high drive into a clean filtered copy.
  Boosting the residual was tried and dropped (cancels the fundamental).
  Full drive: bass 110 Hz h2 −6, h5 −18; 1 kHz-at-color h2 0, h5 −5.
  UI drive readout shows dB and "· blown" above 40.
- **Split before the shaper** (Chris, still "pretty fizzy"): sine-ladder
  tests missed it — real fizz is intermodulation (bass × hats → sum/diff
  tones across the top). Now only the signal below the girth cutoff (2.5×
  color, 24 dB/oct) is shaped; highs bypass it, and the residual low-pass is
  the same cutoff at 24 dB/oct, added onto the delay-aligned input. Blown
  opens the cutoff only 2.5× → 3×. New ignored `imd_report` test (80 Hz +
  5.2 kHz, spray above 2 kHz): default −21.7 → −50.2 dB, 40 dB −13.5 →
  −28.6, full −9.7 → −24.5. Bass octave at full drive still −7 dB.
  Caveat: a high color (≥ 4 kHz) puts the cutoff ≥ 10 kHz, so highs get
  shaped again — color is the focus, by design.
- **Redesigned around a focus band** (Chris: "the novelty of the faturator
  was that it would focus the explosive distortion around a specific
  frequency even if there was very little signal there. With what we've
  built it has to be focused around the core of the sound or else it does
  nothing"). The color bell + split are gone. Now: band-pass around color
  (two SVF stages, Q 0.9) → lifted to the track's level by envelope (≤ +30
  dB, not below −80 dBFS) → lopsided + bias-shift shaper (2×) → only the
  added part (level-matched, low-passed at 6× color, 24 dB/oct) is added
  onto the untouched track → level restore. Test
  `color_erupts_even_where_the_signal_is_faint`: a 2 kHz partial 30 dB
  under a 100 Hz body → its h2+h3 −13 dB vs the body with color on it, −92
  dB with color at 100 Hz. Trade-off: the lift also lifts leakage into the
  band, so `imd_report` spray sits between the original and the split
  version (default −31.6, 40 dB −22.2).
- Strip words: FAT block after the bypass word (`FAT_WORDS_START`); bypass
  fades FAT out too. `ChannelStrip.fat`, off by default, drive 0.35 when
  switched on.

### COMP as built (2026-10-12)

- The master's BOUM compressor, extracted from `MasterStage` into
  `BoumComp` + `BoumCompBlock` (same maths, same order). The master is
  **bit-identical**: `master_comp_golden` (ignored tests `write_golden` /
  `matches_golden`, golden file in the session scratchpad) rendered ~368k
  samples across four comp settings, stereo + mono, before and after.
- `BusComp` per bus: on (10 ms fade), amount, attack/release indices into
  the master tables; defaults amount 0.5, 10 ms, 300 ms. Strip words: COMP
  block after FAT (`COMP_WORDS_START`). Bypass covers it.
- Gain-reduction meter: the analysed bus writes `STRIP_AN_COMP_GR`, carried
  in `audio:strip-spectrum` as `comp_gr`.
- UI: the tab is now **channel** (was eq, briefly strip) — comp column |
  curve + band controls | FAT column. The screen tabs are grouped (Chris,
  2026-10-12): params automation roll channel | lfo fx master loops noise |
  perform — per-track | global | performance.
- Threshold is absolute (BOUM's −0..−30 dB over the knob), so a quiet
  track needs more amount before it bites — watch the GR meter.

## Later (filed, not designed here)

- **Per-track BOUM compressor.** `MasterStage` is already an instance
  struct with params passed into `process_block`. Factor the comp section
  out of it and run one per bus, after FAT.
- **Saturation consolidation.** There are four separate saturation stages
  today: per-instrument `sat_drive` tanh (+ crush), mangler drive
  (`pre_saturate_sample`), master BOUM dist (Boost/Tube/Fuzz/Square), and the
  new FAT. Fold them into one shared Rust saturation module with a mode menu:
  BOUM modes selectable on tracks, FAT selectable on master, the instrument
  stage picks from the same menu.
- Hardware mapping (XL3 / MIDI learn targets for focused-track strip),
  curve thumbnails on track rows.

## Verification per phase

- P0: shadow null check plus an ear A/B on a dense song. Stems still sum to
  the pre-master mix. Multi-out routing still lands on the right channels,
  and the out-of-range fold still works.
- P1–P3: old `.seq` files load flat and sound identical. Extreme settings
  (24 dB slopes at 20 Hz, +18 dB narrow bells, max drive + fuzz) stay stable
  with no DC creep. CPU with all 16 strips on is checked in the app.
- Everything is tested in the Tauri app (`npm run tauri:dev`), never the
  5173 web server.
