// murmurations-plate.js — the sequencer's reverb as an AudioWorklet.
//
// Hand port of vst/vibe/dsp/reverb.dsp (Clouds-flavoured Griesinger plate,
// same source as the Sequence app's reverb and the Vibe plugin), fully wet.
// Four independent plates, one per speaker channel: channel c in → channel
// c out, so a hard-panned voice keeps its tail in its own speaker. Plates
// differ only in LFO phase, so a signal sent to all four comes back wide.
//
// Params (port message { size, diffusion, damping }) use the .dsp's own
// ranges; defaults are the app's (size 0.5, diffusion 0.625, damping 0.4).

const SR_REF = 32000;

class AllpassComb {
  // Faust fi.allpass_comb: w = x - a·w[n-N]; y = w[n-N] + a·w
  constructor(size, n) { this.buf = new Float32Array(size); this.mask = size - 1; this.n = n; this.i = 0; }
  run(x, a) {
    const d = this.buf[(this.i - this.n) & this.mask];
    const w = x - a * d;
    this.buf[this.i] = w;
    this.i = (this.i + 1) & this.mask;
    return d + a * w;
  }
}

class Plate {
  constructor(sr, lfoPhase) {
    const ns = (n) => Math.floor(n * sr / SR_REF);
    this.sr = sr;
    this.fs = sr / SR_REF;
    this.inDiff = [new AllpassComb(512, ns(113)), new AllpassComb(512, ns(162)),
                   new AllpassComb(1024, ns(241)), new AllpassComb(2048, ns(399))];
    this.ap1a = new AllpassComb(8192, ns(1653));
    this.ap1b = new AllpassComb(8192, ns(2038));
    this.ap2a = new AllpassComb(8192, ns(1913));
    this.ap2b = new AllpassComb(8192, ns(1663));
    this.d1 = new Float32Array(16384); this.d2 = new Float32Array(16384);
    this.di = 0;
    this.del1 = ns(3411);
    this.lp1 = 0; this.lp2 = 0;
    this.fb1 = 0; this.fb2 = 0;            // del1_out / del2_out, one sample late (the ~)
    this.phase = lfoPhase;
    this.dphase = 2 * Math.PI * 0.3 / sr;   // lfo2 = os.osc(0.3)
  }
  // one mono sample in → [wetL, wetR]
  run(x, krt, kap, klp, wetGain, out) {
    let d = x;
    for (const ap of this.inDiff) d = ap.run(d, kap);
    this.lp1 = klp * (d + krt * this.fb2) + (1 - klp) * this.lp1;
    this.lp2 = klp * (d + krt * this.fb1) + (1 - klp) * this.lp2;
    const h1 = this.ap1b.run(this.ap1a.run(this.lp1, -kap), kap);
    const h2 = this.ap2b.run(this.ap2a.run(this.lp2, kap), -kap);
    out[0] = h1 * wetGain;
    out[1] = h2 * wetGain;
    // tank feedback: h1 → fixed delay, h2 → LFO-swept fractional delay
    const m = 16383, i = this.di;
    this.d1[i] = h1; this.d2[i] = h2;
    this.fb1 = this.d1[(i - this.del1) & m];
    const len = this.fs * (4782 + 100 * Math.sin(this.phase));
    const li = Math.floor(len), fr = len - li;
    this.fb2 = this.d2[(i - li) & m] * (1 - fr) + this.d2[(i - li - 1) & m] * fr;
    this.di = (i + 1) & m;
    this.phase += this.dphase;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
  }
}

if (typeof registerProcessor === "function") {
  registerProcessor("murm-plate", class extends AudioWorkletProcessor {
    constructor() {
      super();
      this.plates = [0, 1, 2, 3].map((c) => new Plate(sampleRate, c * Math.PI / 2));
      this.size = 0.5; this.diffusion = 0.625; this.damping = 0.4;
      this.tmp = [0, 0];
      this.port.onmessage = (e) => Object.assign(this, e.data);
    }
    process(inputs, outputs) {
      const inp = inputs[0], out = outputs[0];
      const krt = 0.3 + this.size * 0.62, kap = this.diffusion;
      const klp = 1 - 0.7 * this.damping, wetGain = 1.5 - this.size * 1.2;
      const n = out[0].length;
      for (let c = 0; c < out.length; c++) {
        const x = inp[c], y = out[c], plate = this.plates[c], tmp = this.tmp;
        for (let s = 0; s < n; s++) {
          plate.run(x ? x[s] : 0, krt, kap, klp, wetGain, tmp);
          // alternate taps across speakers for extra decorrelation
          y[s] = tmp[c & 1];
        }
      }
      return true;
    }
  });
}

if (typeof module !== "undefined" && module.exports) module.exports = { Plate };
