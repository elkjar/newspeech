// decay-worklet.js — the disintegration tape engine behind decay.html.
//
// One processor owns the loop buffer, the playhead, and a positional WEAR
// MAP: SEGS segments across the loop window, each holding 0..1 damage.
// Wear evolves once per pass — rich-get-richer (damaged spots shed more,
// like real oxide) plus neighbor spread (wounds grow at their edges) — so
// the same places get worse every repetition. Each sample then reads
// through its segment's wear and the failure knobs decide how damage
// expresses: amplitude gouges and full holes (DROP), positional lowpass
// (SMEAR), sample-hold corruption + crackle (GLITCH), latch-and-repeat
// cells (REPEAT). Nothing here is an "effect" on the signal — it is a
// property of a position on the tape, which is why the piece unfolds as
// process music rather than modulation.
//
// evolveWear() and the health math are MIRRORED in decay.html (death
// prediction + render length). Keep the implementations identical.

const SEGS = 1024;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// MUST match decay.html's evolveWear.
function evolveWear(wear, rng, amount, spread) {
  const hits = Math.max(1, Math.round(amount * SEGS * 0.035));
  for (let i = 0; i < hits; i++) {
    let idx = (rng() * SEGS) | 0;
    if (rng() < 0.65) {
      // rich-get-richer: four candidates, the most damaged wins
      for (let c = 0; c < 3; c++) {
        const j = (rng() * SEGS) | 0;
        if (wear[j] > wear[idx]) idx = j;
      }
    }
    wear[idx] = Math.min(1, wear[idx] + 0.05 + 0.09 * rng());
  }
  if (spread > 0) {
    const k = spread * 0.22;
    for (let i = 0; i < SEGS; i++) {
      const nb = Math.max(wear[(i + SEGS - 1) % SEGS], wear[(i + 1) % SEGS]);
      if (nb > wear[i]) wear[i] = Math.min(1, wear[i] + (nb - wear[i]) * k);
    }
  }
}

const DEFAULTS = {
  wearAmt: 0.8,   // wear added per pass (pre-accel)
  accel: 0.03,    // wear growth factor per pass — the runaway collapse
  spread: 0.45,
  drop: 0.6,
  glitch: 0.25,
  smear: 0.5,
  repeat: 0.25,
  wobble: 0.2,
  air: 0.3,
  level: 1.0,
  cellFrames: 8000, // REPEAT cell length (main thread syncs to bpm divisions)
};

class DecayProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufL = null;
    this.bufR = null;
    this.start = 0;
    this.wlen = 0;
    this.wear = new Float32Array(SEGS);
    this.p = Object.assign({}, DEFAULTS);
    this.playing = false;
    this.pass = 0;
    this.pos = 0;
    this.avg = 0;
    this.rngWear = mulberry32(1);
    // per-sample smoothed state
    this.lastSeg = -1;
    this.g = 1;
    this.tGain = 1;
    this.k = 1;
    this.tK = 1;
    this.lpL = 0;
    this.lpR = 0;
    this.wowP = 0;
    this.flut = 0;
    // REPEAT latch (macro) + GLITCH latch (micro) + sample-hold corruption
    this.latchN = 0; this.latchStart = 0; this.latchLen = 0; this.latchP = 0;
    this.gN = 0; this.gStart = 0; this.gLen = 0; this.gP = 0;
    this.holdN = 0; this.holdL = 0; this.holdR = 0;
    this.vizCount = 0;

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'buffer') {
        this.bufL = m.l;
        this.bufR = m.r;
        this.port.postMessage({ type: 'ready' });
      } else if (m.type === 'window') {
        // a new window is a new tape — fresh oxide
        this.start = m.start;
        this.wlen = Math.max(2, m.len);
        this.resetTape(m.seed);
      } else if (m.type === 'params') {
        Object.assign(this.p, m.p);
      } else if (m.type === 'play') {
        this.playing = m.on;
      } else if (m.type === 'reset') {
        this.resetTape(m.seed);
      } else if (m.type === 'state') {
        // offline render: continue from the live tape's exact condition
        this.wear.set(m.wear);
        this.pass = m.pass;
        this.rngWear = mulberry32(m.seed);
        this.refreshAvg();
      }
    };
  }

  resetTape(seed) {
    this.wear.fill(0);
    this.pass = 0;
    this.pos = 0;
    this.avg = 0;
    this.lastSeg = -1;
    this.g = 1; this.tGain = 1;
    this.latchN = 0; this.gN = 0; this.holdN = 0;
    this.rngWear = mulberry32((seed == null ? 1 : seed) >>> 0);
    this.postPass();
  }

  refreshAvg() {
    let s = 0;
    for (let i = 0; i < SEGS; i++) s += this.wear[i];
    this.avg = s / SEGS;
  }

  postPass() {
    const holeAt = 0.97 - 0.5 * this.p.drop;
    let s = 0, g = 0;
    for (let i = 0; i < SEGS; i++) {
      s += this.wear[i];
      g += this.wear[i] >= holeAt ? 0 : Math.pow(1 - this.wear[i], 1 + 5 * this.p.drop);
    }
    this.avg = s / SEGS;
    this.port.postMessage({
      type: 'pass',
      pass: this.pass,
      wear: this.wear.slice(0),
      avg: this.avg,
      health: g / SEGS,
    });
  }

  onWrap() {
    this.pass++;
    const amount = this.p.wearAmt * Math.pow(1 + this.p.accel, this.pass - 1);
    evolveWear(this.wear, this.rngWear, amount, this.p.spread);
    this.postPass();
  }

  read(buf, rp) {
    const f = this.start + rp;
    const i0 = f | 0;
    const frac = f - i0;
    const a = buf[i0] || 0;
    const b = buf[i0 + 1] || 0;
    return a + (b - a) * frac;
  }

  process(_, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    if (!this.playing || !this.bufL || this.wlen < 2) {
      L.fill(0);
      if (R !== L) R.fill(0);
      return true;
    }
    const p = this.p;
    const sr = sampleRate;
    const holeAt = 0.97 - 0.5 * p.drop;
    const xf = Math.min(1024, this.wlen * 0.05); // loop-seam crossfade

    for (let i = 0; i < L.length; i++) {
      // wow (slow sine) + flutter (filtered noise), both scaled by wear age —
      // a dying tape also loses its transport
      this.wowP += (2 * Math.PI * 0.45) / sr;
      this.flut += ((Math.random() * 2 - 1) * 0.004 - this.flut) * 0.0006;
      const wob = p.wobble * (0.4 + 0.6 * this.avg);
      const rate = 1 + wob * (0.006 * Math.sin(this.wowP) + this.flut);

      this.pos += rate;
      if (this.pos >= this.wlen) {
        this.pos -= this.wlen;
        this.onWrap();
      }
      const seg = Math.min(SEGS - 1, ((this.pos / this.wlen) * SEGS) | 0);
      const w = this.wear[seg];

      if (seg !== this.lastSeg) {
        this.lastSeg = seg;
        this.tGain = w >= holeAt ? 0 : Math.pow(1 - w, 1 + 5 * p.drop);
        const cutHz = 30 + 14000 * Math.pow(1 - Math.min(1, p.smear * w * 1.4), 3);
        this.tK = 1 - Math.exp((-2 * Math.PI * cutHz) / sr);
        // REPEAT: worn segments catch and stutter in place; the playhead
        // keeps moving underneath so the loop period never drifts
        if (this.latchN <= 0 && Math.random() < w * p.repeat * 0.5) {
          this.latchStart = this.pos;
          this.latchLen = Math.max(256, Math.min(this.wlen * 0.5, p.cellFrames * (0.5 + Math.random())));
          this.latchN = 2 + ((Math.random() * 3) | 0);
          this.latchP = 0;
        }
        // GLITCH: micro-cells, 2–12ms
        if (this.gN <= 0 && Math.random() < w * p.glitch * 0.35) {
          this.gStart = this.pos;
          this.gLen = sr * (0.002 + 0.01 * Math.random());
          this.gN = 2 + ((Math.random() * 4) | 0);
          this.gP = 0;
        }
      }

      this.g += (this.tGain - this.g) * 0.0015;
      this.k += (this.tK - this.k) * 0.002;

      let rp = this.pos;
      if (this.latchN > 0) {
        rp = this.latchStart + this.latchP;
        this.latchP += rate;
        if (this.latchP >= this.latchLen) { this.latchP = 0; this.latchN--; }
      }
      if (this.gN > 0) {
        rp = this.gStart + this.gP;
        this.gP += rate;
        if (this.gP >= this.gLen) { this.gP = 0; this.gN--; }
      }
      while (rp >= this.wlen) rp -= this.wlen;

      let sL = this.read(this.bufL, rp);
      let sR = this.read(this.bufR, rp);
      if (rp > this.wlen - xf) {
        const m = (rp - (this.wlen - xf)) / xf;
        const rp2 = rp - (this.wlen - xf);
        sL = sL * (1 - m) + this.read(this.bufL, rp2) * m;
        sR = sR * (1 - m) + this.read(this.bufR, rp2) * m;
      }

      // GLITCH: sample-hold bursts — digital shed
      if (this.holdN > 0) {
        sL = this.holdL; sR = this.holdR;
        this.holdN--;
      } else if (Math.random() < w * p.glitch * 0.002) {
        this.holdN = 16 + ((Math.random() * 180) | 0);
        this.holdL = sL; this.holdR = sR;
      }

      sL *= this.g;
      sR *= this.g;

      // SMEAR: positional lowpass
      this.lpL += this.k * (sL - this.lpL);
      this.lpR += this.k * (sR - this.lpR);
      sL = this.lpL;
      sR = this.lpR;

      // GLITCH: crackle at the wound edges
      if (Math.random() < w * p.glitch * 0.0012) {
        const c = (Math.random() * 2 - 1) * 0.5 * w * w;
        sL += c;
        sR += c * (Math.random() < 0.5 ? 0.8 : -0.8);
      }
      // AIR: hiss floor rising with age
      const hiss = p.air * (0.0015 + 0.012 * this.avg);
      sL += (Math.random() * 2 - 1) * hiss;
      sR += (Math.random() * 2 - 1) * hiss;

      L[i] = sL * p.level;
      R[i] = sR * p.level;
    }

    this.vizCount += L.length;
    if (this.vizCount >= sr / 25) {
      this.vizCount = 0;
      this.port.postMessage({ type: 'pos', f: this.pos / this.wlen, latch: this.latchN > 0 });
    }
    return true;
  }
}

registerProcessor('decay', DecayProcessor);
