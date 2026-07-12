# Loop / resample view (designed 2026-07-07 · P1 landed 2026-07-07)

Chris's eurorack workflow, in the box: sources → Bluebox mixer → send row → modules split
between **noise and loops** → parallel returns. Sequence's version: the mix becomes source
material again — capture what the sequencer just played as bar-locked loops, manipulate
them, and (eventually) save them back into the samples library as voices. The recursive
move: sequence → capture → mangle → save → re-sequence.

## Topology decisions (from the design conversation, 2026-07-07)

- **Output-only, like the Bluebox.** The capture ring taps the post-master mix BEFORE loop
  playback injects, so loops can never re-capture themselves. Returns are parallel layers
  into the mix. (Chris: "everything comes back through it, but it's only for output.")
- **Retroactive, bar-quantized capture.** The audio thread always writes a 32s post-master
  ring indexed by absolute engine frame. "Capture 4 bars" grabs the four bars you just
  HEARD (ending at the newest rendered bar boundary) — catch-and-stick, same philosophy as
  freeze and the perform repeat.
- **Phase-locked playback.** The loop plays `(frame − end) % len` from the capture end, so
  the punch is seamless: the loop continues the mix in bar phase and only becomes audible
  as a layer when the pattern changes/mutes underneath. Loops land in recordings (injection
  is before the recorder taps).
- **Session-only.** Loops die on close/stream-reopen like perform state; save-to-library
  (P4) is the permanence story. Two units eventually (LOOP + NOISE characters); P1 ships
  one.

## Build increments

- **P1 — one unit, LANDED 2026-07-07.** Engine: `LOOP_RING_SECONDS = 32` ring + loop buffer
  (callback-local, allocated at stream build; capture copy is a ≤2-segment memcpy),
  `MixerCommand::LoopCapture{start_frame,end_frame}/LoopStop/LoopGain`, injection to main
  pair 0/1 post-master pre-recorder, gen-guarded like the engine clock. Panic drops the
  loop. JS: `src/audio/loops.ts` (bar anchor fed from the dispatcher's bar commit;
  `captureBars(n)` walks the anchor back to rendered audio and computes the span;
  session-singleton UI state). UI: LOOPS tab (`LoopsPanel.tsx`) — capture pads 1/2/4/8
  bars, STOP, LEVEL knob (0..1.5 return gain).
- **P2 — manipulation layer, LANDED 2026-07-07 (Morphagene + ADDAC 112 blend, Chris's
  reference points).** Engine: the P1 direct read became a playhead + 4-slot grain
  processor. Two regimes: **TAPE** (size ≥ 0.98) = thru-zero vari-speed head (−4..+4,
  pitch follows, |speed|<0.02 = stopped tape = silence; exactly 1.0 reproduces P1's
  bar-locked phase) · **GRAIN** (size < 0.98) = playhead crawls at speed, parabolic-window
  grains (no trig on the hot path) spawn on a countdown at playhead+scan, each reading at
  rate=speed (thru-zero pitch; at stopped speed grains read native pitch — the frozen
  drone). Morph = overlap 1..4 voices (1/√n gain comp) + position spray past 0.5. Params
  via `MixerCommand::LoopParams`, STICKY across captures (recapture under a mangle keeps
  the mangle); JS re-syncs its param state on every capture (webview reload vs engine
  memory). Knobs (reworked same session on Chris's feedback): SPEED quantized to the OCTAVE LADDER
  ±(1/4·1/2·1·2·4)+stop — musically coherent pitch AND bar-coherent loop passes (a 1/2x
  pass = exactly 2 bars) · SIZE (tape → 20ms..1.8s exp) · SCAN · GRAINS (explicit
  concurrent voices 1..8, steal-oldest) · RATE — dual-mode via a ○/● SYNC toggle
  under the knob (Chris's call): CLOCKED walks bar divisions 1/1..1/32 with spawns anchored
  ON the capture's bar grid (engine: absolute next-spawn frame vs loop_anchor, JS converts
  division→frames at push; tempo changes re-sync on next capture) · FREE is the continuous
  0.5..60Hz sweep; rate deviation jitters either (humanized rolls when synced). Gain comp =
  1/√(dur/interval) ·
  RANDOM (start-point randomness, Chris's reframe of SCAN: 0 = grains at the playhead,
  1 = uniformly anywhere — ±half-loop depth, wrap makes it truly uniform; absorbed SPRAY,
  which was the same idea at ±25%) · LEVEL, all value-labeled.
  **Per-control DEVIATION (ADDAC 112 concept, Chris's ask):** SIZE/SPEED/RATE knobs carry a
  deviation 0..1 set by SHIFT-DRAG on the knob (±nn readout under the value; RANDOM is
  position's deviation). Each grain rolls its own value: size ×4^±dev (grain-length
  octaves), pitch QUANTIZED to fifths+octaves (interval ladder 0/±7/±12/±19/±24 semis; dev opens the ladder, uniform pick per grain — musical scatter, not detune haze; was continuous ×2^±2dev), spawn interval ±0.9·dev. Fully deviated
  every grain is its own event — per-control generative output.
  **PITCH knob / timestretch (Chris: "introduce timestretching artifacts"):** grain pitch
  decoupled from speed — PITCH is the same octave ladder with CENTER = FOLLOW (tape-chained,
  default). Fixed pitch + slow/stopped/reversed SPEED = granular timestretch; the periodic
  grain windows re-reading material ARE the artifact (S950/Paulstretch flavor — tune with
  SIZE/RATE, small+slow = maximum flutter). Engine sentinel: pitch 0.0 = follow. pitchDev
  moved to the PITCH knob.
  **MIX correction (Chris, post-P4): NOT a crossfade — independent layer levels.** The tape
  loop and grain cloud are two modules over the same capture, each with its own LEVEL knob
  (0..150) in its group; both can be up, either silent. Defaults loop 100 / grains 0 (punch
  stays clean). The master LEVEL knob was retired (engine LoopGain stays at 1.0, still in
  the bounce path). PITCH also moved under GRANULAR (it only drives grain read rate — the
  tape layer follows SPEED alone). Groups: loop = speed·level · granular =
  pitch·size·grains·rate(+sync)·random·level.
  **LOOP-layer pitch lock (Chris: "lock pitch and adjust speed"):** ○/● LOCK toggle under
  SPEED. On = the tape layer runs a two-head OLA stretcher (85ms triangular windows, 50%
  hop, heads read at native pitch from the vari-speed playhead; windows sum to unity, near-
  transparent at 1x) — SPEED becomes pure time for the loop: timestretch, reverse-at-pitch,
  frozen slice at the stop detent (deliberately NOT silent, unlike tape-stop). Off = tape
  physics. Independent of the grain layer's PITCH machinery.
  **LFO-addressable (Chris's ask):** 7 looper knobs are global LFO destinations
  (loopSpeed/Pitch/Size/Random/Rate/Level/GrainLevel) — click-to-route in LFO-select mode,
  visual swing, hand-override, all via the standard machinery. Modulation rides KNOB space
  and is pushed effective-value at ~30Hz from a driver in loops.ts (change-gated; idle cost
  ≈ nil), so speed/pitch stay LADDER-QUANTIZED after modulation — an LFO on speed steps
  octaves instead of smearing.
  **SAVE = one musical pass at current speed (Chris's catch):** frames = bars/|speed| ×
  barFrames — a 1/16x stretch of 1 bar prints 16 bars (the whole unfolding); 2x prints half;
  stop falls back to source length. Filename bar-count reflects the PRINTED length.
  **Viz matches the params view** (Chris's ask): 192px height, same framing/fill brightness,
  playhead with direction caret (from the speed sign), side-by-side anatomy (waveform left,
  controls right).
  **Visualization** (Chris asked mid-build): capture computes 512-col min/max peaks into
  lock-free statics (subsampled, ≤64 reads/col, on the audio thread at capture time only);
  playhead + per-grain (pos, window level) published per block via atomics;
  `audio_loop_viz` (~30Hz poll while the tab is open, imperative canvas — no React
  re-render) + `audio_loop_peaks` (fetched on version change). Waveform uses the
  zero-anchored fill (same glitch family as Waveform.tsx). Grain markers: width from SIZE,
  brightness from live window level — MORPH visibly becomes a cloud.
- **P2 follow-ups:** NOISE unit (second capture unit ground through degrade —
  bits/sat/feedback), per-grain direction probability (ADDAC), SOS overdub (Morphagene).
- **P3 — per-track loop sends.** Dedicated send knobs choosing what feeds each capture
  unit, independent of the mangler send — the faithful Bluebox send topology.
- **P4 — save-to-library, LANDED 2026-07-07.** SAVE bounces the unit's OUTPUT (post-mangle,
  post-gain — what you hear; neutral knobs = raw capture, so one button covers both) via the
  recorder-worker pattern: `MixerCommand::LoopBounce{producer, frames, align_frames, stop}` —
  the audio thread taps the unit's out per frame, waits for the next bar-grid point so the
  file RE-LOOPS cleanly, self-stops after exactly `bars × barFrames` frames. Worker =
  `spawn_recorder_worker` label "loop" (32f stereo WAV, `recorder:finalized` event;
  nativeRecorder's generic toast excludes the label — loops.ts owns the toast + triggers
  `scanAndLoadUserSamples` so the WAV registers as a voice immediately). Path:
  `<samples dir>/textures/<stem>/<stem>.wav` (stem = `loop-<bpm>bpm-<bars>bar-<stamp>`) — each
  loop gets its OWN kit folder under `textures/` because the scanner only descends the fixed
  CATEGORIES list and treats loose top-level files as non-kits (a bare `loops/` folder is
  never scanned). `textures/` → `texture` role, so it registers as a rootless texture voice.
  bpm derives from the CAPTURED
  bar length (the material's actual tempo, Chris's ask). Teardown safety: the in-flight
  bounce's stop flag is registered in a global (`loop_bounce_teardown`) fired by
  `stop_recorders_for_stream_teardown`; LoopStop/Panic/replacement bounces finalize the
  take in flight. UI: SAVE pad under STOP (pulses `···` while bouncing — takes wait ≤1 bar
  for alignment + N bars to render). Still open from P4: perform-tab capture punch,
  Ghost-triggered capture (autonomous resampling).

## NOISE unit (P1 landed 2026-07-07 — Mörser-shaped, own tab)

Chris's DE references drove the design: the **Djupviks Mörser** (stereo WASP filter, clocked
digital noise normalled to audio-in AND cutoff-CV, always-on distortion, self-sounding) and
the **Spektrum** (signal-as-clock switched-cap filter — parked as the v2 twist: the clock
source selector grows a SIGNAL mode driven by zero-crossing rate, incl. cross-clocking from
Loop A). Set-and-forget was the requirement: all flow processing, no accumulation —
equilibrium textures, unlike the rejected re-crush idea.

- **Chain:** input → [+ clocked S&H digital noise] → stereo Chamberlin SVF with tanh INSIDE
  the resonance loop (WASP/CMOS grit; per-channel damping = res ± width for stereo
  instability; LP/BP tap) → always-on tanh distortion (DE philosophy, no blend) → own
  return level (0 = bypass).
- **Clocked noise, two destinations** like the hardware: audio (`noise`) and cutoff
  (`cv`, ±2 octaves at full — the morse/rainforest maker). Clock = bar divisions
  (grid-anchored, chatter locks to the groove) or free Hz via the same sync-toggle pattern
  as the grain rate.
- **INPUT routing (Chris's flow: "loop → manipulate → add noise → export"):** stepped
  source — **LOOP** (default; true insert: Loop A routes THROUGH the chain, its direct
  injection suppressed, wet-only; the loop SAVE bounce prints the POST-NOISE signal via the
  relocated bounce tap on the send scratch) · **CAPT** (own retroactive bar-quantized
  capture off the shared ring + vari-speed head — a second bed) · **OFF** (self-sounding:
  noise alone through the filter). Level 0 = implicit bypass (loop injects direct again).
- Engine: `MixerCommand::NoiseCapture/NoiseStop/NoiseParams`; `loop_send_l/r` block scratch
  carries loop→noise→bounce; Panic zeroes level + SVF state (a self-oscillating filter is a
  runaway source). JS: `src/audio/noise.ts` + `NoisePanel.tsx` (FX-style groups: input /
  filter / noise / clock / sends / out), `noise` ScreenMode.
- **Character pass (same day — Chris: "doesn't really feel like the Mörser"):** the gap was
  level-sensitivity + asymmetry + noise hardness. Added: **DRIVE** (1–24x input gain INTO
  the filter — pushing it is the sound; output stage compensates so LEVEL stays a fader) ·
  **asymmetric in-loop nonlinearity** (`tanh(v + 0.14v²)` — even harmonics, mis-biased
  CMOS) · **resonance SQUELCH** (damping rises with bp level — resonance chokes under load
  instead of ringing clean) · **hard LFSR ±1 bitstream** noise (was smoothed random; cv
  jitter stays 4-step graded) · **free clock extended to AUDIO RATE** (0.5Hz–8kHz — slow =
  stepped CV blips, audio-rate = pitched digital hash, the Mörser noise color; default
  240Hz).
- **SAVE prints the chain's TOTAL output in every routing** (fixed after Chris's
  silent-file report): inserted → noise REPLACES the loop in the bounce scratch; capt/off →
  noise ADDS on top of the loop's direct out. Previously capt/off setups weren't taped at
  all. Also same-session: ping LEDs (L/R peak-hold atomics, ~100ms persistence, 30Hz
  imperative poll — the Mörser tuning light), edge-ping noise injection (transitions ping
  the resonance — the morse mechanic; held-DC was the miss), 2x-oversampled SVF (high
  cutoff no longer collapses into a Nyquist limit cycle), DC-latch fix (leaky lp + DC
  blocker — the asymmetric clipper's DC was pinning the unit silent).
- **Unit → FX-bus sends (Chris: "can these feed INTO the FX loop?"):** both units carry
  fx/verb/dly send knobs into the mangler/reverb/delay buses. The units run downstream of
  the FX section, so the sends are ONE BLOCK DEFERRED (carry buffers seeded into the bus
  inputs at the next block top — ~10ms, inaudible on send material). Pre-routing tap: the
  loop's sends fire even when inserted into NOISE. Deliberate consequence: unit FX tails
  re-enter the pre-master mix and therefore future captures — generational resampling
  through the buses.
- **SIGNAL clock mode, LANDED (Spektrum-shaped — the v2 twist Chris asked to hear):**
  clock modes are sync · free · **signal**: in signal, ticks derive from a clock-source's
  ZERO CROSSINGS through a divider ladder (/1../64) — the clock rate IS the material's
  pitch/brightness (a held bass = pings pitch-locked to its fundamental; bright material =
  hash; SILENCE STOPS THE CLOCK, the texture wakes with the music). Hysteresis SENS knob
  keeps the noise floor from clocking it / gates the clock to loud material. Sources:
  SELF (its own input — true Spektrum self-reference) · LOOP A (default — two captures
  intermodulating, the ecosystem patch) · MIX (the whole sequencer is the clock). Engine:
  sign-state detector with threshold + divider counter, sharing the timer path's tick body.
- **UI pass (final-review round, mirrors the LOOPS anatomy):** output **scope** on the
  left (scrolling min/max of the PRE-level saturator out, ~1/2s window — lock-free ring
  `NOISE_SCOPE`, `audio_noise_scope`, 30Hz imperative poll; keeps scrolling to flat when
  bypassed so it never freezes stale content) · **capture stack** (1/2/4/8/stop) stacked
  vertically riding the scope's edge like the loop view, dimmed unless CAPT · **CLOCK is
  its own group**: one flat five-way column (sync · free · self · loop · mix — the signal
  sources fold signal mode in, so every clock state is one press from anywhere; replaced
  the blind ○-cycle + revealed sub-group) with clock + sens knobs stacked beside it
  (`setNoiseClockMode` is timer-only; `setNoiseClockSrc` enters signal mode).
- **Open (NOISE):** LFO addressability, its own save path when in CAPT mode.

## P1 caveats (accepted, revisit if they bite)

- **Metronome bleeds into captures** when it's on (it plays into the post-master main
  pair). Obvious when it happens; dedicated exclusion later if annoying.
- **Tempo changes unlock phase** — the loop is frames, not bars; a tempo move after
  capture drifts it against the grid. Rate-follow is a P2+ decision.
- **Stream reopen drops the loop** (unit state is callback-local; the device-rate watch
  reopening mid-hold kills it). JS mirrors on panic only — a reopen can leave the tab
  showing a loop that died; punch STOP or recapture.
- **Multi-out**: capture taps channels 0/1 (which are pre-master in multi-out mode) and
  injects there — semantics are "main pair" not "the DAW mix". Fine for the home stereo
  rig; revisit for the MOTU setup if it matters.
- Capture while transport stopped uses the last bar anchor — grabs the ring tail, which is
  usually what you want (the thing that just rang out).
