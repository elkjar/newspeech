// master-distortion — 4-mode nonlinear shaper for the master stage.
//
// Each mode uses GENUINELY DIFFERENT math (not just tuned constants on the
// same tanh) plus mode-specific post-shaping:
//
//   0 boost  — soft `tanh(0.8x)`, symmetric, no post-LP. Clean, "barely there".
//   1 tube   — asymmetric `tanh`, strong one-sample memory (0.25), warm
//              post-LP (~3.5kHz). Heavy even harmonics, dark/rounded.
//   2 fuzz   — rational saturator `x/(1+|0.6x|)` + hard knee at ±0.75, NO
//              post-LP. Sharper knee than tanh, bright, gritty.
//   3 square — hard comparator `sign(x) * 0.9` with input-amplitude threshold
//              (drive lowers it). Strong post-LP (~1.5kHz) turns the square
//              wave into a usable filtered tone.
//
// Slice 5 aliveness polish:
//   • 2× oversampling on Fuzz and Square (linear upsample + average decimate
//     — simple but reduces aliasing significantly; Boost / Tube don't need
//     it and saving the cost is worthwhile).
//   • Slow drift LFO on bias for Tube and Fuzz (0.13/0.19 Hz L/R, ±0.002 amp).
//     Different rates + offset phase per channel give natural decorrelation.
//   • ~0.5% stereo mismatch on drive and bias multipliers. Tiny absolute
//     amount but cumulative across the chain → natural stereo width.
//
// Per-sample flow:
//   1. drive gain × stereo mismatch
//   2. memory blend (1× rate): y_pre = (1-mem)·x + mem·prev_y
//   3. compute bias = (user bias × stereo mismatch + drift LFO)  [Tube/Fuzz only]
//   4. if oversampled: upsample → apply mode at 2× → decimate
//      else: apply mode at 1×
//   5. post low-pass (1× rate)
//   6. output trim per mode
//   7. tiny noise floor
//   8. store prev_y (1× rate)

const MODE_BOOST = 0;
const MODE_TUBE = 1;
const MODE_FUZZ = 2;
const MODE_SQUARE = 3;

const DRIVE_CEIL = [6.0, 4.0, 5.0, 8.0];
// Tube tuning 2026-05-11: memory dropped 0.25 → 0.18 and post-LP coeff
// 0.35 → 0.5 to open up the top end. Original combo was double-stacked LPF
// (memory feedback + post-LP) — net ~3 kHz cutoff, too dark in practice.
// New numbers: memory LP ≈ 1.5 kHz (gentle warmth), post-LP ≈ 5.3 kHz
// (preserves rounded character without muffling cymbals/snares).
const MEMORY = [0.05, 0.18, 0.10, 0.0];
const POST_LP = [0, 0.5, 0, 0.18];
const OUTPUT_TRIM = [1.0, 0.9, 0.65, 0.55];
const NOISE = [0.0003, 0.0005, 0.0008, 0.0003];

// Stereo mismatch (~0.5%). Cumulative across drive + bias + chain stages,
// produces natural width without obvious stereo separation.
const STEREO_DRIVE_MUL = [1.0, 1.005];
const STEREO_BIAS_MUL = [1.0, 0.995];

// Drift LFO modulates bias on asymmetric modes (Tube, Fuzz). Different rates
// and starting phase per channel for decorrelation. ±0.002 amplitude — too
// small to notice directly but makes harmonic content shimmer over time.
// "Single most effective aliveness trick" per the spec.
const DRIFT_AMP = 0.002;
const DRIFT_RATE_L = 0.13;
const DRIFT_RATE_R = 0.19;
const DRIFT_PHASE_R_INIT = Math.PI * 0.37;

class MasterDistortionProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'mode', defaultValue: 0, minValue: 0, maxValue: 3, automationRate: 'k-rate' },
      { name: 'drive', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
      { name: 'bias', defaultValue: 0, minValue: 0, maxValue: 0.2, automationRate: 'a-rate' },
    ];
  }

  constructor() {
    super();
    this.prevYL = 0;
    this.prevYR = 0;
    this.postLpL = 0;
    this.postLpR = 0;
    // Single-sample input delay for the 2× linear-interp upsampler.
    this.prevXL = 0;
    this.prevXR = 0;
    // Drift LFO state — per channel for stereo decorrelation.
    this.driftPhaseL = 0;
    this.driftPhaseR = DRIFT_PHASE_R_INIT;
    this.driftIncL = (DRIFT_RATE_L * 2 * Math.PI) / sampleRate;
    this.driftIncR = (DRIFT_RATE_R * 2 * Math.PI) / sampleRate;
  }

  // Apply per-mode nonlinearity to a single sample (1× or one of the 2×
  // oversampled samples). Caller passes the effective bias (including drift
  // and stereo mismatch). `driveN` is needed for Square's threshold math.
  applyMode(input, mode, bias, driveN) {
    switch (mode) {
      case MODE_BOOST:
        return Math.tanh(input * 0.8);
      case MODE_TUBE: {
        const biased = input + bias;
        const yTanh = biased >= 0
          ? Math.tanh(biased * 1.4)
          : Math.tanh(biased * 0.5) * 0.6;
        return yTanh - bias;
      }
      case MODE_FUZZ: {
        const biased = input + bias;
        let s = biased / (1 + Math.abs(biased * 0.6));
        if (s > 0.75) s = 0.75 + (s - 0.75) * 0.15;
        else if (s < -0.75) s = -0.75 + (s + 0.75) * 0.15;
        const clamped = Math.max(-0.9, Math.min(0.9, s));
        return clamped - bias;
      }
      case MODE_SQUARE: {
        const threshold = 0.35 * (1 - driveN * 0.95);
        return Math.abs(input) > threshold ? Math.sign(input) * 0.9 : 0;
      }
      default:
        return input;
    }
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input.length || !output.length) return true;

    const mode = Math.max(0, Math.min(3, Math.round(params.mode[0])));
    const driveArr = params.drive;
    const biasArr = params.bias;
    const driveCeil = DRIVE_CEIL[mode];
    const memory = MEMORY[mode];
    const oneMinusMem = 1 - memory;
    const postLp = POST_LP[mode];
    const outTrim = OUTPUT_TRIM[mode];
    const noise = NOISE[mode];
    const asymmetric = mode === MODE_TUBE || mode === MODE_FUZZ;
    // Oversampling is restricted to the aliasing-prone modes per spec.
    // Boost and Tube are gentle enough that the extra cost isn't justified.
    const oversample = mode === MODE_FUZZ || mode === MODE_SQUARE;

    for (let ch = 0; ch < output.length; ch++) {
      const inCh = input[ch];
      const outCh = output[ch];
      if (!inCh) {
        outCh.fill(0);
        continue;
      }
      let prevY = ch === 0 ? this.prevYL : this.prevYR;
      let lpState = ch === 0 ? this.postLpL : this.postLpR;
      let prevX = ch === 0 ? this.prevXL : this.prevXR;
      let driftPhase = ch === 0 ? this.driftPhaseL : this.driftPhaseR;
      const driftInc = ch === 0 ? this.driftIncL : this.driftIncR;
      const dMul = STEREO_DRIVE_MUL[ch] !== undefined ? STEREO_DRIVE_MUL[ch] : 1.0;
      const bMul = STEREO_BIAS_MUL[ch] !== undefined ? STEREO_BIAS_MUL[ch] : 1.0;

      for (let i = 0; i < outCh.length; i++) {
        const driveN = driveArr.length > 1 ? driveArr[i] : driveArr[0];
        const biasN = biasArr.length > 1 ? biasArr[i] : biasArr[0];
        const driveLin = (1 + driveN * (driveCeil - 1)) * dMul;
        const xDriven = inCh[i] * driveLin;
        const yPre = oneMinusMem * xDriven + memory * prevY;

        // Drift LFO + stereo bias mismatch (only audible on asymmetric modes).
        const drift = asymmetric ? Math.sin(driftPhase) * DRIFT_AMP : 0;
        const effBias = asymmetric ? biasN * bMul + drift : 0;

        let y;
        if (oversample) {
          // 2× upsample (linear interp), process at 2× rate, decimate (avg).
          // Simple filter response (−6 dB at Nyquist) — good enough to push
          // harmonics out of the audible alias range for the harsh modes.
          const u0 = (prevX + yPre) * 0.5;
          const u1 = yPre;
          prevX = yPre;
          const v0 = this.applyMode(u0, mode, effBias, driveN);
          const v1 = this.applyMode(u1, mode, effBias, driveN);
          y = (v0 + v1) * 0.5;
        } else {
          y = this.applyMode(yPre, mode, effBias, driveN);
          // Keep prevX synced even when not oversampling so mode switches
          // into Fuzz/Square don't have a stale input-delay sample.
          prevX = yPre;
        }

        if (postLp > 0) {
          lpState += postLp * (y - lpState);
          y = lpState;
        }

        y *= outTrim;

        if (noise > 0) y += (Math.random() - 0.5) * noise;

        prevY = y;
        outCh[i] = y;

        // Advance drift LFO phase at 1× rate. Wrap to avoid float-precision
        // drift after long sessions.
        driftPhase += driftInc;
        if (driftPhase > 2 * Math.PI) driftPhase -= 2 * Math.PI;
      }

      if (ch === 0) {
        this.prevYL = prevY;
        this.postLpL = lpState;
        this.prevXL = prevX;
        this.driftPhaseL = driftPhase;
      } else {
        this.prevYR = prevY;
        this.postLpR = lpState;
        this.prevXR = prevX;
        this.driftPhaseR = driftPhase;
      }
    }
    return true;
  }
}

registerProcessor('master-distortion', MasterDistortionProcessor);
