// track-ladder — per-channel Moog-style 4-pole ladder lowpass filter.
//
// Slice 1 of the per-track filter direction (see project_sequencer.md, 2026-05-11).
// One instance per track. Cutoff + resonance only; drive / envelope / filter-
// type variants are explicit follow-up slices.
//
// DSP:
//   • Four cascaded 1-pole lowpasses, state stored per channel.
//   • Feedback from y4 back into input via k = 4 * resonance. Stable below
//     k ≈ 3.9; self-oscillates around the cutoff frequency at high resonance.
//   • tanh saturation on the (input - feedback) sum — this is the Moog
//     character: warmth, soft compression when the feedback signal grows,
//     self-limiting behavior at extreme resonance instead of unbounded blow-up.
//   • Cutoff coefficient g = 1 - exp(-2π · fc / sampleRate), the standard
//     1-pole shape. Per-sample a-rate so cutoff sweeps are smooth (LFO
//     destination); k-rate would zipper.
//   • Resonance compensation: at high resonance the passband level dips.
//     Apply `output *= 1 + resonance * 0.5` so a resonance sweep doesn't
//     fade the signal. Tunable on first listen — bump if pad seems quieter
//     at high res, pull back if it gets shouty.
//   • Stereo: L and R channels processed independently with identical params,
//     each carrying its own 4-stage state. No stereo mismatch in slice 1.
//
// AudioParams:
//   • cutoff   (a-rate, Hz, default 18000) — log mapped from store at the
//     main-thread boundary, worklet sees real Hz.
//   • resonance (a-rate, 0..1, default 0) — direct 0..1; worklet scales to
//     0..4 feedback gain internally.

const TWO_PI = 2 * Math.PI;
const MAX_K = 3.95;

class TrackLadderProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'cutoff', defaultValue: 18000, minValue: 20, maxValue: 20000, automationRate: 'a-rate' },
      { name: 'resonance', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'a-rate' },
    ];
  }

  constructor() {
    super();
    // Per-channel cascaded-pole state.
    this.y1L = 0; this.y2L = 0; this.y3L = 0; this.y4L = 0;
    this.y1R = 0; this.y2R = 0; this.y3R = 0; this.y4R = 0;
  }

  process(inputs, outputs, params) {
    const input = inputs[0];
    const output = outputs[0];
    if (!output.length) return true;

    const cutoffArr = params.cutoff;
    const resArr = params.resonance;
    const sr = sampleRate;

    for (let ch = 0; ch < output.length; ch++) {
      const outCh = output[ch];
      // Mono input fans out to both channels — common pattern for upstream
      // mono sources (most drum voices). When inCh is missing for ch=1 but
      // present for ch=0, reuse channel 0 instead of writing silence.
      const inCh = input && input[ch] ? input[ch] : input && input[0] ? input[0] : null;
      if (!inCh) {
        outCh.fill(0);
        continue;
      }

      let y1 = ch === 0 ? this.y1L : this.y1R;
      let y2 = ch === 0 ? this.y2L : this.y2R;
      let y3 = ch === 0 ? this.y3L : this.y3R;
      let y4 = ch === 0 ? this.y4L : this.y4R;

      for (let i = 0; i < outCh.length; i++) {
        const fc = cutoffArr.length > 1 ? cutoffArr[i] : cutoffArr[0];
        const res = resArr.length > 1 ? resArr[i] : resArr[0];
        // Standard 1-pole coefficient, clamped at 0.95 so g never fully
        // saturates as fc approaches Nyquist. Above 0.95 the cascaded feedback
        // loop has effectively no smoothing per stage and the numeric error
        // path blows up into audible pops at high resonance.
        const g = Math.min(0.95, 1 - Math.exp(-TWO_PI * fc / sr));
        // Cutoff-dependent resonance taming. At low g (cutoff well below
        // Nyquist) the analog stability limit k ≈ 4 holds. At high g (cutoff
        // near Nyquist) the cascaded poles' phase response gets too tight to
        // support k near 4 — numerical instability + the resonance peak
        // crowding Nyquist alias back as clicks. Scale k by (1 - 0.85·g) so
        // resonance fades into the top of the cutoff range gracefully rather
        // than popping. Has no audible cost: a res peak at 18 kHz isn't
        // musically useful anyway.
        const k = Math.min(MAX_K, 4 * res) * (1 - 0.85 * g);

        // Feedback from stage-4 back into input, saturated. The tanh is the
        // load-bearing piece of the Moog character — without it the ladder is
        // just a steep linear LP. tanh on the (x - k·y4) sum produces the
        // soft asymmetric compression that defines the sound.
        const drive = Math.tanh(inCh[i] - k * y4);

        // Four cascaded 1-pole updates. Each stage low-passes the previous.
        y1 = y1 + g * (drive - y1);
        y2 = y2 + g * (y1 - y2);
        y3 = y3 + g * (y2 - y3);
        y4 = y4 + g * (y3 - y4);

        // Passband-level compensation. At low res the gain is ~unity; at
        // res=1 the passband dips ~6 dB. Scale the (1 + 0.5·res) boost by
        // (1 - g) so at fully open cutoff — where the filter isn't actually
        // attenuating — we don't add gain on top of already near-full-scale
        // audio (which was the other half of the "pops at cutoff max + high
        // res" symptom).
        outCh[i] = y4 * (1 + res * 0.5 * (1 - g));
      }

      if (ch === 0) {
        this.y1L = y1; this.y2L = y2; this.y3L = y3; this.y4L = y4;
      } else {
        this.y1R = y1; this.y2R = y2; this.y3R = y3; this.y4R = y4;
      }
    }
    return true;
  }
}

registerProcessor('track-ladder', TrackLadderProcessor);
