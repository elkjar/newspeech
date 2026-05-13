// Glitch — Faust port of sequencer's glitch-machine.js (Phase 3 v1)
//
// 8-mode random glitch buffer. At each beat (driven by an internal BPM
// clock), rolls `chance`. On a successful roll, picks one of 8 modes
// uniformly at random and plays a slice of the captured input back in a
// mode-specific style: stutter, reverse, octave-up, octave-down, octave-up
// 2×, reverse-octave, silence (gated), or tape-stop (rate decays to zero).
// Stereo: each fire affects ONE random channel; the other passes the dry
// signal through.
//
// Differences from web (deferred):
//   - Internal beat clock instead of scheduler-driven beats. Host transport
//     sync is a JUCE wrapper concern (Phase 4).
//   - Stutter `repeats` count is fixed at 4 (web rolls 2..5 per fire).
//   - Mode select is at sample-rate via S&H rather than at message receipt.
//
// See sequencer/public/worklets/glitch-machine.js for the reference DSP.

declare name "Glitch";
declare description "8-mode random glitch buffer with stereo asymmetric output";
declare author "newspeech";

// Flush-to-zero — without this, the tape-stop mode's exponentially decaying
// `fireRate` hits the denormal range after ~3.5 seconds, and the per-sample
// denormal multiplications stall the CPU enough to hang the browser's audio
// thread in the Faust web IDE. ftz mode 2 (add tiny DC) is the standard fix.
declare options "[ftz:2]";

import("stdfaust.lib");

// ===== Constants =====
RING_MAX  = 96000;   // 1 second at 96 kHz (max expected sample rate)
NUM_MODES = 8;

// ===== UI =====
// Defaults: mix at 1.0 so fires are clearly audible; chance at 0.4 so ~40%
// of beats produce a fire; BPM 120 as a sensible musical default.
mix    = hslider("mix",    1.0, 0,  1,   0.001);
chance = hslider("chance", 0.4, 0,  1,   0.001);
bpm    = hslider("bpm",    120, 60, 240, 0.1);

// ===== Beat clock =====
// Phase counter that increments by 1 each sample and wraps at samplesPerBeat.
// beatPulse is 1 for exactly one sample at each wrap event; that's the
// "beat boundary" tick.
samplesPerBeat = 60.0 / bpm * ma.SR;
beatPhase      = (+(1.0) : %(samplesPerBeat)) ~ _;
beatPulse      = beatPhase < beatPhase';

// ===== Fire trigger =====
// At each beatPulse, sample uniform noise > (1 - 2*chance). If true, fire.
fireTrigger = beatPulse * (no.noise > (1.0 - 2.0 * chance));

// ===== Helpers =====
// Sample-and-hold: when trig=1 capture x, otherwise hold previous output.
sah(trig, x) = (trig * x + (1.0 - trig) * _) ~ _;

// Map noise from [-1, 1] to [0, 1].
uni(n) = (n + 1.0) * 0.5;

// 8-way runtime selector. A nested `select2` chain compiles to a single
// primitive Faust optimizes natively (avoids the phantom-input issue that
// multiplication-sum and other named-arg-heavy forms produce when expanded —
// previous form crashed the Faust web IDE at ~62 phantom inputs).
sel8(i, x0, x1, x2, x3, x4, x5, x6, x7) =
  select2(i == 0,
   select2(i == 1,
    select2(i == 2,
     select2(i == 3,
      select2(i == 4,
       select2(i == 5,
        select2(i == 6, x7, x6),
        x5),
       x4),
      x3),
     x2),
    x1),
   x0);

// ===== Mode selection (S&H at fire) =====
// Mode index 0..7, captured at fire event and held for the fire's duration.
// `min(7, ...)` guards against the edge case where noise=1.0 exactly.
modeIdx = min(NUM_MODES - 1, int(sah(fireTrigger, uni(no.noise) * NUM_MODES)));

// Per-mode parameter tables (rows aligned across modes):
//   0 STUTTER       — 90ms slice, 1× forward, 4 repeats
//   1 REVERSE       — 250ms slice, 1× backward
//   2 OCTAVE_UP     — 200ms × 2× forward
//   3 OCTAVE_DOWN   — 75ms × 0.5 forward
//   4 OCTAVE_2_UP   — 200ms × 4× forward
//   5 REV_OCTAVE    — 200ms × 2× backward
//   6 SILENCE       — 150ms gated drop
//   7 TAPE_STOP     — 500ms slice, rate decays 1× → 0 over 350ms
sliceSec  = sel8(modeIdx, 0.09, 0.25, 0.2, 0.075, 0.2, 0.2, 0.15, 0.5);
rate0     = sel8(modeIdx, 1.0, 1.0, 2.0, 0.5, 4.0, 2.0, 1.0, 1.0);
dir       = sel8(modeIdx, 1.0, -1.0, 1.0, 1.0, 1.0, -1.0, 1.0, 1.0);
silent    = sel8(modeIdx, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0);
decay     = sel8(modeIdx, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.9995);
outputSec = sel8(modeIdx, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, 0.15, 0.35);
repeats   = sel8(modeIdx, 4.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0);

// Slice length in samples.
sliceLen = sliceSec * ma.SR;

// Fire duration: explicit `outputSec` if defined (tape-stop, silence),
// else derived from slice × repeats / rate.
fireDuration = ba.if(outputSec > 0.0,
                     outputSec * ma.SR,
                     sliceLen * repeats / max(0.0001, rate0));

// ===== Fire state =====
// fireRate: captured at fire (rate0); during the active portion of a fire,
// multiplied by `decay` each sample (1.0 for non-tape-stop, 0.9995 for
// tape-stop). Gated by `fireActive` so the multiplication stops the moment
// the fire ends — prevents the rate from drifting toward denormal-land
// between fires.
fireRate = (fireTrigger * rate0 + (1.0 - fireTrigger) * fireActive * (_ * decay)) ~ _;

// fireRemaining: counts down from fireDuration to 0. fireActive = remaining > 0.
fireRemaining = (fireTrigger * fireDuration + (1.0 - fireTrigger) * max(0.0, _ - 1.0)) ~ _;
fireActive    = fireRemaining > 0.0;

// wrapSlice — keeps `x` inside [0, sliceLen) by adding/subtracting
// sliceLen on overshoot. Defined as a signal block (`_ <: ...`) rather
// than as a named-arg function, because function args used multiple times
// in the body get inlined into duplicate `_` references, blowing up the
// process's input count (62 inputs → Faust web IDE crashes). The `<:`
// split form makes Faust share the single input across all references.
wrapSlice = _ <: ba.if(dir == 1.0,
                        ba.if(_ >= sliceLen, _ - sliceLen, _),
                        ba.if(_ < 0.0, _ + sliceLen, _));

// firePosF: float position within slice. Resets at fire (0 for forward, end
// for reverse), advances by `fireRate * dir`, wraps inside slice bounds.
firePosF = (fireTrigger * initStart + (1.0 - fireTrigger) * wrappedAdvance) ~ _
with {
  initStart      = ba.if(dir == 1.0, 0.0, sliceLen - 1.0);
  wrappedAdvance = (_ + fireRate * dir) : wrapSlice;
};

// Stereo side: 0 = fire on L, 1 = fire on R. Captured at fire.
side = sah(fireTrigger, ba.if(no.noise > 0.0, 1.0, 0.0));

// ===== Process =====
// Mono ring buffer (capture (L+R)/2), slice read at lag = sliceLen - firePosF,
// dry/wet blend, stereo asymmetric routing.
process(L, R) = outL, outR
with {
  in = (L + R) * 0.5;

  // Fire sample: read the slice at the appropriate lag. lag = sliceLen
  // means oldest sample of slice (= sliceLen samples behind writeHead);
  // lag = 1 means newest sample. Multiplying by (1 - silent) zeros the
  // fire content during SILENCE mode.
  fireSample = de.fdelay(RING_MAX, sliceLen - firePosF, in) * (1.0 - silent);

  // Per-channel wet (only mixed in if fireActive AND side matches).
  wetL = (1.0 - mix) * L + mix * fireSample;
  wetR = (1.0 - mix) * R + mix * fireSample;

  outL = ba.if(fireActive * (side == 0.0), wetL, L);
  outR = ba.if(fireActive * (side == 1.0), wetR, R);
};
