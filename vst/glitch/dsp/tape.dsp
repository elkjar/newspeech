// Tape — Faust port of sequencer's tape-machine.js (Phase 2b: bed + grains)
//
// Multi-head varispeed tape buffer with stereo pan + 8-voice grain pool.
// Bed: two varispeed read heads each with independent stretch + gain. Layer 1
// defaults to live pitch (stretch=1.0) and leans left; layer 2 defaults to
// octave-down (stretch=0.5) and leans right.
// Grain pool: 8 single-shot voices firing at a randomized rate, each with
// random offset, random duration (167-400ms), quantized pitch ratio from
// {0.5, 2/3, 1, 1.5, 2}, and randomly panned to one ear.
//
// Simplifications from web (still to fill in):
//   - Hold/freeze not yet implemented (always writes input to buffer)
//   - Smoothing of window bounds skipped (move position/length sliders slowly)
//
// See sequencer/public/worklets/tape-machine.js for the reference DSP.

declare name "Tape";
declare description "Multi-head varispeed tape with stereo pan and 8-voice grain pool";
declare author "newspeech";

import("stdfaust.lib");

// ===== Constants =====
// Max buffer size: 8 seconds at 96 kHz (max expected sample rate).
MAX_BUF = 768000;

// Window-shape constants in seconds (converted to samples at runtime via ma.SR).
MIN_WINDOW_S = 0.1;
SAFETY_S     = 0.25;
BUF_S        = 8.0;

// Crossfade duration when the read head wraps the window boundary. JS uses
// 20ms; we use 10ms here, audibly enough to mask the wrap click without
// muting too much of the playback.
XFADE_S = 0.01;

// Grain pool constants.
GRAIN_POOL_SIZE      = 8;
GRAIN_LEN_MIN_S      = 0.167;
GRAIN_LEN_MAX_S      = 0.4;
GRAIN_FADE_S         = 0.05;   // 50ms attack/release, capped at 25% of duration
GRAIN_EVENTS_PER_SEC = 16;     // max spawn rate when grainRate = 1.0

// ===== UI =====
// Defaults chosen for an immediately audible "varispeed companion" effect:
// reverse ON, layer 2 at 0.5× (octave down), full gain on both layers,
// position 30% / length 50% gives a ~4-second window starting ~1.4s back.
mix       = hslider("mix",       1.0,  0,    1, 0.001);
position  = hslider("position",  0.3,  0,    1, 0.001);
length_   = hslider("length",    0.5,  0,    1, 0.001);
reverse   = hslider("reverse",   1,    0,    1, 1);
stretch1  = hslider("stretch1",  1.0,  0.25, 4, 0.001);
gain1     = hslider("gain1",     1.0,  0,    1, 0.001);
stretch2  = hslider("stretch2",  0.5,  0.25, 4, 0.001);
gain2     = hslider("gain2",     1.0,  0,    1, 0.001);
// grainRate default 0.3 → ~4.8 grains/sec, audibly granular without
// overwhelming the bed. Set to 0 to mute grain layer entirely.
grainRate = hslider("grainRate", 0.3,  0,    1, 0.001);
grainMix  = hslider("grainMix",  1.0,  0,    1, 0.001);
hold      = checkbox("hold");

// ===== Derived window bounds (in samples) =====
// Web ports the same arithmetic — see tape-machine.js for the rationale.
SAFETY_SAMP   = SAFETY_S * ma.SR;
MIN_WINDOW    = MIN_WINDOW_S * ma.SR;
MAX_LOOKBACK  = (BUF_S - SAFETY_S - 1) * ma.SR;

windowSize = max(MIN_WINDOW, MAX_LOOKBACK * length_);
windowMin  = SAFETY_SAMP + (MAX_LOOKBACK - windowSize) * position;
windowMax  = windowMin + windowSize;
xfadeSamp  = XFADE_S * ma.SR;

// ===== Single-step wrap to window bounds =====
// Handles drift of at most one windowSize per step (sufficient for any
// reasonable advance rate). At startup rb=0 may be below windowMin and gets
// snapped in one wrap; thereafter steady-state.
wrap(x) = ba.if(x > windowMax, x - windowSize,
                ba.if(x < windowMin, x + windowSize, x));

// ===== Per-head advance =====
// advance = drb/dt — how many samples behind to advance the read head.
//   reverse=0 forward: advance = 1 - stretch (head stays still at stretch=1)
//   reverse=1 reverse: advance = 1 + stretch (head moves backward through time)
// Negative advance values mean the head walks toward the write head; the
// wrap function keeps it within [windowMin, windowMax].
// `- hold` matches the web's writeHead-paused compensation: when held, the
// bed's read pointer needs to fall back 1 sample per cycle to stay at the
// same absolute buffer position (the actual write pointer can't be paused
// in Faust, so we subtract instead — and the buffer self-loops, below).
adv(s) = (1 - s) * (1 - reverse) + (1 + s) * reverse - hold;

// ===== Bounded rb accumulator =====
// y(t) = wrap(adv(t) + y(t-1)). Faust idiom: pipe adv through a recursive
// (+ : wrap) ~ _ block.
//
// Initialization: Faust's recursive feedback starts at 0, but we want rb to
// start at ~windowMin (matching the JS's `head.rb = sampleRate * 0.5` then
// initial-clamp to windowMin behavior). Inject windowMin as a one-shot pulse
// on the first sample (1-1' is 1 at t=0, 0 thereafter). Without this, rb
// bounces around the wrap function for ~33k samples before settling,
// producing a brief audible artifact before reverse playback kicks in
// properly.
firstSample = 1 - 1';
rbHead(s) = (adv(s) + windowMin * firstSample) : (+ : wrap) ~ _;

// ===== Read interpolated from buffer at rb samples ago, with ghost crossfade =====
// At each wrap event (rb jumps by ~windowSize), a ghost head snapshots the
// pre-wrap rb and continues advancing at `adv` (without wrapping). For the
// next xfadeSamp samples, output = ghost*(1-fade) + primary*fade, where
// `fade` linearly ramps from 0 to 1. After the ramp, only the primary head
// is heard. This masks the audio discontinuity at the wrap boundary —
// equivalent to the JS's ghostRb crossfade pattern.
//
// Wrap detection: `abs(rb - rb') > windowSize/2` — any jump bigger than
// half the window must have been a wrap (advance is at most ±4 samples/
// step in normal operation).
layerSample(in, s) = primary * fadeGain + ghost * (1.0 - fadeGain)
with {
  rb        = rbHead(s);
  advSig    = adv(s);
  event     = abs(rb - rb') > windowSize * 0.5;
  // Ghost rb: at wrap event, snap to "what rb would have been without
  // wrap" (rb' + advSig). Otherwise continue advancing at advSig.
  ghostRb   = (event * (rb' + advSig) + (1.0 - event) * (_ + advSig)) ~ _;
  // Fade gain: jumps to 0 at wrap event, ramps to 1 over xfadeSamp samples.
  fadeGain  = (event * 0.0 + (1.0 - event) * min(1.0, _ + 1.0 / xfadeSamp)) ~ _;
  primary   = de.fdelay(MAX_BUF, rb,      in);
  ghost     = de.fdelay(MAX_BUF, ghostRb, in);
};

// ===== Sample-and-hold helper =====
// When trig=1: output = x. When trig=0: output = previous output. Used to
// freeze random param values per grain at the spawn event.
sah(trig, x) = (trig * x + (1.0 - trig) * _) ~ _;

// ===== Grain trigger generator =====
// Probability of a grain firing per sample = grainRate * 16 / sampleRate.
// We threshold a uniform noise source to get a Bernoulli trigger pulse at
// the desired rate. With grainRate=1.0 and SR=48k, ~16 events/sec.
// voiceIdx round-robins across the 8-voice pool: on each trigger pulse, it
// increments mod 8, and only the voice matching its current value fires.
grainSpawnProb = grainRate * GRAIN_EVENTS_PER_SEC / ma.SR;
grainTrigger   = (no.noise > (1.0 - 2.0 * grainSpawnProb)) * (grainRate > 0);
voiceIdx       = (+(grainTrigger) : %(GRAIN_POOL_SIZE)) ~ _;

// ===== Per-voice grain =====
// 8 of these run in parallel. Each captures random params at its fire event,
// counts up to its captured duration, reads from the buffer at the
// (captured offset + grainAdv × counter) lag, applies a trapezoidal envelope,
// and pans hard to one side. After the duration elapses, env is 0 and the
// voice is silent until the next time the round-robin selects it.
grainVoice(i, in) = sample * env * gainL, sample * env * gainR
with {
  fire = grainTrigger * (voiceIdx == i);

  // S&H random params at fire (delayed noise streams for decorrelation
  // within a single voice).
  uni(n)       = (n + 1) * 0.5;  // map noise from [-1,1] to [0,1]
  randOffset   = sah(fire, uni(no.noise));
  randDuration = sah(fire, uni(no.noise'));
  randRateIdx  = sah(fire, uni(no.noise''));
  randSide     = sah(fire, no.noise''' > 0);

  // Captured grain duration (samples), held for the voice's lifetime.
  durationSamp = (GRAIN_LEN_MIN_S + randDuration * (GRAIN_LEN_MAX_S - GRAIN_LEN_MIN_S)) * ma.SR;

  // Quantized rate from {0.5, 2/3, 1, 1.5, 2} (octave / fifth intervals).
  rateIdx = int(randRateIdx * 5);
  rate    = ba.if(rateIdx == 0, 0.5,
            ba.if(rateIdx == 1, 0.6667,
            ba.if(rateIdx == 2, 1.0,
            ba.if(rateIdx == 3, 1.5, 2.0))));

  // Starting rb in samples-behind-writeHead — random within the usable
  // window (window minus duration so grain stays in-bounds).
  usableWindow = max(1.0, windowSize - durationSamp);
  startRb      = windowMin + randOffset * usableWindow;

  // Counter: increments from 0 each fire, frozen at durationSamp when done.
  counter = (fire * 0.0 + (1.0 - fire) * min(durationSamp, _ + 1.0)) ~ _;
  active  = counter < durationSamp;

  // Grain advance — same formula as the bed heads, including the -hold term
  // so frozen grains scrub through static content at their captured rate.
  grainAdv = (1.0 - rate) * (1.0 - reverse) + (1.0 + rate) * reverse - hold;

  // Read position: starts at startRb, grows by grainAdv per sample.
  rbVoice = startRb + grainAdv * counter;

  // Trapezoidal envelope: fade in over fadeSampGrain, hold at 1, fade out
  // over fadeSampGrain. Capped at 25% of duration so very short grains
  // don't over-fade.
  fadeSampGrain = min(GRAIN_FADE_S * ma.SR, durationSamp * 0.25);
  attackEnv     = min(1.0, counter / fadeSampGrain);
  releaseEnv    = min(1.0, (durationSamp - counter) / fadeSampGrain);
  env           = active * min(attackEnv, releaseEnv);

  sample = de.fdelay(MAX_BUF, rbVoice, in);

  // Hard pan: side=0 → L only, side=1 → R only.
  gainL = 1.0 - randSide;
  gainR = randSide;
};

// ===== Grain pool: 8 voices summed to stereo =====
// par(i, 8, grainVoice(...)) produces 16 channels in (L0,R0,L1,R1,...,L7,R7)
// order. We use `route` to sum odd-indexed channels into the L bus and
// even-indexed into the R bus (Faust's `:>` does block merge, not stride
// merge — see reference_faust_split_merge.md).
grainPool(in) = par(i, GRAIN_POOL_SIZE, grainVoice(i, in)) : route(16, 2,
  (1,1),  (2,2),  (3,1),  (4,2),
  (5,1),  (6,2),  (7,1),  (8,2),
  (9,1),  (10,2), (11,1), (12,2),
  (13,1), (14,2), (15,1), (16,2)
);

// ===== Equal-power pan gains =====
// LAYER_PANS = (-0.5, +0.5) from JS. cos/sin pan: at pan=p in [-1, 1],
// gainL = cos((p+1)*π/4), gainR = sin((p+1)*π/4). Symmetric: L gain at
// pan=-0.5 equals R gain at pan=+0.5.
PAN1 = -0.5;
PAN2 =  0.5;
L1_GAIN = cos((PAN1 + 1) * ma.PI / 4);
R1_GAIN = sin((PAN1 + 1) * ma.PI / 4);
L2_GAIN = cos((PAN2 + 1) * ma.PI / 4);
R2_GAIN = sin((PAN2 + 1) * ma.PI / 4);

// ===== Wet path =====
// Stereo in → mono sum → (bed + grains) → 300 Hz HPF on bed → sum → stereo out.
// HPF mirrors the always-on highpass tape.ts applies upstream of the worklet.
// Grains skip the HPF (they're already short transient reads; HPF would dull
// their attack).
monoMix = (_ + _) * 0.5;

// ===== Freeze loop =====
// When held, the input fed to the bed/grain delay lines switches from the
// live mono signal to a recirculating copy of itself — `liveIn * (1-hold)
// + fb * hold` written back into a de.fdelay whose period equals the bed's
// active window. The bed reads at rb ∈ [windowMin, windowMax] from this
// signal; while held, those reads land inside the freeze cycle and the
// captured snippet loops indefinitely. A slewed crossfade on the bed/grain
// input (holdSmooth, ~5ms) prevents click on engage/disengage; the read-head
// `adv` term above uses the raw `hold` so direction changes are instant.
holdSmooth = hold : si.smoo;
freezeCombine(fb, live) = live * (1.0 - hold) + fb * hold;
freezeBuffer = (freezeCombine : de.fdelay(MAX_BUF, max(1.0, windowSize - 1.0))) ~ _;

wetPath(L, R) = bedL + grainL * grainMix,
                bedR + grainR * grainMix
with {
  liveIn = monoMix(L, R);
  in     = liveIn * (1.0 - holdSmooth) + freezeBuffer(liveIn) * holdSmooth;

  // Bed
  l1       = layerSample(in, stretch1) * gain1;
  l2       = layerSample(in, stretch2) * gain2;
  bedLraw  = l1 * L1_GAIN + l2 * L2_GAIN;
  bedRraw  = l1 * R1_GAIN + l2 * R2_GAIN;
  bedL     = bedLraw : fi.highpass(2, 300);
  bedR     = bedRraw : fi.highpass(2, 300);

  // Grain pool — Faust's tuple destructuring is unavailable, so we call
  // grainPool twice with the same input. Faust's CSE should share the
  // 8-voice work; if performance is an issue, we'd restructure later.
  grainLR  = grainPool(in);
  grainL   = grainLR : (_, !);
  grainR   = grainLR : (!, _);
};

// ===== Process =====
// Dry/wet stereo mix using the explicit splitStereo + combiner pattern
// (Faust's `<:`/`:>` do BLOCK distribution and would silently collapse the
// stereo — see reference_faust_split_merge.md).
splitStereo(L, R) = L, R, L, R;
combiner(dryL, dryR, wetL, wetR) = dryL * (1.0 - mix) + wetL * mix,
                                    dryR * (1.0 - mix) + wetR * mix;
process = splitStereo : (_, _, wetPath) : combiner;
