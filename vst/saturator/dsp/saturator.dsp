// Saturator — drive curve morph + Blades-filter + PurPLL micro-loop glitch.
//
// Signal flow:
//   stereo glitch (mono-summed trigger, per-channel crossfade)
//     → tilt EQ → +bias offset → drive curve morph
//     → resonant filter → DC blocker → outer dry/wet
//
// Glitch is FIRST so threshold reads clean dynamics, not a square wave.
// The trigger detection AND the loop buffer are mono-summed across L+R,
// so both channels share ONE loop — no chance of L and R running
// independent loops out of sync. After glitch, each channel processes
// through its own distortion chain (drive/filter are stateful per
// channel, so stereo character is preserved in the downstream sculpting).
//
// Drive (curve morph):
//   One knob morphs CHARACTER and AMOUNT together:
//     drive ≈ 0.00 – 0.30  : pure tanh        (analog warmth, soft compression)
//     drive ≈ 0.30 – 0.50  : tanh → hard clip (crossfade)
//     drive ≈ 0.50 – 0.65  : pure hard clip   (square-ish, odd harmonics)
//     drive ≈ 0.65 – 0.85  : hard clip → fold (crossfade)
//     drive ≈ 0.85 – 1.00  : pure wavefold    (Buchla-style destruction)
//   Region weights are linear ramps that always sum to 1.0, so the morph
//   is continuous and level is roughly preserved across the curve.
//
//   `tilt` shapes the spectrum hitting the curve. Most of what we hear as
//   "analog" character comes from WHICH frequencies get distorted, not the
//   curve shape itself — tilt < 0 makes lows hit the curve harder (warm,
//   woolly fuzz), tilt > 0 sends highs into the curve (fizzy, bright).
//
//   `bias` adds DC offset before the curve so the positive and negative
//   arms see different magnitudes. Symmetric curves only generate odd
//   harmonics; bias breaks the symmetry and adds EVEN harmonics (2nd, 4th,
//   …) — that's where "tube warmth" lives. At larger bias values one half
//   of the waveform pegs against the curve's limit and the result is
//   half-wave-rectification / diode-fuzz territory. A DC blocker after the
//   curve cleans up the offset so it doesn't show up at the output.
//
// Filter (Blades-inspired):
//   `tone` shifts filter TYPE and CENTER together:
//     0   → LP @ ~500 Hz   (warm, dark)
//     0.5 → BP @ ~1.75 kHz (vocal/midrange notch)
//     1   → HP @ ~3 kHz    (bright, thin)
//   `body` controls resonance Q AND envelope-follower cutoff-modulation
//   depth AND the filter's own dry/wet mix — all from one knob. At body=0
//   the filter is fully bypassed (zero coloration). At body=1 the filter
//   self-oscillates and cutoff swings ±3 kHz with input envelope — the
//   Blades-flavor "alive, breathing" thing where resonance screams on
//   transients. The follower reads the ALREADY-saturated signal so
//   harmonics in the distorted tone push cutoff up and ring the filter
//   at those frequencies.
//
// Glitch (PurPLL-inspired) — one-loop-at-a-time freeze, FRONT of chain:
//   Pre-first-trigger: live audio passes through.
//   First rising edge: instantly switch output to a windowSamples-delayed
//   read of the input — perceptually a "jump back in time" by windowSamples,
//   then continuous playback of recent live audio.
//   At windowSamples after the trigger: that delayed playback seamlessly
//   becomes a frozen loop (the buffer has by then been filled with the
//   live audio captured during the post-trigger windowSamples). Loop holds
//   forever — threshold dropping below does NOT end it.
//   Next rising edge: the loop CONTINUES playing while the buffer is
//   re-filled with new live audio underneath. After windowSamples, hard-
//   cut to the new loop. The user always hears exactly one loop at a time;
//   nothing else can come through except as part of the next loop.
//   `glitch` is a binary checkbox (off/on). At off the stage is fully
//   bypassed AND the loop state is reset (everTriggered → 0), so the
//   next time it's switched on it waits for a fresh trigger rather than
//   resuming the previous loop. A 5 ms crossfade prevents toggle clicks.
//
//   `auto` engages clock-driven on/off modulation: a Pam's-Workout-style
//   divider running off `bpm` (hardcoded 120, host-driven once wired into
//   JUCE) toggles the glitch binary at `division`-controlled intervals.
//   The threshold detector still drives the loop captures — the clock
//   just opens and closes the "armed" window. If the source crosses
//   threshold constantly the clock becomes a rhythmic gate. If the source
//   has sparse peaks and the division is an odd value (/13, x7, etc.)
//   the peak-to-window alignment is irregular and the resulting glitches
//   are unpredictable. Hard cuts on every clock transition, no smoothing
//   — the loop dies instantly when the clock goes low. See
//   [[feedback-intersecting-systems]].
//   `window` sets loop length AND the inter-trigger crossfade gap: ~8 ms
//   = 125 Hz pitched buzz, ~60 ms ≈ 17 Hz distinct stutter, 120 ms ≈ 8 Hz
//   slow repeat. Threshold reads clean input audio (pre-distortion), so
//   it tracks real input dynamics rather than the saturator's brick-wall
//   output — set threshold relative to your source level, not what comes
//   out the other end.
//
// Validate in faustide.grame.fr: paste this whole file, hit Run.

declare name        "Saturator";
declare description "Drive morph + Blades-style filter + PurPLL micro-loop glitch";
declare author      "newspeech";
declare options     "[ftz:2]";

import("stdfaust.lib");

// =============================================================================
// CONTROLS — grouped by effect (LOOP → DESTROY → FILTER → OUT).
// Within each group: toggles first, mix-like controls last. UI hierarchy
// uses Faust's slash-path slider naming, and the [N] prefix on each path
// segment forces explicit ordering (otherwise Faust orders by process-
// graph traversal, which puts whichever group is touched first in the
// signal flow at the top — not what we want here).
// =============================================================================

// --- LOOP (PurPLL micro-loop, threshold + auto-clock modes) -----------
//   Master toggle first, then threshold-mode controls, then auto-mode
//   controls. `bpm` is [hidden] so the user never sees it — JUCE will
//   drive it from host transport via getPlayHead() once wired.
//   `divIdx`: bipolar Pam's-Workout-style ratio (-15..15, 0 = unity).
glitchCheckbox = checkbox("[0]LOOP/[0]glitch");
threshold      = hslider("[0]LOOP/[1]threshold [unit:dB]", -20.0, -60.0, 0.0, 0.1)
               : ba.db2linear : si.smoo;
chance         = hslider("[0]LOOP/[2]chance", 1.0, 0.0, 1.0, 0.001) : si.smoo;
windowMs       = hslider("[0]LOOP/[3]window [unit:ms]", 60.0, 1.0, 120.0, 0.1) : si.smoo;
auto           = checkbox("[0]LOOP/[4]auto");
divIdx         = hslider("[0]LOOP/[5]division", 0.0, -15.0, 15.0, 1.0);
bpm            = hslider("[0]LOOP/[6]bpm[hidden:1]", 120.0, 60.0, 240.0, 0.1) : si.smoo;

// --- DESTROY (pre-EQ + DC bias + drive curve morph) ------------------
tilt           = hslider("[1]DESTROY/[0]tilt",  0.0, -1.0, 1.0, 0.001) : si.smoo;
bias           = hslider("[1]DESTROY/[1]bias",  0.0, -1.0, 1.0, 0.001) : si.smoo;
drive          = hslider("[1]DESTROY/[2]drive", 0.30, 0.0, 1.0, 0.001) : si.smoo;

// --- FILTER (Blades-style) -------------------------------------------
//   `body` doubles as the filter's own dry/wet (at 0 = bypassed), so it
//   acts as the mix-like control and lives at the bottom of this group.
tone           = hslider("[2]FILTER/[0]tone", 0.5, 0.0, 1.0, 0.001) : si.smoo;
body           = hslider("[2]FILTER/[1]body", 0.0, 0.0, 1.0, 0.001) : si.smoo;

// --- OUT (plugin output) ---------------------------------------------
//   `output` trims post-saturator gain (the drive curve can easily push
//   the signal hot — pull this down to compensate). `mix` is the
//   plugin's outer dry/wet, last per the convention.
trim           = hslider("[3]OUT/[0]output [unit:dB]", -6.0, -24.0, 12.0, 0.1)
               : ba.db2linear : si.smoo;
mix            = hslider("[3]OUT/[1]mix", 1.0, 0.0, 1.0, 0.001) : si.smoo;

// Bias slider ±1 maps to ±0.5 DC offset at unit signal scale. ±1 fully
// rectifies one half of a unit-amplitude waveform against the curve.
biasOffset = bias * 0.5;

// =============================================================================
// CLOCK — Pam's-style divider/multiplier driving auto-mode glitch
// =============================================================================
// A free-running phase counter wraps at samplesPerCycle. The square wave is
// 1 for the first half of each cycle, 0 for the second half — that's the
// "on/off" envelope that gates the glitch effect when auto mode is engaged.
// Hard cuts (no smoothing) on each transition, per the broken aesthetic.
//
// divIdx → cycleBeats (bipolar):
//   idx < 0  : cycleBeats = 1 - idx        (slower: -1→2beats=/2, -15→16beats=/16)
//   idx == 0 : cycleBeats = 1              (unity)
//   idx > 0  : cycleBeats = 1/(1 + idx)    (faster: 1→0.5beats=x2, 15→0.0625=x16)
// "Wildly off beat" lives at the extremes — /13, /11, x7, x13, etc. don't
// align with anything an input source is likely doing.

cycleBeats = ba.if(divIdx < 0.0,
                    1.0 - divIdx,
                    ba.if(divIdx > 0.0,
                          1.0 / (1.0 + divIdx),
                          1.0));

samplesPerCycle = cycleBeats * 60.0 / bpm * ma.SR;

wrapCycle = _ <: ba.if(_ >= samplesPerCycle, _ - samplesPerCycle, _);
clockPhase = (+(1.0) : wrapCycle) ~ _;

// Square wave: 1 for the first half of each cycle, 0 for the second.
clockSquare = clockPhase < (samplesPerCycle * 0.5);

// glitch resolution:
//   auto off: manual mode — smoothed checkbox value (5ms click-free crossfade).
//   auto on:  clock mode — raw checkbox AND-ed with clockSquare. Hard cuts.
// armActive and the dryWet crossfade downstream both read `glitch`, so the
// auto path's hard cuts propagate to both the latch reset and the audio.
glitchManual = glitchCheckbox : si.smoo;
glitchAuto   = glitchCheckbox * clockSquare;
glitch       = auto * glitchAuto + (1.0 - auto) * glitchManual;

// =============================================================================
// REGION WEIGHTS — overlapping ramps on `drive`, always sum to 1.0
// =============================================================================
clip01 = max(0.0) : min(1.0);

// Tanh fades out 0.30 → 0.50.
wTanh = 1.0 - ((drive - 0.30) / 0.20 : clip01);

// Hard clip fades in 0.30 → 0.50, fades out 0.65 → 0.85.
wClip = ((drive - 0.30) / 0.20 : clip01)
      - ((drive - 0.65) / 0.20 : clip01);

// Fold fades in 0.65 → 0.85.
wFold = (drive - 0.65) / 0.20 : clip01;

// =============================================================================
// DRIVE GAIN — 0 dB at drive=0, +30 dB at drive=1
// =============================================================================
driveGain = pow(10.0, drive * 1.5);

// =============================================================================
// PRE-EMPHASIS TILT EQ — 1st-order shelf complement around 700 Hz.
// At tilt=0, lowGain = highGain = 1 → flat magnitude pass-through.
// =============================================================================
lowGain  = pow(2.0, 0.0 - tilt);
highGain = pow(2.0, tilt);

tiltEQ = _ <: (fi.lowpass(1, 700)  : *(lowGain)),
              (fi.highpass(1, 700) : *(highGain))
           :> _;

// =============================================================================
// NONLINEARITIES — signal-block style to avoid phantom-input issues
// =============================================================================
softTanh = ma.tanh;
hardClip = max(-1.0) : min(1.0);

// Triangle wavefold around ±1. Four passes handle signals up to ±9 cleanly;
// beyond that the residual sticks at the boundary (fold blends into clip at
// extreme drive — fine for the destruction end of the range).
fold1 = _ <: ba.if(_ > 1.0,
                    2.0 - _,
                    ba.if(_ < (0.0 - 1.0), (0.0 - 2.0) - _, _));

waveFold = fold1 : fold1 : fold1 : fold1;

// =============================================================================
// DRIVE STAGE — push input hot, run through all 3 curves, crossfade by region
// =============================================================================
driveStage = *(driveGain) <:
    (softTanh : *(wTanh)),
    (hardClip : *(wClip)),
    (waveFold : *(wFold))
  :> _;

// =============================================================================
// FILTER STAGE — Blades-style morphing resonant filter
// =============================================================================
// `tone` is reused to shift both the morph weights and the cutoff center,
// so one knob does filter-type AND voicing. `body` does triple duty:
// Q + envelope-follower depth + filter dry/wet — at body=0 the filter is
// fully bypassed (no coloration); at body=1 it self-oscillates and cutoff
// chases the input envelope.

// Cutoff center shifts with tone (500 Hz LP → 3 kHz HP).
baseCutoff = 500.0 + tone * 2500.0;

// Q is exponential so most of the knob's range is musical and the top end
// reaches genuine self-oscillation ([[feedback-broken-ranges]]).
filterQ = pow(2.0, body * 7.0);   // Q ∈ [1, 128]

// Envelope-follower max depth scales linearly with body (0 → ±3 kHz swing).
envDepth = body * 3000.0;

// Cutoff signal: amp-follower(input) → scaled → offset → clamped.
// Attack 10 ms / release 200 ms gives a musical breathing follower —
// fast enough to catch transients, slow enough to ring out.
makeCutoff = an.amp_follower_ar(0.01, 0.2)
           : *(envDepth)
           : +(baseCutoff)
           : max(80.0)
           : min(18000.0);

// Morph weights — always sum to 1 across tone ∈ [0, 1].
wLP = (1.0 - 2.0 * tone) : clip01;
wBP = 1.0 - abs(2.0 * tone - 1.0);
wHP = (2.0 * tone - 1.0) : clip01;

// Each named arg used once → no phantom inputs.
applyLPw(fc, x) = x : fi.resonlp(fc, filterQ, 1.0) : *(wLP);
applyBPw(fc, x) = x : fi.resonbp(fc, filterQ, 1.0) : *(wBP);
applyHPw(fc, x) = x : fi.resonhp(fc, filterQ, 1.0) : *(wHP);

// Fork: 1 → (cutoff, signal); route to feed (fc, x) into each of 3 filters
// that share the cutoff; sum the weighted outputs.
filterCore = _ <: makeCutoff, _
           : route(2, 6,
               (1,1), (1,3), (1,5),
               (2,2), (2,4), (2,6))
           : applyLPw, applyBPw, applyHPw
           :> _;

// Body also acts as the filter's own dry/wet — at body=0 the filter is
// fully bypassed (no static Q≈1 coloration). sqrt curve so even small
// body values give audible filter presence, while keeping true bypass
// at exactly 0. body=1 stays full wet + self-oscillation as today.
bodyWet = pow(body, 0.5);

filterStage = _ <: _, filterCore : *(1.0 - bodyWet), *(bodyWet) :> _;

// =============================================================================
// GLITCH STAGE — single-buffer freeze loop, exploits fdelay read/write offset
// =============================================================================
// Key insight: a feedback delay line ALREADY behaves like two buffers in
// one, because the read position is `windowSamples` BEHIND the write
// position. While the loop is active and gate=1, the buffer recirculates
// itself. When the next trigger fires:
//   • gate drops to 0 for windowSamples → WRITE switches to live audio,
//     overwriting the loop content from the front of the buffer forward.
//   • Meanwhile READ is still windowSamples behind, so the delay's OUTPUT
//     continues to play the previous loop content uninterrupted.
//   • After windowSamples, read catches up to the just-written live audio
//     and seamlessly transitions to the new loop. gate flips back to 1.
//
// The output hard-cut uses `everTriggered` (not gate) so the user hears
// the buffer's output the entire time after the first trigger — never
// the live signal except as part of a loop. Pre-trigger, output = live.

PLL_RING_MAX = 32768;  // ~170 ms at 192 kHz — covers 120 ms window everywhere
windowSamples = windowMs * 0.001 * ma.SR;
glitchInv     = 1.0 - glitch;

// glitch is a checkbox (binary 0/1) smoothed for click-free audio
// crossfade. armActive uses the smoothed mid-point (0.5) as the latch
// flip — keeps the loop alive through the ~5 ms crossfade window so the
// audible transition is the smoothed dryWet rather than an abrupt latch
// reset, while still resetting `everTriggered` once the checkbox is off.
armActive = glitch > 0.5;

// Monotonic sample counter — drives the capture-phase timer.
sampleClock = +(1.0) ~ _;

// Sample-and-hold (pattern from glitch.dsp): holds x at the moment trig=1.
sah(trig, x) = (trig * x + (1.0 - trig) * _) ~ _;

// 1-in 1-out: outputs 1 only on the sample where input transitions 0→1.
risingPulse = _ <: _, mem : - : >(0.0);

// 1-in 1-out: input audio → binary above-threshold signal (no smoothing).
aboveThreshBlock = an.amp_follower_ar(0.003, 0.05) : >(threshold);

// Loop combiner — gate=0 → live (delay fills), gate=1 → fb (recirculate).
loopCombine(fb, live, gate) = live * (1.0 - gate) + fb * gate;

// Feedback delay loop. (live, gate) → looped/delayed output.
loopedSignal = (loopCombine : de.fdelay(PLL_RING_MAX, windowSamples)) ~ _;

// Helper: elapsed samples since the held trigger moment.
elapsedSinceTrig(start) = sampleClock - start;

// Stereo glitch processor — 2-in 2-out. Threshold detection and the loop
// BUFFER are computed from a mono mix of L+R, so the two channels can
// never have independent triggers / out-of-sync loops. Each channel is
// then individually crossfaded between its live audio and the (mono)
// loop. This is the single point of state for the whole glitch effect.
glitchProcess(L, R) = glitchedL, glitchedR
with {
  // ---- Shared mono trigger state ----
  monoIn          = (L + R) * 0.5;
  // Threshold rising edge = "want to trigger". Actual fire is deferred
  // to the next zero-crossing of monoIn so the first captured sample is
  // ≈0 — this kills half of the handoff-seam discontinuity (the new-
  // content side) without restructuring the loop. The old-loop side is
  // still uncontrolled; the existing triangle envelope continues to
  // mask whatever residue is left. Inspired by Sanfilippo's
  // concatenative-granulation seam strategy (zero-crossing aligned
  // grain boundaries).
  wantTrigger     = monoIn : aboveThreshBlock : risingPulse;
  zcMono          = monoIn * monoIn' < 0.0;
  // pending: latched high by wantTrigger, cleared on zc. Feedback uses
  // 1-sample delay so `pending'` is the previous-sample latch state.
  pending         = (max(wantTrigger, _) * (1.0 - zcMono)) ~ _;
  rise            = max(wantTrigger, pending') * zcMono;
  // Only count rises when the stage is armed (glitch > 0); on disarm
  // (armActive→0) the sah's trig stays high with val=0, forcing
  // everTrig to 0 and resetting the loop state.
  riseArmed       = rise * armActive;
  // Per-trigger dice roll: uniform [0,1] sah'd on every armed rise.
  // hit=1 → latch fires, hit=0 → latch clears (an active loop dies
  // until the next hit). At chance=1.0 every roll wins → identical to
  // pre-chance behavior. At chance<1.0 some triggers materialize into
  // loops, others mute, producing stuttery dropouts proportional to
  // the input's trigger density.
  trigRand        = sah(riseArmed, (no.noise + 1.0) * 0.5);
  hit             = trigRand < chance;
  valArmed        = riseArmed * hit;
  everTrig        = sah(max(riseArmed, 1.0 - armActive), valArmed);
  elapsedFromTrig = sah(valArmed, sampleClock) : elapsedSinceTrig;
  capActive       = elapsedFromTrig : <(windowSamples);
  gate            = everTrig * (1.0 - capActive);
  // ---- Shared mono loop buffer ----
  loopedRaw       = loopedSignal(monoIn, gate);
  // ---- Loop-wrap windowing ----------------------------------------
  // The feedback delay's cycle period is windowSamples+1 (the extra +1
  // is from Faust's `~` 1-sample feedback latency). Two click sources:
  //   (a) Every cycle, the buffer reads transition from the last
  //       captured sample (live(T0+wS-1)) to a SINGLE orphan pre-trigger
  //       sample (live(T0-1)) before the next cycle's captured content
  //       starts — recurring every wS+1 samples.
  //   (b) On every NEW trigger, the buffer's read pointer crosses from
  //       OLD loop content to NEW captured content at t = T1+wS — one
  //       big content jump.
  //
  // Mask both with a triangular envelope synced so position=0 lands at
  // BOTH the per-cycle orphan AND the trigger-transition moment. The
  // offset is `elapsedFromTrig - windowSamples`: position=0 at t = T+wS
  // (first new-content sample), position=wS at t = T+2*wS (next orphan).
  // Envelope is then smoothed with a ~1 ms pole so the envelope's own
  // discontinuity at the trigger (when elapsedFromTrig itself jumps from
  // a large value to 0) spreads over a few ms instead of clicking.
  loopPeriod      = windowSamples + 1.0;
  // Wider ramp (20 ms) + 5 ms hold-at-zero zone around each wrap. The hold
  // zone gives the smoother time to actually settle to 0 at every click
  // (a single-sample 0 was leaking through past the smoother as ~0.1 of
  // the original click amplitude — that residue was the persistent crunch
  // at every handoff once the saturator downstream amplified it). Slow
  // ramps mean the smoother can stay fast (1 ms) without ever lagging
  // the ramp's descent toward zero.
  holdZeroSamples = min(0.005 * ma.SR, windowSamples * 0.1);
  loopFadeSamples = min(0.02 * ma.SR, (windowSamples - 2.0 * holdZeroSamples) / 2.0);
  posUnshifted    = elapsedFromTrig - windowSamples;
  position        = posUnshifted - floor(posUnshifted / loopPeriod) * loopPeriod;
  distFromEdge    = min(position, windowSamples - position);
  clampedDist     = max(0.0, distFromEdge - holdZeroSamples);
  loopEnvRaw      = max(0.0, min(1.0, clampedDist / loopFadeSamples));
  loopEnv         = loopEnvRaw : si.smooth(ba.tau2pole(0.001));
  looped          = loopedRaw * loopEnv;
  // ---- Per-channel crossfade: pre-trigger = own live, post = mono loop ----
  // si.smoo (~3ms) on everTrig masks the 1→0 click on miss-mute events
  // (loop output isn't at zc when a miss kills the latch mid-loop). The
  // 0→1 direction is already silent at the seam — loopEnv lands at ~0
  // around T+wS — so smoothing here doesn't soften the trigger attack.
  everTrigSmooth  = everTrig : si.smoo;
  stageL          = L * (1.0 - everTrigSmooth) + looped * everTrigSmooth;
  stageR          = R * (1.0 - everTrigSmooth) + looped * everTrigSmooth;
  // ---- Per-channel glitch knob wet/dry against own live audio ----
  glitchedL       = L * glitchInv + stageL * glitch;
  glitchedR       = R * glitchInv + stageR * glitch;
};

// =============================================================================
// DISTORTION CHAIN — per-channel post-glitch
//   tilt EQ → bias offset → drive stage → filter → DC blocker
// =============================================================================
distortionChain = tiltEQ : +(biasOffset) : driveStage : filterStage : fi.dcblocker;

// =============================================================================
// PROCESS — top-level plugin entry
//   1. Stereo glitch (shared mono trigger + loop) → (glitchedL, glitchedR)
//   2. Per-channel distortion chain (stateful drive/filter give back stereo)
//   3. Outer dry/wet (mix knob) against original input, then output trim
// =============================================================================
process(L, R) = outL, outR
with {
  glitchedLR = glitchProcess(L, R);
  glitchedL  = glitchedLR : (_, !);
  glitchedR  = glitchedLR : (!, _);
  satL = glitchedL : distortionChain;
  satR = glitchedR : distortionChain;
  outL = (L * (1.0 - mix) + satL * mix) * trim;
  outR = (R * (1.0 - mix) + satR * mix) * trim;
};
