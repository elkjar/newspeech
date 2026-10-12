# Channel strip: track bus + EQ + FAT saturator

Status: P0 (null bus) SHIPPED 2026-10-12 — null check max |diff| 7e-7 over ~100 s of a dense song, shadow path removed. Design 2026-10-04. Chosen over a Wavestation-style wave-sequencing
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
- **Fixed order, no reorder UI:** voice → (per-voice filter, unchanged) →
  track bus → EQ → FAT → sends / stems / output.

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
