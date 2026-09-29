// stretch-worklet.js — the timestretch engine behind stretch.html.
//
// Akai S-series timestretch, as the S2000 manual describes it: "insert or
// delete blocks of sample data at appropriate places" with crossfades over
// the joins. Here that is overlap-add of fixed-length blocks (the CYCLE):
// a new block starts every hop = cycle - crossfade output samples, reading
// the source from where the stretched timeline says we are. Stretch the
// timeline and blocks repeat; squash it and they skip.
//
//   CYCLIC — blocks splice at the nominal position, blind to the signal.
//            The splice rate itself becomes a pitch: the robotic, shimmering
//            jungle warble when pushed past a few percent.
//   INTELL — each new block searches around the nominal position for the
//            start that best matches where the previous block was heading
//            (cross-correlation over the crossfade). QUALITY = how many
//            places it looks; low quality makes fewer, worse decisions.
//
// PITCH resamples inside each block (read rate 2^(st/12)) while the timeline
// keeps its length — stretch-then-resample, the other half of the trick.
// The CONVERTER runs last: sample-and-hold rate reduction with no
// anti-alias filter, then truncation to 12 or 8 bits, no dither. It is the
// machine's output stage, so the splice buzz aliases through it too.
//
// No randomness anywhere: a render from reset is sample-identical to the
// first pass you heard live.

class StretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufL = null;
    this.bufR = null;
    this.len = 0;
    this.playing = false;
    this.p = {
      s: 3,          // stretch factor (3 = 300%)
      cycle: 882,    // block length, samples
      xfd: 0.3,      // crossfade as a fraction of half the cycle
      mode: 0,       // 0 cyclic · 1 intell
      quality: 0.5,
      pitch: 0,      // semitones
      bits: 12,
      rate: 30000,   // converter rate, Hz (0 = full)
      level: 1,
    };
    this.resetState();
    this.vizCount = 0;
    this.splices = [];

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'buffer') {
        this.bufL = m.l;
        this.bufR = m.r;
        this.len = m.l.length;
        this.resetState();
      } else if (m.type === 'params') {
        Object.assign(this.p, m.p);
      } else if (m.type === 'play') {
        this.playing = m.on;
      } else if (m.type === 'reset') {
        this.resetState();
      } else if (m.type === 'ping') {
        // in-order ack: everything posted before this has been processed
        this.port.postMessage({ type: 'pong' });
      }
    };
  }

  resetState() {
    this.rp = 0;        // nominal read position on the stretched timeline, source samples
    this.outPos = 0;    // output samples since reset
    this.grains = [];
    this.nextIn = 0;    // output samples until the next block starts
    this.hph = 1;       // converter sample-and-hold phase (1 = take a sample now)
    this.holdL = 0;
    this.holdR = 0;
  }

  wrap(f) {
    const n = this.len;
    f %= n;
    return f < 0 ? f + n : f;
  }

  read(buf, f) {
    const n = this.len;
    const i0 = Math.floor(f);
    const frac = f - i0;
    const a = buf[i0 % n];
    const b = buf[(i0 + 1) % n];
    return a + (b - a) * frac;
  }

  mono(f) {
    const i = Math.floor(this.wrap(f));
    return this.bufL[i] + this.bufR[i];
  }

  // normalized cross-correlation of the source at a vs. b over C points,
  // stepping at the block read rate r
  corr(a, b, C, r) {
    let dot = 0, eb = 0;
    for (let j = 0; j < C; j++) {
      const x = this.mono(a + j * r);
      const y = this.mono(b + j * r);
      dot += x * y;
      eb += y * y;
    }
    return dot / Math.sqrt(eb + 1e-9);
  }

  spawn() {
    const p = this.p;
    const L = Math.max(16, Math.round(p.cycle));
    const X = Math.round(Math.min(1, Math.max(0, p.xfd)) * L * 0.5);
    const H = Math.max(1, L - X);
    const r = Math.pow(2, p.pitch / 12);
    let src = this.rp;
    const prev = this.grains[this.grains.length - 1];
    if (p.mode === 1 && prev) {
      // where the previous block would have kept reading through the overlap
      const nat = prev.src + prev.age * prev.r;
      const q = Math.min(1, Math.max(0, p.quality));
      const R = Math.floor(L / 2);
      const n = 4 + Math.round(q * 124);
      const C = Math.max(16, Math.round(Math.min(512, Math.max(64, X)) * (0.25 + 0.75 * q)));
      const step = Math.max(1, Math.floor((2 * R) / n));
      let best = -Infinity, bestD = 0;
      for (let d = -R; d <= R; d += step) {
        const sc = this.corr(nat, this.rp + d, C, r);
        if (sc > best) { best = sc; bestD = d; }
      }
      if (q >= 0.5 && step > 1) {
        const w = Math.min(step, 32);
        const c0 = bestD;
        for (let d = c0 - w; d <= c0 + w; d++) {
          const sc = this.corr(nat, this.rp + d, C, r);
          if (sc > best) { best = sc; bestD = d; }
        }
      }
      src = this.rp + bestD;
    }
    src = this.wrap(src);
    this.grains.push({ src, age: 0, L, X, r });
    this.nextIn = H;
    this.splices.push(src / this.len);
  }

  process(_, outputs) {
    const out = outputs[0];
    const OL = out[0], OR = out[1] || out[0];
    if (!this.playing || !this.bufL || this.len < 32) {
      OL.fill(0);
      if (OR !== OL) OR.fill(0);
      return true;
    }
    const p = this.p;
    const sr = sampleRate;
    const adv = 1 / Math.max(0.01, p.s);
    const crushRate = p.rate > 0 && p.rate < sr ? p.rate / sr : 0;
    const q = p.bits < 16 ? Math.pow(2, p.bits - 1) : 0;
    const bufL = this.bufL, bufR = this.bufR;

    for (let i = 0; i < OL.length; i++) {
      if (this.nextIn <= 0) this.spawn();
      let l = 0, r = 0;
      for (let k = 0; k < this.grains.length; k++) {
        const g = this.grains[k];
        const a = g.age;
        let w = 1;
        if (g.X > 0) {
          if (a < g.X) w = 0.5 - 0.5 * Math.cos((Math.PI * a) / g.X);
          else if (a >= g.L - g.X) w = 0.5 - 0.5 * Math.cos((Math.PI * (g.L - a)) / g.X);
        }
        const f = this.wrap(g.src + a * g.r);
        l += this.read(bufL, f) * w;
        r += this.read(bufR, f) * w;
        g.age++;
      }
      for (let k = this.grains.length - 1; k >= 0; k--) {
        if (this.grains[k].age >= this.grains[k].L) this.grains.splice(k, 1);
      }
      this.nextIn--;
      this.rp += adv;
      if (this.rp >= this.len) this.rp -= this.len;
      this.outPos++;

      // converter: level in (clipping at full scale), rate (sample-and-hold,
      // no anti-alias), then bits — last, so the output sits on the grid
      l *= p.level;
      r *= p.level;
      l = l > 1 ? 1 : l < -1 ? -1 : l;
      r = r > 1 ? 1 : r < -1 ? -1 : r;
      if (crushRate > 0) {
        this.hph += crushRate;
        if (this.hph >= 1) {
          this.hph -= 1;
          this.holdL = l;
          this.holdR = r;
        }
        l = this.holdL;
        r = this.holdR;
      }
      if (q > 0) {
        l = Math.max(-q, Math.min(q - 1, Math.round(l * q))) / q;
        r = Math.max(-q, Math.min(q - 1, Math.round(r * q))) / q;
      }
      OL[i] = l;
      if (OR !== OL) OR[i] = r;
    }

    // ~30Hz: playhead + the block starts since the last report
    this.vizCount += OL.length;
    if (this.vizCount >= sr / 30) {
      this.vizCount = 0;
      this.port.postMessage({ type: 'viz', rp: this.rp / this.len, out: this.outPos, splices: this.splices });
      this.splices = [];
    }
    return true;
  }
}

registerProcessor('stretch', StretchProcessor);
