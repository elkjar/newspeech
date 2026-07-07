# Perform mode — punch-in FX layer (planned 2026-07-07 · P1 + P2 landed 2026-07-07)

A manual live-performance layer modeled on the Polyend Tracker's Perform mode — the feature
Chris beats up hardest on the hardware. Non-destructive punch-in effects over the playing
pattern, applied **only to a selected set of tracks**, vanishing on release/exit. The manual
twin of Ghost: Ghost is the autonomous expression layer, perform is the hands-on one.

## How the hardware does it (manual v1.5, verified 2026-07-07)

- 12 configurable FX slots, each with 4 values: off + 3 customizable presets, punched in from
  the grid (or MIDI CC51–62).
- **Track selection is the core gesture**: 8 screen buttons choose which tracks the punch-ins
  affect (marked red; MIDI CC41–48). Effects are *offsets* relative to pattern/instrument values.
- Step repeater values run **16 steps → 1/16 of a step** (sub-step = stutter/roll territory).
- Everything is session-state: exiting perform mode drops all of it.

## Scope — Chris's four (2026-07-07)

The four he actually uses on hardware, in build order: **beat repeat · reverse · filter · tune**.
No 12-slot generality in v1 — these four, hardcoded, done well (scope-to-workflow). The
track-mask + punch-in framework they share is what generalizes later if wanted.

## Architecture mapping (why this is cheap here)

Perform state = session-only (never persisted — same rule as active bank/scene):

```
{ trackMask: Set<trackId>,
  repeat: { engaged, windowSteps | subStepDiv, engageStep },
  reverse: boolean, tuneOffset: semis, filterOffset: -1..1 }
```

Three insertion mechanisms cover all four FX:

1. **Scheduler step-remap** (beat repeat ≥ 1 step). While engaged, the effective pattern step
   for masked tracks loops the captured window: `repeatStart + (elapsed mod windowLen)`. The
   real step counter keeps advancing underneath → release resumes exactly in-position (matches
   hardware). Grid keeps showing the authored pattern (existing convention — the live layer
   only drives audio). **Punch-in quantizes to the next window boundary**, which is musically
   right AND hides the 250ms dispatch horizon (already-dispatched triggers up to the boundary
   are what would have played anyway).
2. **Sub-step retrigger** (beat repeat < 1 step). Absolute-frame trigger dispatch makes rolls
   trivial: re-dispatch the captured step's trigger every windowFrames. No engine change —
   just more triggers at closer spacing.
3. **Trigger-time override** (reverse, tune) + **live track-param offset** (filter).
   - Reverse: flip masked tracks' trigger to reverse one-shot (`loopMode` code 4 — already in
     the engine since 0.8.12) at dispatch time.
   - Tune: add the offset to the pitch computed in `pickNativeSample`/dispatch for masked
     tracks (new notes pitched, ringing notes unaffected — matches hardware).
   - Filter: ride the existing live per-track filter path (`audio_set_track_filters_bulk`) —
     affects already-sounding voices continuously. Punch-in = offset applied over the track's
     knob value; release = restore knob value. NOTE the swap voice-param freeze: in-flight
     tails freeze filter on bank swap — acceptable, perform is a within-groove gesture.

Mutation interplay (decision): the repeater remaps the **step index** and lets mutation apply
per read — the repeat stays alive under Ghost rather than freezing a snapshot. Revisit only if
it fights the music.

## Build increments (smallest audible first)

- **P1 — repeat core, keyboard-driven.** Perform state + scheduler remap + sub-step
  retrigger + quantized engage/release. Hold-key UX (momentary), length from the number row.
  Track mask exists from day one but defaults to ALL tracks so P1 is audible with zero setup.
- **P2 — track mask UI + the other three FX.** PERFORM tab in the channel screen: track-select
  row (chunky primary toggles) + repeat-length buttons + reverse toggle + tune/filter offset
  knobs (labeled while building). Reverse/tune at trigger-time, filter via the live bulk path.
- **P3 — Launchpad perform page.** The real surface: grid columns = tracks, rows = repeat
  rates, hold-to-punch; a row for reverse/FX toggles. This is where it becomes the thing that
  gets beaten up. (Launchpad bridge + quadrant machinery already exists.)
- **P4 — later/optional:** value presets per FX (the hardware's 3-position rows), more FX in
  the same framework (pattern play-mode, sends), XL3 mapping, latch mode.

## P1 build notes (landed 2026-07-07)

- `src/audio/perform.ts` — session singleton (same ownership shape as harmonic motion):
  arm/release from the keyboard, `performRepeatForTick(sceneStep, sceneStartStep)` anchors the
  window once per dispatcher tick. Re-anchors on scene swap or transport restart (scene-space
  coords go stale). Track mask exists (`isTrackMasked`), empty = ALL.
- Engine (`src/engine/tick.ts`, `TickInputs.perform`) — two regimes per masked track:
  - **window ≥ row stride → step-remap.** `effSceneStep = windowStart + ((sceneStep −
    windowStart) mod w)`; ladder values and strides are both powers of two so window
    boundaries always align to row steps.
  - **window < row stride (incl. sub-tick) → stutter.** Retrigger the row step that was
    sounding as the window closed, every `w` ticks; sub-tick windows emit `1/w` triggers per
    tick via the ratchet spacing. Stutter drops ties + microTiming and bounds note holds to
    the sub-window (retriggers clip each other into a roll instead of stacking tails).
- Keyboard: **hold `r`** = punch in (momentary, keyup/blur releases), **number row 1–9** while
  held = the full hardware ladder (16 → 1/16). Digits stay edit-mode keys when `r` isn't held.
  Bare `r` re-engages the last-used length (session default: 2 steps). `REPEAT n` badge
  bottom-left while engaged.
- Release is **unquantized** (state clears; already-dispatched horizon ticks play out) — the
  real counter kept advancing so resume is always in-position. Revisit only if it feels loose.
- **Capture direction (open question 2, revised in build 2026-07-07):** v1 quantized engage UP
  to the next window boundary and captured backwards from it (the hardware-manual reading). By
  ear that was wrong here — the captured window sat ~horizon+quantize in the *future*, so in
  sparse patterns holding the repeat looped not-yet-heard, often-empty windows ("the notes
  drop out"). Now the capture anchors at the AUDIBLE step at keypress (the scheduler head runs
  ~250ms ahead of the ear — anchoring there catches a neighboring step) and snaps DOWN to the
  grid-aligned window containing it — loops what was being heard, phase-locked to the bar.
  Stutter regime likewise machine-guns the row step audible at punch-in.
- **Repeat replays VERBATIM (mutation-interplay decision reversed, 2026-07-07).** The original
  "remap the index, let mutation apply per read" plan audibly wandered pitch inside the loop
  (mutation re-rolls + accumulators advancing per stuttered fire) and fought the
  catch-and-stick gesture. Repeat reads now run the freeze path per masked track: replay the
  captured mutation-overlay outcome, no overlay writes, no counter advances (`replay` flag in
  runTick = global freeze OR track-under-repeat). Mutation resumes on release.
- **Punch edges are flushed-and-redispatched (P1.5, same day).** Engage AND release used to
  wait out the ~250ms of already-queued absolute-frame triggers ("release feels like it's
  continuing"). New `MixerCommand::FlushPending { min_frame }` drops queued-unfired triggers
  from ~now+30ms; the dispatcher then re-runs `dispatchTick` for exactly the scheduler's
  pending ticks under the new perform state (redispatch mode skips bar commits / ghost /
  harmonic-motion advance / MIDI-out / stream events — only native trigger emission re-runs).
  Both edges now land within ~30ms. Redispatch is side-effect-safe by construction: punch-in
  re-emits as verbatim replay (no advances), release re-emits ticks that never advanced
  counters (they were replay ticks when first dispatched).
- MIDI-out hardware keeps the horizon latency on punch edges (its scheduled notes can't be
  flushed; re-emitting would double them). Revisit only if hardware-heavy sets make it felt.
- Known watch-item: long authored tie-chains (bass sustains at fast rates) read as
  tie-silenced inside a remapped window, so those tracks can thin out under repeat. Leave
  until it bothers the music.

## P2 build notes (landed 2026-07-07)

- **PERFORM tab** (`src/components/PerformPanel.tsx`, new `perform` ScreenMode at the end of
  the tab row). Thin view over `audio/perform.ts` getters — `performVersion()` is the
  useSyncExternalStore snapshot. Layout mirrors the Tracker's perform screen (reworked same
  day on Chris's feedback): **effect columns of 4 punchable value slots** (repeat · rev ·
  tune · filter) with the **channel row — 16 even track pads — across the bottom**.
- **Slots = the hardware's off + presets model.** Each of repeat/tune/filter/bits has 4
  configurable value slots. Assignment: the **SET toggle** (top-right, ○/● modifier weight)
  flips the slots into assign mode — vertical drag (knob-style, dashed border + ns-resize
  cursor) or scroll-wheel changes a slot's value; punching pauses while on. Outside set
  mode values are LOCKED — scroll-edit originally worked anytime, but an accidental mouse
  wheel over a pad silently rewrote the rig (Chris hit it same day), so editing is
  set-mode-only. Steps: repeat walks the ladder, tune ±1 st, filter ±5, bits ±1.
  Slot VALUES persist as rig config (`newspeech.sequencer.performSlots` in localStorage,
  versioned `{v: 2, ...}` — v2 one-time reset the bits column to the post-floor-drop ladder;
  bump the version for future forced migrations); which slot is engaged stays session-only.
  Defaults: repeat 1 · 1/4 · 2 · 1/8, tune −12 · −5 · +7 · +12, filter 20 · 60 · 10 · 90,
  bits 4 · 3 · 2 · 1. Editing an engaged slot retunes the live punch (getters read the
  array).
- **Bits** (added same day at Chris's request) — latching slot column of bit depths (now
  1..16; the engine's per-voice crusher, 16 = bypass). At dispatch, masked tracks take
  `min(voice bits, slot bits)` — a punch only ever DEEPENS the crush; it never cleans up a
  voice authored crunchier than the slot. New notes only, same boundary as tune.
  **"Not hearing it" fix (same day):** the crusher quantizes near-full-scale sample data
  early in the voice chain (pre track-filter/env/gain), so 12/8 bits are near-inaudible and
  the engine's old floor of 4 was only mild grit — Chris's Tracker "destroy everything"
  lives below it. Engine clamp dropped 4→1 (2 bits = five levels, 1 bit = full square);
  slot floor 1. By-ear result (Chris, same day): **only 1–4 bits are audible at this chain
  position** — everything above is imperceptible — so the default ladder is **4·3·2·1**
  (superseded defaults 12·8·6·4 / 12·8·4·1 migrate forward one-time when never
  hand-assigned; the slot store is versioned `{v: 2}` — v2 force-reset the bits column since
  every pre-floor-drop value, hand-assigned included, was chosen against a broken range).
  The instrument editor's bits knob followed (same day): floor 1, and the linear 4..16 sweep
  replaced by a discrete ladder `16·12·8·6·5·4·3·2·1` so the travel lives in the audible
  band (InstrumentEditor BITS_LADDER; voiceBitDepth floors 1; `.pti` export clamps back to
  the Tracker hardware's 4). If more gradation is ever wanted in the audible band, the
  lever is sample-RATE reduction (decimation), not more bit values.
- **Scrub / chop / smear** (added same day, Chris picked them from the mangling-ideas list) —
  three trigger-time punch columns, all diced/applied per trigger:
  - **scrub** (0–100, defaults 25·50·75·100): each hit fires from a random start point up to
    N% into the voice's trim window. One roll per event (chords scrub coherently; arp tones
    roll per tone). `min(start, end − 0.001)` clamp keeps a sliver of sample.
  - **chop** (0–100 % of step, defaults 5·15·30·60): replaces the voice's envelope wholesale
    with a snappy synthetic gate (attack 1.5ms / release 20ms, hold = N% × step) — drums
    included, so everything masked turns staccato. 0 = bare click (broken range on purpose).
  - **smear** (timing jitter, ±(N% × 2 steps) per trigger) — REMOVED same day: Chris found
    no real musical use ("cant get any real musical use out of the smear controls").
    Replaced by **sat** (0–100, defaults 30·50·75·100): saturation-drive punch into the
    per-voice tanh stage (crushes past 50), `max(voice drive, slot drive)` — same
    only-adds-dirt rule as bits. New notes only.
  Latch state refactored to a generic `latched: Record<LatchedEffect, index|null>` +
  `punchSlot/activeSlot` (the per-effect function pairs were stamped out 6× and growing);
  the panel's latch columns are data-driven off `LATCH_COLUMNS`.
- **Reverb + delay sends** (added same day) — two more latching slot columns (verb · delay),
  absolute send positions 0–100 (defaults 25 · 50 · 75 · 100 both). Ride the same rAF
  `setTrackFiltersBulk` path as the filter punch, overriding the voice-sourced
  reverbSend/delaySend for masked tracks — throws already-ringing voices into the bus,
  self-restores on release. Non-voice (external MIDI) rows carry the value harmlessly (no
  native voices to send).
- **Gestures:** repeat slots hold-to-punch (pointerdown/up — same momentary catch-and-stick
  as `r`; a keyboard-armed length lights any slot with a matching value). Tune/filter slots
  latch (click on, click same slot off) — a mouse can only hold one thing and combining
  punches is the point. Rev is a plain latch.
- **Track mask row.** 16 even pads (number + truncated `sourceLabel`), fixed at 16 so the row
  reads as hardware channels; rows beyond the track count render disabled. Empty mask = ALL
  (toggling the last track off falls back to ALL, never silence); while empty, every pad
  lights dimmed so the effective selection is always visible. Mask feeds the existing
  `isTrackMasked` read in the repeat path AND the three new FX.
- **Reverse** — latching toggle; at dispatch, masked tracks' triggers emit `loopMode: 4`
  (reverse one-shot) in both the standard and arp branches. The synthetic loop-gate envelope
  still keys off the voice's authored loop code, which is harmless (env just bounds the rev
  one-shot to the gate as it would the loop).
- **Tune** — slot semitone offsets, −12..+12 (int). Multiplies `pick.pitch` (playback-rate
  ratio) by `2^(semis/12)` at dispatch for masked tracks; new notes only, ringing tails
  unaffected (hardware semantics). Not applied to the chord-revoice re-pitch path (voicing
  macro) — a revoiced ringing chord keeps its punch pitch; edge case, revisit if audible.
- **Filter** — slot values are ABSOLUTE cutoff positions 0–100 (an engaged slot replaces
  masked tracks' cutoff norm outright — predictable across tracks with different knob
  positions; the initial offset-knob version was replaced same day with the slot rework).
  Applied inside the rAF `setTrackFiltersBulk` push, so it bends already-ringing voices
  continuously and self-restores the knob value when the slot releases. The punched value is
  the base the Rust LFO swings around, so LFO-modulated cutoffs punch cleanly.
- **Punch-edge rule for the new FX:** flush-and-redispatch is only side-effect-safe over
  *replay* ticks (they never advanced mutation counters). So reverse + mask toggles fire the
  edge handler ONLY while a repeat is engaged (the repeat+reverse combo gets immediacy);
  otherwise they ride the next scheduled tick (~250ms horizon worst case). Tune/filter never
  fire edges — continuous sweeps, the horizon is imperceptible mid-gesture (filter is
  immediate anyway via the live path).
- **No badge.** The P1 bottom-left `REPEAT n` badge was removed with the slot rework (Chris's
  call) — the tab itself is the state surface. Latched FX are invisible outside the tab;
  bring an indicator back only if that bites in use.
- Perform FX are native-voice only: MIDI-out rows get no reverse/tune/filter (same boundary
  as gain/pan). Metronome/count-in unaffected (not track triggers).

## Open questions (resolve in build)

1. Repeat length set: mirror hardware (16·8·4·2·1·1/2·1/4·1/8·1/16) or trim to the musically
   used subset? Start with the full ladder — it's just a divisor table.
2. Does the repeat window capture from the engage-boundary backwards (loop the LAST N steps)
   or forwards (loop the NEXT N)? Hardware loops the window ending at engage. Start there.
3. Filter punch offset curve: linear offset on the 0..1 cutoff norm vs musical (log). Start
   linear, tune by ear.
