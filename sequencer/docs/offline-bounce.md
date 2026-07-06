# Offline bounce — design (not yet built)

Status: DESIGN ONLY (2026-07-06). Realtime stem capture already ships (the
transport "multi" toggle → `audio_start_recording_stems`: master + fx bus +
reverb return + delay return + up to 16 per-track dry WAVs, sample-locked,
Σ(stems) = pre-master mix). As of 2026-07-06 all recorder output is 32-bit
float WAV. This doc scopes the genuinely missing piece: **render the
arrangement from bar 0, faster than realtime, without performing it**.

## Why a pure-Rust bounce is impossible today

The Rust engine is a sample-accurate voice dispatcher: it plays
`MixerCommand::Trigger`s at absolute `ENGINE_FRAMES` deadlines and knows
nothing about steps, banks, or songs. Every musical decision — which steps
fire, mutation tree state, ghost density/fills, chord resolution + voicing
macro, accumulators, round-robin sample pick, velocity, envelope hold, arp
splitting — happens in JS (`engine/tick.ts` `runTick` + the dispatcher in
`App.tsx`), paced by `scheduler.ts` (25ms setTimeout loop, 250ms horizon)
against the extrapolated engine clock. Rust cannot re-derive the note
stream; rendering without JS renders silence.

Faster-than-realtime with JS *in the loop* is equally dead: the scheduler
paces itself off wall-clock extrapolation of `audio:time` events and only
ever holds 250ms of musical future.

## Two-pass design

Same record-and-replay-then-deterministic-render pattern reel-render uses.

### Pass 1 — JS capture (no audio)

`runTick` already takes explicit `globalStep / when / stepDuration` inputs,
so it can be driven synthetically in a tight loop over the song/arrangement
range. Work items:

- **Instance the cross-tick state machines.** Harmonic motion, chord
  context, accumulators (`treeState.ts` / `accumulator.ts` per-placement
  counters), and ghost state live in module/`App.tsx` closures today. The
  capture pass needs fresh instances (or a reset + exclusive run while the
  transport is stopped — acceptable v1: capture is a modal "bouncing…"
  operation, transport locked).
- **Bake schedule-time modulation.** JS-side macro LFOs (`modulated()` in
  tick.ts) are computed at schedule time and land inside each TriggerSpec —
  free once runTick runs.
- **Capture runtime automation streams** with frame timestamps, since
  they're normally pushed live: RAF `setTrackFiltersBulk` values (knob/LFO
  bases), glitch fires (`fireGlitch` dice per beat), delay-time sync pushes,
  master/FX param changes. v1 can snapshot these as constants at bounce
  start; v2 replays a timeline.
- Output: a `BounceScript` — ordered `TriggerSpec[]` with absolute target
  frames + automation events + total length (incl. tail seconds).

### Pass 2 — Rust offline render

- **Extract the render body.** The ~1600-line cpal callback closure
  (`build_stream`) becomes `struct EngineDsp { voices, pending, reverb_bus,
  delay_bus, tape, glitch, master, scratches } + fn render_block(&mut self,
  buf, frames)`; the cpal closure and an offline loop both call it. Mechanical
  but large; touchy areas are the closure-local recorder producers and the
  first-block logging.
- **Instance the param state.** TRACK_PARAMS / REVERB_STATE / MASTER_STATE /
  LFO_SNAPSHOT are global OnceLock singletons — an offline render sharing
  them would fight the live UI. Either take an exclusive lock on the app
  (modal bounce, v1) or parameterize `EngineDsp` over an owned param set.
- **Feed triggers from the BounceScript** instead of the SPSC ring; run
  Rust-side LFOs off the offline frame counter (they already key off
  ENGINE_FRAMES-relative phase).
- **Write stems** through the existing per-track stem taps — the offline
  loop reuses `push_rec_frame`/writer workers or just writes directly
  (no realtime constraint, no rings needed).

### Determinism caveats (accepted, not blockers)

- Per-trigger ±3-cent tune jitter, tape/glitch/dist RNGs, granular spray
  are seeded from wall clock — an offline bounce is *a* performance, not a
  bit-exact replay of a previous one. That matches the instrument's
  philosophy (mutation/ghost are performance anyway).
- A bounce with ghost ON captures one roll of the ghost's dice. Fine —
  same as the realtime recorder.

### v1 scope cut

Modal bounce (transport locked, UI frozen behind a progress bar), automation
snapshot-as-constants, ghost optional, fixed tail-out seconds, stems +
master in one pass. The capture pass is the smaller half; the `EngineDsp`
extraction is the big refactor and is also what would unblock any future
non-cpal backend.

## Interim answer for DAW workflows

The realtime multi capture already covers stems: arm **multi**, play the
song from the top, stop; 32f WAVs land sample-locked in one folder. Offline
bounce buys speed and hands-free arrangement rendering, not new audio.
