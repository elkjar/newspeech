// master-compressor — BOUM-style one-knob compressor with negative-ratio mode.
//
// Single `amount` knob maps to threshold + ratio + makeup simultaneously.
// First 60% of the knob is gentle, last 40% gets aggressive, and past 0.9
// the slope crosses zero (brick-wall limiter) and goes NEGATIVE — louder
// input produces quieter output. That negative-ratio behavior is a BOUM
// signature, not a standard compressor feature.
//
// Architecture:
//   1. Stereo-linked detector — hybrid of peak (fast attack, slow release
//      envelope follower) and RMS (~10ms 1-pole window). max(peak, rms)
//      feeds the gain reduction, so transients trigger fast (peak) but
//      sustained energy still gets compressed (rms).
//   2. Soft-knee gain reduction at ±3 dB around threshold.
//   3. Attack/release smoothing via per-sample one-pole envelopes, with the
//      release coefficient interpolating between "fast" and "slow" based on
//      how long the comp has been active (program-dependent release).
//   4. Gain reduction self-saturation (tanh-shaped) so heavy compression
//      adds harmonic content of its own — "the comp has a sound."
//
// AudioParams:
//   amount  (0..1, a-rate)  — the one knob
//   attackMs (0.1..30, k-rate)
//   releaseMs (30..10000, k-rate)
//
// Stereo: detector is linked (max across channels) so the L/R gain reduction
// stays identical — prevents stereo image wander under heavy compression.

const KNEE_DB = 6;            // ±3 dB knee around threshold
const ACTIVE_GR_DB = 0.5;     // gain reduction above this is "actively compressing"
const FAST_RELEASE_FACTOR = 0.5;  // ≤100ms active: release runs 0.5× user setting
const SLOW_RELEASE_FACTOR = 2.0;  // ≥500ms active: 2× user setting
const ACTIVE_FAST_MS = 100;
const ACTIVE_SLOW_MS = 500;
const GR_SAT_SCALE = 0.05;    // gr_db × 0.05 → tanh → ÷0.05. Transparent at small gr.

class MasterCompressorProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'amount', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'attackMs', defaultValue: 1, minValue: 0.1, maxValue: 30, automationRate: 'k-rate' },
      { name: 'releaseMs', defaultValue: 100, minValue: 30, maxValue: 10000, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    // Per-channel detector state
    this.peakEnvL = 0;
    this.peakEnvR = 0;
    this.rmsSqL = 0;
    this.rmsSqR = 0;
    // Shared (stereo-linked) gain reduction state
    this.smoothedGrDb = 0;
    this.activeSamples = 0;

    // Peak envelope follower coefficients. Fast attack = instant max;
    // slow release ~50ms. Recomputed lazily — depends on sampleRate which
    // is constant in worklet lifetime.
    const peakReleaseMs = 50;
    this.peakReleaseCoef = 1 - Math.exp(-1 / (peakReleaseMs * 0.001 * sampleRate));

    // RMS one-pole. ~10ms window.
    const rmsWindowMs = 10;
    this.rmsCoef = 1 - Math.exp(-1 / (rmsWindowMs * 0.001 * sampleRate));
  }

  // Map amount (0..1) to {threshDb, slope, makeupDb}.
  // - Threshold: 0 → −30 dB
  // - Slope: 1 (no comp) → 0.05 (20:1) at amount=0.9, then 0.05 → −1 at amount=1.0
  //   (slope crosses 0 = brick-wall limiter, goes negative = upward inversion)
  // - Makeup: 0 → +18 dB
  // First 60% of knob is gentle (linear), last 40% accelerates via sqrt.
  amountToParams(amount) {
    const a = Math.max(0, Math.min(1, amount));
    let shaped;
    if (a <= 0.6) {
      shaped = a * 0.5;                          // 0..0.3 linear
    } else {
      const t = (a - 0.6) / 0.4;                 // 0..1
      shaped = 0.3 + Math.sqrt(t) * 0.7;         // 0.3..1.0 accelerating
    }
    const threshDb = -shaped * 30;
    let slope;
    if (a <= 0.9) {
      const t = a / 0.9;
      const ratio = 1 + t * 19;                  // 1..20
      slope = 1 / ratio;
    } else {
      const t = (a - 0.9) / 0.1;                 // 0..1
      slope = 0.05 - t * 1.05;                   // 0.05 → −1
    }
    const makeupDb = shaped * 18;
    return { threshDb, slope, makeupDb };
  }

  // Compute target gain reduction in dB given the detected level (dB) and
  // the current threshold / slope. Soft knee in ±3 dB window.
  computeGrDb(levelDb, threshDb, slope) {
    const kneeStart = threshDb - KNEE_DB / 2;
    const kneeEnd = threshDb + KNEE_DB / 2;
    if (levelDb <= kneeStart) return 0;
    const oneMinusSlope = 1 - slope;
    if (levelDb >= kneeEnd) {
      return oneMinusSlope * (levelDb - threshDb);
    }
    // Quadratic ramp through the knee — smooth start.
    const x = (levelDb - kneeStart) / KNEE_DB;   // 0..1
    const target = oneMinusSlope * (levelDb - threshDb);
    return target * x * x;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input.length || !output.length) return true;

    const amountArr = params.amount;
    const attackMs = params.attackMs[0];
    const releaseMs = params.releaseMs[0];
    const N = output[0].length;

    // Precompute envelope coefficients (per-block; cheap and AudioParams are
    // k-rate so attack/release don't change mid-block anyway).
    const attackCoef = 1 - Math.exp(-1 / (attackMs * 0.001 * sampleRate));
    const baseReleaseCoef = 1 - Math.exp(-1 / (releaseMs * 0.001 * sampleRate));
    const fastReleaseCoef =
      1 - Math.exp(-1 / (releaseMs * FAST_RELEASE_FACTOR * 0.001 * sampleRate));
    const slowReleaseCoef =
      1 - Math.exp(-1 / (releaseMs * SLOW_RELEASE_FACTOR * 0.001 * sampleRate));

    const inL = input[0];
    const inR = input[1] || inL;
    const outL = output[0];
    const outR = output[1] || outL;

    let peakEnvL = this.peakEnvL;
    let peakEnvR = this.peakEnvR;
    let rmsSqL = this.rmsSqL;
    let rmsSqR = this.rmsSqR;
    let smoothedGr = this.smoothedGrDb;
    let activeSamples = this.activeSamples;

    const peakReleaseCoef = this.peakReleaseCoef;
    const rmsCoef = this.rmsCoef;

    for (let i = 0; i < N; i++) {
      const amount = amountArr.length > 1 ? amountArr[i] : amountArr[0];
      const { threshDb, slope, makeupDb } = this.amountToParams(amount);

      const xL = inL[i];
      const xR = inR[i];

      // Peak envelope — instant attack, slow release.
      const absL = Math.abs(xL);
      const absR = Math.abs(xR);
      peakEnvL = absL > peakEnvL ? absL : peakEnvL + peakReleaseCoef * (absL - peakEnvL);
      peakEnvR = absR > peakEnvR ? absR : peakEnvR + peakReleaseCoef * (absR - peakEnvR);

      // RMS — 1-pole moving average of x².
      rmsSqL += rmsCoef * (xL * xL - rmsSqL);
      rmsSqR += rmsCoef * (xR * xR - rmsSqR);
      const rmsL = Math.sqrt(rmsSqL);
      const rmsR = Math.sqrt(rmsSqR);

      // Hybrid: max(peak, rms) per channel, then max across stereo for link.
      const levelL = peakEnvL > rmsL ? peakEnvL : rmsL;
      const levelR = peakEnvR > rmsR ? peakEnvR : rmsR;
      const level = levelL > levelR ? levelL : levelR;
      const levelDb = 20 * Math.log10(level + 1e-10);

      const targetGr = this.computeGrDb(levelDb, threshDb, slope);

      // Program-dependent release: interpolate release coef between fast and
      // slow based on how long comp has been actively reducing gain. Brief
      // activity → fast release (snappy); sustained activity → slow release
      // (musical, doesn't pump).
      const activeMs = (activeSamples / sampleRate) * 1000;
      let releaseCoef;
      if (activeMs <= ACTIVE_FAST_MS) {
        releaseCoef = fastReleaseCoef;
      } else if (activeMs >= ACTIVE_SLOW_MS) {
        releaseCoef = slowReleaseCoef;
      } else {
        const t = (activeMs - ACTIVE_FAST_MS) / (ACTIVE_SLOW_MS - ACTIVE_FAST_MS);
        releaseCoef = fastReleaseCoef + t * (slowReleaseCoef - fastReleaseCoef);
      }

      // Apply attack/release envelope to gr.
      if (targetGr > smoothedGr) {
        smoothedGr += attackCoef * (targetGr - smoothedGr);
      } else {
        smoothedGr += releaseCoef * (targetGr - smoothedGr);
      }

      // Track activity duration for program-dependent release.
      if (smoothedGr > ACTIVE_GR_DB) {
        activeSamples++;
      } else {
        activeSamples = 0;
      }

      // Gain reduction self-saturation — the comp adds harmonics under heavy
      // reduction. tanh(gr × 0.05) / 0.05 is transparent at small gr (~unity
      // slope) and saturates ~20 dB ceiling at extreme gr.
      const grSaturated = Math.tanh(smoothedGr * GR_SAT_SCALE) / GR_SAT_SCALE;

      const gainLinear = Math.pow(10, -grSaturated / 20);
      const makeupLinear = Math.pow(10, makeupDb / 20);
      const totalGain = gainLinear * makeupLinear;

      outL[i] = xL * totalGain;
      outR[i] = xR * totalGain;

      // Suppress baseReleaseCoef unused-var lint if the linter ever runs
      // against worklets — we keep it computed in case future code wants to
      // bypass the program-dependent override.
      void baseReleaseCoef;
    }

    this.peakEnvL = peakEnvL;
    this.peakEnvR = peakEnvR;
    this.rmsSqL = rmsSqL;
    this.rmsSqR = rmsSqR;
    this.smoothedGrDb = smoothedGr;
    this.activeSamples = activeSamples;

    return true;
  }
}

registerProcessor('master-compressor', MasterCompressorProcessor);
