// master-gate — threshold-driven noise gate / chopper.
//
// Behavior per sample:
//   1. Track stereo-linked peak envelope (fast attack, ~50 ms release).
//   2. If peak ≥ threshold → target gain = 1, else 0.
//   3. Smooth target with attack envelope (when opening) or release envelope
//      (when closing). User sets attack/release as internals here — the
//      panel only exposes enabled + threshold for now.
//   4. Multiply input × smoothed gain.
//
// Threshold goes up to 0 dB so this works as a chopper (almost everything
// gets gated) not just a noise suppressor. Bypass when disabled is a clean
// passthrough; we keep the smoothed gain pinned at 1 so re-enabling doesn't
// pop.
//
// AudioParams:
//   enabled   (0 or 1, k-rate)
//   threshold (-60..0 dB, a-rate so LFO modulation is smooth)
//   attackMs  (0.1..10, k-rate)
//   releaseMs (10..500, k-rate)

// Fast enough to find quiet moments between percussive transients (~250 ms
// to drop 40 dB), slow enough not to flutter on low-frequency oscillation
// — at 50 Hz the per-half-cycle (10 ms) drop is ~3.5 dB, which the gate's
// own attack/release smoothing absorbs.
const PEAK_RELEASE_MS = 25;

class MasterGateProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'enabled', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'threshold', defaultValue: -45, minValue: -60, maxValue: 0, automationRate: 'a-rate' },
      { name: 'attackMs', defaultValue: 1, minValue: 0.1, maxValue: 10, automationRate: 'k-rate' },
      { name: 'releaseMs', defaultValue: 30, minValue: 10, maxValue: 500, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.peakEnvL = 0;
    this.peakEnvR = 0;
    this.smoothedGain = 1;

    this.peakReleaseCoef =
      1 - Math.exp(-1 / (PEAK_RELEASE_MS * 0.001 * sampleRate));
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input.length || !output.length) return true;

    const enabled = params.enabled[0] >= 0.5;
    const attackMs = params.attackMs[0];
    const releaseMs = params.releaseMs[0];
    const threshArr = params.threshold;

    const inL = input[0];
    const inR = input[1] || inL;
    const outL = output[0];
    const outR = output[1] || outL;
    const N = outL.length;

    // Disabled — passthrough, keep gain pinned at 1 so re-enable doesn't pop.
    if (!enabled) {
      for (let i = 0; i < N; i++) {
        outL[i] = inL[i];
        outR[i] = inR[i];
      }
      this.smoothedGain = 1;
      // Peak envelopes keep tracking so re-enable picks up correct level.
      let peakL = this.peakEnvL;
      let peakR = this.peakEnvR;
      const pc = this.peakReleaseCoef;
      for (let i = 0; i < N; i++) {
        const absL = Math.abs(inL[i]);
        const absR = Math.abs(inR[i]);
        peakL = absL > peakL ? absL : peakL + pc * (absL - peakL);
        peakR = absR > peakR ? absR : peakR + pc * (absR - peakR);
      }
      this.peakEnvL = peakL;
      this.peakEnvR = peakR;
      return true;
    }

    // Attack opens the gate (gain rises to 1); release closes it (falls to 0).
    const attackCoef = 1 - Math.exp(-1 / (attackMs * 0.001 * sampleRate));
    const releaseCoef = 1 - Math.exp(-1 / (releaseMs * 0.001 * sampleRate));
    const peakReleaseCoef = this.peakReleaseCoef;

    let peakL = this.peakEnvL;
    let peakR = this.peakEnvR;
    let gain = this.smoothedGain;

    for (let i = 0; i < N; i++) {
      const xL = inL[i];
      const xR = inR[i];

      const absL = Math.abs(xL);
      const absR = Math.abs(xR);
      peakL = absL > peakL ? absL : peakL + peakReleaseCoef * (absL - peakL);
      peakR = absR > peakR ? absR : peakR + peakReleaseCoef * (absR - peakR);
      const peak = peakL > peakR ? peakL : peakR;
      const peakDb = 20 * Math.log10(peak + 1e-10);

      const thresholdDb = threshArr.length > 1 ? threshArr[i] : threshArr[0];
      const target = peakDb >= thresholdDb ? 1 : 0;

      if (target > gain) {
        gain += attackCoef * (target - gain);
      } else {
        gain += releaseCoef * (target - gain);
      }

      outL[i] = xL * gain;
      outR[i] = xR * gain;
    }

    this.peakEnvL = peakL;
    this.peakEnvR = peakR;
    this.smoothedGain = gain;
    return true;
  }
}

registerProcessor('master-gate', MasterGateProcessor);
