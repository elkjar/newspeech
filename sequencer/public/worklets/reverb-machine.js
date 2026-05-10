// Reverb machine worklet — Stage 3 v0. 4-line FDN (feedback delay network)
// reverb with Hadamard cross-mixing, per-line one-pole damping, and stereo
// decorrelated output taps. Designed for character (Clouds-flavored) over
// transparency.
//
// Topology:
//   in (mono mix of L+R)
//     │
//     ├──┬──┬──┐
//     ▼  ▼  ▼  ▼
//    [d0][d1][d2][d3]  ← 4 delay lines (prime-spaced lengths)
//     │  │  │  │
//     ├──┴──┴──┤      Hadamard 4×4 (×0.5) cross-mix
//     │  │  │  │
//     × feedback × lowpass(damping)
//     ▼  ▼  ▼  ▼
//     (back into delay-line writes, summed with input)
//
// Output taps:
//   L = (d0 + d1) / 2
//   R = (d2 + d3) / 2
// Different line subsets feed each ear → uncorrelated tails → full stereo
// width without doubling CPU. Cross-bleed in feedback ensures energy
// circulates evenly so neither side starves.
//
// `size` knob maps to feedback gain (0.3..0.95). `mix` is wet/dry crossfade.

// Coprime prime delays — different rooms-within-a-room.
const DELAY_SAMPLES = [1499, 2003, 2521, 3041];
const NUM_LINES = DELAY_SAMPLES.length;
// Lowpass coefficient in the feedback path. Higher = more HF rolloff per
// pass, darker tail, less metallic ring. 0.55 is a moderate Clouds-style
// damping that keeps body but kills the clang.
const DAMPING_COEFF = 0.55;

// Input diffusion: 4 cascaded Schroeder allpasses spread transient energy
// across time so the FDN doesn't ring on each echo independently. Coprime
// primes with progressive delay lengths; g=0.7 is standard Schroeder.
const ALLPASS_DELAYS = [191, 359, 743, 1019];
const ALLPASS_G = 0.7;

// Per-line allpass inside the feedback path (Schroeder/Moorer topology).
// Two cascaded stages per line — each tap is smeared twice before being
// cross-mixed/fed-back/output. Shorter delays than the line lengths, all
// coprime to each other, the line delays, and the input cascade.
const LINE_AP_A_DELAYS = [197, 277, 353, 421];
const LINE_AP_B_DELAYS = [109, 163, 233, 311];
const LINE_AP_G = 0.65;

// Wet output gain — diffusion redistributes peak energy across time so
// peaks drop, BUT high feedback (large size) builds up coherent tail
// energy that overshoots. Solution: gain that scales with size — boost
// low-size (small/quiet) reverbs, cut high-size (long/loud-tail) reverbs.
// `wetGain = WET_GAIN_MAX - size × (WET_GAIN_MAX − WET_GAIN_MIN)`.
const WET_GAIN_MAX = 1.5; // at size=0
const WET_GAIN_MIN = 0.8; // at size=1

class ReverbMachine extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'size', defaultValue: 0.5, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
      { name: 'mix',  defaultValue: 0,   minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.lines = [];
    for (let i = 0; i < NUM_LINES; i++) {
      this.lines.push({
        buf: new Float32Array(DELAY_SAMPLES[i]),
        pos: 0,
        lp: 0, // lowpass state
        apA: { buf: new Float32Array(LINE_AP_A_DELAYS[i]), pos: 0 },
        apB: { buf: new Float32Array(LINE_AP_B_DELAYS[i]), pos: 0 },
      });
    }
    this.allpasses = ALLPASS_DELAYS.map((len) => ({
      buf: new Float32Array(len),
      pos: 0,
    }));
  }

  process(inputs, outputs, params) {
    const inL = inputs[0] && inputs[0][0];
    const inR = (inputs[0] && inputs[0][1]) || inL;
    const outL = outputs[0] && outputs[0][0];
    const outR = outputs[0] && outputs[0][1];
    if (!outL) return true;
    const blockLen = outL.length;

    const size = params.size[0];
    const mix = params.mix[0];
    // Map size 0..1 → feedback 0.3..0.95.
    // 0.95 is just shy of self-oscillation; 0.3 is a fast slap-back.
    const feedback = 0.3 + size * 0.65;
    // Size-dependent wet gain — boost when small/quiet, cut when large/loud.
    const wetGain = WET_GAIN_MAX - size * (WET_GAIN_MAX - WET_GAIN_MIN);

    const lines = this.lines;
    const l0 = lines[0], l1 = lines[1], l2 = lines[2], l3 = lines[3];
    const ap0 = this.allpasses[0];
    const ap1 = this.allpasses[1];
    const ap2 = this.allpasses[2];
    const ap3 = this.allpasses[3];

    for (let i = 0; i < blockLen; i++) {
      const sL = inL ? inL[i] : 0;
      const sR = inR ? inR[i] : sL;
      const inMono = (sL + sR) * 0.5;

      // 4-stage cascaded Schroeder allpass input diffuser. Each stage
      // spreads transients across its delay length without coloring the
      // spectrum (phase-only). After 4 stages, sharp impulses become a
      // smeared cloud before the FDN ever sees them.
      const ap0Out = -ALLPASS_G * inMono + ap0.buf[ap0.pos];
      ap0.buf[ap0.pos] = inMono + ALLPASS_G * ap0Out;
      ap0.pos = (ap0.pos + 1) % ap0.buf.length;

      const ap1Out = -ALLPASS_G * ap0Out + ap1.buf[ap1.pos];
      ap1.buf[ap1.pos] = ap0Out + ALLPASS_G * ap1Out;
      ap1.pos = (ap1.pos + 1) % ap1.buf.length;

      const ap2Out = -ALLPASS_G * ap1Out + ap2.buf[ap2.pos];
      ap2.buf[ap2.pos] = ap1Out + ALLPASS_G * ap2Out;
      ap2.pos = (ap2.pos + 1) % ap2.buf.length;

      const ap3Out = -ALLPASS_G * ap2Out + ap3.buf[ap3.pos];
      ap3.buf[ap3.pos] = ap2Out + ALLPASS_G * ap3Out;
      ap3.pos = (ap3.pos + 1) % ap3.buf.length;

      const diffused = ap3Out;

      // Read each delay line at the write position (= oldest sample).
      const t0 = l0.buf[l0.pos];
      const t1 = l1.buf[l1.pos];
      const t2 = l2.buf[l2.pos];
      const t3 = l3.buf[l3.pos];

      // Per-line allpass — TWO cascaded stages (Moorer topology). Each
      // tap is smeared by two allpasses before it's used for feedback,
      // cross-mix, OR output. Doubles the in-loop diffusion depth so the
      // tail itself is dense smear, not just the input.
      const lap0a = l0.apA;
      const a0 = -LINE_AP_G * t0 + lap0a.buf[lap0a.pos];
      lap0a.buf[lap0a.pos] = t0 + LINE_AP_G * a0;
      lap0a.pos = (lap0a.pos + 1) % lap0a.buf.length;
      const lap0b = l0.apB;
      const d0 = -LINE_AP_G * a0 + lap0b.buf[lap0b.pos];
      lap0b.buf[lap0b.pos] = a0 + LINE_AP_G * d0;
      lap0b.pos = (lap0b.pos + 1) % lap0b.buf.length;

      const lap1a = l1.apA;
      const a1 = -LINE_AP_G * t1 + lap1a.buf[lap1a.pos];
      lap1a.buf[lap1a.pos] = t1 + LINE_AP_G * a1;
      lap1a.pos = (lap1a.pos + 1) % lap1a.buf.length;
      const lap1b = l1.apB;
      const d1 = -LINE_AP_G * a1 + lap1b.buf[lap1b.pos];
      lap1b.buf[lap1b.pos] = a1 + LINE_AP_G * d1;
      lap1b.pos = (lap1b.pos + 1) % lap1b.buf.length;

      const lap2a = l2.apA;
      const a2 = -LINE_AP_G * t2 + lap2a.buf[lap2a.pos];
      lap2a.buf[lap2a.pos] = t2 + LINE_AP_G * a2;
      lap2a.pos = (lap2a.pos + 1) % lap2a.buf.length;
      const lap2b = l2.apB;
      const d2 = -LINE_AP_G * a2 + lap2b.buf[lap2b.pos];
      lap2b.buf[lap2b.pos] = a2 + LINE_AP_G * d2;
      lap2b.pos = (lap2b.pos + 1) % lap2b.buf.length;

      const lap3a = l3.apA;
      const a3 = -LINE_AP_G * t3 + lap3a.buf[lap3a.pos];
      lap3a.buf[lap3a.pos] = t3 + LINE_AP_G * a3;
      lap3a.pos = (lap3a.pos + 1) % lap3a.buf.length;
      const lap3b = l3.apB;
      const d3 = -LINE_AP_G * a3 + lap3b.buf[lap3b.pos];
      lap3b.buf[lap3b.pos] = a3 + LINE_AP_G * d3;
      lap3b.pos = (lap3b.pos + 1) % lap3b.buf.length;

      // Hadamard 4×4 (×0.5, unitary) on diffused taps. Cross-mixes so
      // energy circulates evenly between lines instead of each decaying
      // independently.
      const m0 = (d0 + d1 + d2 + d3) * 0.5;
      const m1 = (d0 - d1 + d2 - d3) * 0.5;
      const m2 = (d0 + d1 - d2 - d3) * 0.5;
      const m3 = (d0 - d1 - d2 + d3) * 0.5;

      // Damping in the feedback path — one-pole LP per line. Highs decay
      // faster than lows, like a real room.
      l0.lp = l0.lp * DAMPING_COEFF + m0 * (1 - DAMPING_COEFF);
      l1.lp = l1.lp * DAMPING_COEFF + m1 * (1 - DAMPING_COEFF);
      l2.lp = l2.lp * DAMPING_COEFF + m2 * (1 - DAMPING_COEFF);
      l3.lp = l3.lp * DAMPING_COEFF + m3 * (1 - DAMPING_COEFF);

      // Write diffused input + damped feedback into each line.
      l0.buf[l0.pos] = diffused + l0.lp * feedback;
      l1.buf[l1.pos] = diffused + l1.lp * feedback;
      l2.buf[l2.pos] = diffused + l2.lp * feedback;
      l3.buf[l3.pos] = diffused + l3.lp * feedback;

      // Advance write positions (each at its own line's length).
      l0.pos = (l0.pos + 1) % l0.buf.length;
      l1.pos = (l1.pos + 1) % l1.buf.length;
      l2.pos = (l2.pos + 1) % l2.buf.length;
      l3.pos = (l3.pos + 1) % l3.buf.length;

      // Stereo decorrelated tap from the DIFFUSED taps — L hears half the
      // network, R the other. The Hadamard cross-bleed keeps both halves
      // alive. wetGain scales with size to balance level across range.
      const wetL = (d0 + d1) * 0.5 * wetGain;
      const wetR = (d2 + d3) * 0.5 * wetGain;

      outL[i] = sL * (1 - mix) + wetL * mix;
      if (outR) outR[i] = sR * (1 - mix) + wetR * mix;
    }

    return true;
  }
}

registerProcessor('reverb-machine', ReverbMachine);
