// noise-worklet.js — the audio destruction chain behind noise.html.
//
// The uploaded file is the timebase. Six stages in a FIXED serial order:
//
//   file → CRUSH → NOISE → DRIVE → CHOP → GLITCH → FEEDBACK → out
//
// Each stage is a lane on the page; a block = the stage is in the path for
// that span of the file, carrying its own full settings. Every stage is
// band-scoped (lo/hi): only the band between them is processed, the rest of
// the spectrum passes around it. Stage engagement is slewed (~2ms) so block
// edges don't click. Every pass through the file is one generation: blocks
// count their fires for the per-block accumulator, and every lane's MUTATE
// knob reshapes its blocks (the live pattern) while the page keeps showing
// what was drawn (the authored pattern). Mutation lives HERE, not on the
// page, so live play and an offline print evolve identically from one seed.
// All randomness is seeded so a print repeats.
//
// The NOISE stage is the Mörser port from texture-worklet.js; DRIVE is the
// OTO-BOUM-shaped master distortion from the Sequence app (audio.rs
// master_dist_apply_mode) minus the emphasis EQ.

const STAGE_ORDER = ['crush', 'noise', 'drive', 'chop', 'glitch', 'feedback'];
const LO_LADDER = [0, 80, 160, 320, 640, 1200];
const HI_LADDER = [20000, 10000, 5000, 2500, 1200, 600];
const BITS_LADDER = [16, 12, 10, 8, 6, 4, 3, 2, 1];
const RATE_DIV_LADDER = [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48, 64];
const CHOP_PERIOD_LADDER = [4, 2, 1, 1 / 2, 1 / 4, 1 / 8, 1 / 16];
const GLITCH_LEN_LADDER = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2];
const PITCH_LADDER = [-2, -1, 0, 1, 2];
const FB_DELAY_LADDER = [1, 2, 5, 10, 20, 50, 100, 200, 500];
const DIST_MODES = ['boost', 'tube', 'fuzz', 'square'];
const DIST_DRIVE_CEIL = [6, 4, 5, 8];
const DIST_MEMORY = [0.05, 0.18, 0.1, 0];
const DIST_POST_LP = [0, 0.5, 0, 0.18];
const DIST_OUT_TRIM = [1, 0.9, 0.65, 0.55];
// knobs with ladders: the accumulator climbs in ladder steps; continuous
// knobs climb 10% per rung.
const KNOB_STEPS = {
  lo: 6, hi: 6, bits: 9, rate: 12, period: 7, len: 6, count: 16, pitch: 5, delay: 9,
};

const ladder = (arr, k) => arr[Math.round(Math.min(1, Math.max(0, k)) * (arr.length - 1))];
const clamp01 = (v) => Math.min(1, Math.max(0, v));

// --- small DSP helpers -------------------------------------------------------
// RBJ biquad, transposed direct form II. Per-channel state in a Float32Array(2).
class Biquad {
  constructor() { this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0; this.z = [new Float32Array(2), new Float32Array(2)]; this.bypass = true; }
  set(type, fc, q) {
    if (type === 'hp' && fc <= 1) { this.bypass = true; return; }
    // the top of the hi ladder (20k) is "no low-pass" — a real biquad there
    // would leave residue around every stage
    if (type === 'lp' && (fc >= 20000 || fc >= sampleRate * 0.49)) { this.bypass = true; return; }
    this.bypass = false;
    const w0 = (2 * Math.PI * Math.min(fc, sampleRate * 0.49)) / sampleRate;
    const cw = Math.cos(w0), sw = Math.sin(w0), al = sw / (2 * q);
    let b0, b1, b2;
    if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
    else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    const a0 = 1 + al;
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = (-2 * cw) / a0; this.a2 = (1 - al) / a0;
  }
  run(ch, x) {
    if (this.bypass) return x;
    const z = this.z[ch];
    const y = this.b0 * x + z[0];
    z[0] = this.b1 * x - this.a1 * y + z[1];
    z[1] = this.b2 * x - this.a2 * y;
    return y;
  }
}

// xorshift32 — seeded so a print is reproducible
class Rng {
  constructor(seed) { this.s = (seed >>> 0) || 0x9e3779b9; }
  next() { let r = this.s; r = (r ^ (r << 13)) >>> 0; r = (r ^ (r >>> 17)) >>> 0; r = (r ^ (r << 5)) >>> 0; this.s = r; return r; }
  unit() { return this.next() / 4294967296; }
  bit() { return (this.next() & 1) !== 0; }
}

function seedFromString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h || 1;
}

// --- stage base: band scoping + engagement slew + mix -------------------------
class Stage {
  constructor(id, rngSeed) {
    this.id = id;
    this.rng = new Rng(rngSeed);
    this.hp = new Biquad();
    this.lp = new Biquad();
    this.eng = 0; // engagement 0..1, slewed
    this.block = null; // active block (page object) or null
    this.key = null; // stable block identity (stage + start cell) — pattern re-sends make new objects
    this.blockPass = -1;
    this.rungCount = 0; // accumulator fire count read at entry
    this.vals = null; // effective values for this quantum (after accumulator)
    this.lastLo = -1; this.lastHi = -1;
    this.band = [0, 0];
    this.rest = [0, 0];
  }
  // called once per quantum with the block under the playhead (or null).
  // `entering` = the playhead just entered this block (or re-entered it on
  // a new pass) — stages that run a cycle (glitch) re-arm on it.
  prepare(key, block, vals, entering) {
    this.block = block;
    this.key = key;
    // keep the last values while engagement decays out of a block
    if (vals) this.vals = vals;
    if (entering || (!block && this.wasBlock)) this.onBlockChange(block);
    this.wasBlock = !!block;
    if (!vals) return;
    if (vals.lo !== this.lastLo) { this.hp.set('hp', ladder(LO_LADDER, vals.lo), 0.707); this.lastLo = vals.lo; }
    if (vals.hi !== this.lastHi) { this.lp.set('lp', ladder(HI_LADDER, vals.hi), 0.707); this.lastHi = vals.hi; }
  }
  onBlockChange() {}
  // per-sample: x (2ch array in/out). Band-split → process → recombine with
  // mix, scaled by engagement.
  tick(x, pos) {
    const target = this.block ? 1 : 0;
    this.eng += (target - this.eng) * ENG_COEF;
    if (this.eng < 0.0005 && !this.block) { this.idle(x); return; }
    const mix = this.vals ? this.vals.mix : 1;
    const g = this.eng * mix;
    for (let ch = 0; ch < 2; ch++) {
      const dry = x[ch];
      const band = this.lp.run(ch, this.hp.run(ch, dry));
      this.band[ch] = band;
      this.rest[ch] = dry - band;
    }
    this.processBand(this.band, pos);
    for (let ch = 0; ch < 2; ch++) {
      // rest of the spectrum passes; the band crossfades dry→processed
      const bandDry = x[ch] - this.rest[ch];
      x[ch] = this.rest[ch] + bandDry * (1 - g) + this.band[ch] * g;
    }
  }
  idle() {}
  processBand() {}
}
const ENG_COEF = 1 - Math.exp(-1 / (0.002 * sampleRate)); // ~2ms

// --- CRUSH: bits · rate divider · bitrot -------------------------------------
class Crush extends Stage {
  constructor(seed) {
    super('crush', seed);
    this.hold = [0, 0];
    this.holdCount = 0;
    this.dropLeft = 0; // frames of dropout remaining
    this.dropGain = 1;
    this.rotCountdown = 0;
  }
  processBand(b) {
    const v = this.vals;
    const bits = ladder(BITS_LADDER, v.bits);
    const div = ladder(RATE_DIV_LADDER, v.rate);
    const rot = v.rot;
    if (--this.holdCount <= 0) {
      this.holdCount = div;
      const levels = Math.pow(2, bits - 1);
      for (let ch = 0; ch < 2; ch++) {
        let q = Math.round(b[ch] * levels);
        // bitrot: flip a random bit in the held word — crackle scaling with rot²
        if (rot > 0 && this.rng.unit() < rot * rot * 0.35) {
          const bitIdx = Math.floor(this.rng.unit() * Math.max(1, bits - 1));
          q ^= 1 << bitIdx;
        }
        this.hold[ch] = Math.max(-1, Math.min(1, q / levels));
      }
      // dropouts: rot³ chance per ~10ms of a 5–80ms hole
      if (rot > 0 && this.dropLeft <= 0) {
        this.rotCountdown -= div;
        if (this.rotCountdown <= 0) {
          this.rotCountdown = sampleRate * 0.01;
          if (this.rng.unit() < rot * rot * rot * 0.9) this.dropLeft = sampleRate * (0.005 + this.rng.unit() * 0.075);
        }
      }
    }
    const dropTarget = this.dropLeft > 0 ? 0 : 1;
    if (this.dropLeft > 0) this.dropLeft--;
    this.dropGain += (dropTarget - this.dropGain) * 0.02; // ~1ms edge on the hole
    b[0] = this.hold[0] * this.dropGain;
    b[1] = this.hold[1] * this.dropGain;
  }
}

// --- NOISE: the Mörser (texture-worklet port, insert-shaped) -----------------
class Noise extends Stage {
  constructor(seed) {
    super('noise', seed);
    this.svf = [[0, 0], [0, 0]];
    this.dcb = [[0, 0], [0, 0]];
    this.bit = [false, false];
    this.ping = [0, 0];
    this.jit = 0;
    this.nextClock = 0;
    this.xingSign = 0;
    this.xingCount = 0;
    this.frame = 0;
    this.pingLed = [0, 0];
    this.pingDecay = Math.exp(-1 / (0.004 * sampleRate));
  }
  fcoef() {
    const v = this.vals;
    const base = 40 * Math.pow(300, v.cutoff);
    const fc = Math.min(Math.max(base * Math.pow(2, this.jit * v.cv * 2), 30), Math.min(sampleRate * 0.24, 14000));
    return 2 * Math.sin((Math.PI * fc) / (2 * sampleRate));
  }
  asym(x) { return Math.tanh(x + 0.14 * x * x); }
  processBand(b) {
    const v = this.vals;
    const abs = this.frame++;
    const clkInterval = Math.max(4, sampleRate / (0.5 * Math.pow(16000, v.clock)));
    let doTick = false;
    if (v.clocksrc === 'signal') {
      // Spektrum: the band's zero crossings through a /8 divider; silence
      // stops the clock dead
      const cs = 0.5 * (b[0] + b[1]);
      const thr = 0.005 + 0.2 * 0.12;
      const sign = cs > thr ? 1 : cs < -thr ? -1 : 0;
      if (sign !== 0) {
        if (this.xingSign !== 0 && sign !== this.xingSign) {
          if (++this.xingCount >= 8) { this.xingCount = 0; doTick = true; }
        }
        this.xingSign = sign;
      }
    } else if (abs >= this.nextClock) {
      doTick = true;
      this.nextClock = abs + clkInterval;
    }
    if (doTick) {
      for (let ch = 0; ch < 2; ch++) {
        const nb = this.rng.bit();
        if (nb !== this.bit[ch]) { this.ping[ch] = nb ? 1 : -1; this.bit[ch] = nb; this.pingLed[ch] = 1; }
      }
      this.jit = ((this.rng.s >>> 1) & 3) / 1.5 - 1;
    }
    const fCoef = this.fcoef();
    const damp = (r) => 2 * (1 - Math.min(0.98, Math.max(0, r)));
    const q = damp(v.res);
    const inGain = 1 + v.drive * 23;
    const comp = 1 / (1 + v.drive * 1.5);
    for (let ch = 0; ch < 2; ch++) {
      const x = (b[ch] + this.ping[ch] * v.noise * 1.4) * inGain;
      this.ping[ch] *= this.pingDecay;
      let lp = this.svf[ch][0], bp = this.svf[ch][1];
      for (let o = 0; o < 2; o++) {
        const sq = q * (1 + 0.6 * Math.abs(bp));
        lp = (lp + fCoef * bp) * 0.9995;
        const hp = x - lp - sq * bp;
        bp = this.asym(bp + fCoef * hp);
      }
      this.svf[ch][0] = lp; this.svf[ch][1] = bp;
      const raw = v.filter === 'bp' ? bp : lp;
      const d = this.dcb[ch];
      const tap = raw - d[0] + 0.995 * d[1];
      d[0] = raw; d[1] = tap;
      b[ch] = Math.tanh(tap * 2.2 * comp) * 0.9;
    }
  }
}

// --- DRIVE: BOUM modes -------------------------------------------------------
class Drive extends Stage {
  constructor(seed) {
    super('drive', seed);
    this.prevY = [0, 0]; this.postLp = [0, 0]; this.prevX = [0, 0];
    this.drift = [0, Math.PI * 0.37];
  }
  applyMode(input, mode, bias, driveN) {
    switch (mode) {
      case 0: return Math.tanh(input * 0.8);
      case 1: { const bz = input + bias; const y = bz >= 0 ? Math.tanh(bz * 1.4) : Math.tanh(bz * 0.5) * 0.6; return y - bias; }
      case 2: {
        const bz = input + bias;
        let s = bz / (1 + Math.abs(bz * 0.6));
        if (s > 0.75) s = 0.75 + (s - 0.75) * 0.15; else if (s < -0.75) s = -0.75 + (s + 0.75) * 0.15;
        return Math.max(-0.9, Math.min(0.9, s)) - bias;
      }
      default: { const thr = 0.35 * (1 - driveN * 0.95); return Math.abs(input) > thr ? Math.sign(input) * 0.9 : 0; }
    }
  }
  processBand(b) {
    const v = this.vals;
    const mode = Math.max(0, DIST_MODES.indexOf(v.mode));
    const driveN = v.drive;
    const biasN = v.bias * 0.2;
    const asymmetric = mode === 1 || mode === 2;
    const oversample = mode >= 2;
    const mem = DIST_MEMORY[mode], omm = 1 - mem;
    const postLp = DIST_POST_LP[mode], trim = DIST_OUT_TRIM[mode];
    for (let ch = 0; ch < 2; ch++) {
      const dMul = ch ? 1.005 : 1, bMul = ch ? 0.995 : 1;
      const driveLin = (1 + driveN * (DIST_DRIVE_CEIL[mode] - 1)) * dMul;
      const yPre = omm * b[ch] * driveLin + mem * this.prevY[ch];
      const drift = asymmetric ? Math.sin(this.drift[ch]) * 0.002 : 0;
      const bias = asymmetric ? biasN * bMul + drift : 0;
      let y;
      if (oversample) {
        const u0 = (this.prevX[ch] + yPre) * 0.5;
        y = (this.applyMode(u0, mode, bias, driveN) + this.applyMode(yPre, mode, bias, driveN)) * 0.5;
      } else y = this.applyMode(yPre, mode, bias, driveN);
      this.prevX[ch] = yPre;
      if (postLp > 0) { this.postLp[ch] += postLp * (y - this.postLp[ch]); y = this.postLp[ch]; }
      y *= trim;
      this.prevY[ch] = y;
      this.drift[ch] += (2 * Math.PI * (ch ? 0.19 : 0.13)) / sampleRate;
      b[ch] = y;
    }
  }
}

// --- CHOP: clocked or threshold gate -----------------------------------------
class Chop extends Stage {
  constructor(seed) {
    super('chop', seed);
    this.gain = 1;
    this.env = 0;
    this.envRelease = Math.exp(-1 / (0.025 * sampleRate));
  }
  processBand(b, pos) {
    const v = this.vals;
    let open;
    if (v.src === 'thresh') {
      const a = Math.max(Math.abs(b[0]), Math.abs(b[1]));
      this.env = a > this.env ? a : this.env * this.envRelease;
      const thrDb = -(1 - v.thresh) * 60;
      open = this.env > Math.pow(10, thrDb / 20);
    } else {
      // file-locked clock: period in grid cells, phase from the playhead
      const period = Math.max(8, ladder(CHOP_PERIOD_LADDER, v.period) * this.cellFrames);
      const ph = (pos % period) / period;
      open = ph < v.duty;
    }
    const target = open ? 1 : 0;
    const edgeFrames = v.edge < 0.02 ? 1 : v.edge * 0.04 * sampleRate;
    const coef = Math.min(1, 1 / edgeFrames);
    this.gain += (target - this.gain) * (coef >= 1 ? 1 : coef * 3);
    b[0] *= this.gain;
    b[1] *= this.gain;
  }
}

// --- GLITCH: capture + repeat, per-block mode ---------------------------------
// A trigger = the start of a capture cycle. Dice roll per trigger: hit →
// record one slice while passing it live, then replay it `count` times in
// the block's mode; miss → dry passes for one slice, then re-roll. Slice
// edges get a ~2ms fade so repeats don't click.
class Glitch extends Stage {
  constructor(seed) {
    super('glitch', seed);
    this.cap = [new Float32Array(sampleRate * 8), new Float32Array(sampleRate * 8)];
    this.capLen = 0;
    this.phase = 'idle'; // idle · record · repeat · miss
    this.i = 0; // frame within the slice / repeat
    this.rep = 0; // repeat index
    this.read = 0; // fractional read position for pitched modes
    this.rate = 1;
    this.shufOff = 0;
    this.fade = 0; // output crossfade on phase transitions
  }
  onBlockChange(block) {
    // a fresh block re-arms: a new capture starts at its first frame
    this.phase = block ? 'arm' : 'idle';
    this.rep = 0;
  }
  trigger() {
    const v = this.vals;
    if (this.rng.unit() < v.chance) {
      this.capLen = Math.max(64, Math.round(ladder(GLITCH_LEN_LADDER, v.len) * this.cellFrames));
      this.capLen = Math.min(this.capLen, this.cap[0].length);
      this.phase = 'record';
      this.i = 0;
    } else {
      // miss: the running effect ends, dry passes for one slice
      this.capLen = Math.max(64, Math.round(ladder(GLITCH_LEN_LADDER, v.len) * this.cellFrames));
      this.phase = 'miss';
      this.i = 0;
    }
  }
  startRepeats() {
    const v = this.vals;
    this.phase = 'repeat';
    this.rep = 0;
    this.count = 1 + Math.round(v.count * 15);
    this.startRep();
  }
  startRep() {
    const v = this.vals;
    const mode = v.mode;
    const oct = ladder(PITCH_LADDER, v.pitch);
    let rate = Math.pow(2, oct);
    if (mode === 'octup') rate *= 2;
    if (mode === 'octdn') rate *= 0.5;
    if (mode === 'tapestop') rate *= Math.max(0, 1 - this.rep / Math.max(1, this.count));
    this.rate = rate;
    this.read = mode === 'reverse' ? this.capLen - 1 : 0;
    if (mode === 'shuffle') {
      // each repeat plays a random sub-slice (¼ to 1 of the capture)
      const sub = Math.max(64, Math.round(this.capLen * (0.25 + 0.75 * this.rng.unit())));
      this.shufOff = Math.floor(this.rng.unit() * (this.capLen - sub));
      this.subLen = sub;
    } else this.subLen = this.capLen;
    this.i = 0;
  }
  processBand(b) {
    if (this.phase === 'arm') this.trigger();
    const fadeF = Math.min(0.002 * sampleRate, this.capLen * 0.1);
    if (this.phase === 'record') {
      this.cap[0][this.i] = b[0];
      this.cap[1][this.i] = b[1];
      if (++this.i >= this.capLen) this.startRepeats();
      return; // live pass while recording
    }
    if (this.phase === 'miss') {
      if (++this.i >= this.capLen) this.trigger();
      return;
    }
    if (this.phase !== 'repeat') return;
    const v = this.vals;
    if (v.mode === 'silence') { b[0] = 0; b[1] = 0; }
    else if (v.mode === 'tapestop' && this.rate <= 0.001) { b[0] = 0; b[1] = 0; }
    else {
      // edge fade within the repeat window
      const e = Math.min(1, this.i / fadeF, (this.subLen - this.i) / fadeF);
      const rp = this.shufOff + this.read;
      const i0 = Math.max(0, Math.min(this.capLen - 1, rp | 0));
      const i1 = Math.min(this.capLen - 1, i0 + 1);
      const fr = rp - i0;
      for (let ch = 0; ch < 2; ch++) {
        const c = this.cap[ch];
        b[ch] = (c[i0] + (c[i1] - c[i0]) * fr) * Math.max(0, e);
      }
      if (v.mode === 'reverse') { this.read -= this.rate; if (this.read < 0) this.read += this.subLen; }
      else { this.read += this.rate; if (this.read >= this.subLen) this.read -= this.subLen; }
    }
    if (++this.i >= this.subLen) {
      if (++this.rep >= this.count) this.trigger();
      else this.startRep();
    }
  }
}

// --- FEEDBACK: out → back in, delayed, toned, runaway past 100 -----------------
class Feedback extends Stage {
  constructor(seed) {
    super('feedback', seed);
    this.line = [new Float32Array(sampleRate), new Float32Array(sampleRate)];
    this.w = 0;
    this.toneLp = [0, 0];
  }
  processBand(b) {
    const v = this.vals;
    const amt = v.amount * 1.2;
    const dFrames = Math.max(1, Math.round((ladder(FB_DELAY_LADDER, v.delay) / 1000) * sampleRate));
    const toneHz = 200 * Math.pow(60, v.tone);
    const tc = 1 - Math.exp((-2 * Math.PI * toneHz) / sampleRate);
    const N = this.line[0].length;
    for (let ch = 0; ch < 2; ch++) {
      const r = (this.w - dFrames + N) % N;
      const fb = this.line[ch][r];
      this.toneLp[ch] += (fb - this.toneLp[ch]) * tc;
      // soft clip in the loop keeps runaway bounded — it howls, it doesn't blow up
      const y = Math.tanh(b[ch] + this.toneLp[ch] * amt);
      this.line[ch][this.w] = y;
      b[ch] = y;
    }
    this.w = (this.w + 1) % N;
  }
}

// --- the processor -----------------------------------------------------------
class NoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufL = null; this.bufR = null; this.len = 0;
    this.pos = 0;
    this.pass = 0;
    this.playing = false;
    this.vizOn = true;
    this.vizCount = 0;
    this.authored = null; // what the page drew (blocks in file fractions, with ids)
    this.pattern = null; // the LIVE pattern: authored geometry, mutated per pass
    this.mutRng = new Rng(1);
    this.seed = 1;
    this.stages = null;
    this.fires = new Map(); // block key → fire count (accumulator)
    this.x = [0, 0];
    this.buildStages();
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  buildStages() {
    const base = this.seed;
    this.stages = {
      crush: new Crush(base ^ 0x1111), noise: new Noise(base ^ 0x2222), drive: new Drive(base ^ 0x3333),
      chop: new Chop(base ^ 0x4444), glitch: new Glitch(base ^ 0x5555), feedback: new Feedback(base ^ 0x6666),
    };
  }

  onMessage(m) {
    switch (m.type) {
      case 'buffer':
        this.bufL = m.l; this.bufR = m.r; this.len = m.l.length;
        this.pos = 0;
        this.port.postMessage({ type: 'ready' });
        break;
      case 'pattern':
        if (m.p.seed) {
          const s = seedFromString(m.p.seed);
          if (s !== this.seed) { this.seed = s; this.buildStages(); this.mutRng = new Rng(s ^ 0x7777); }
        }
        this.applyAuthored(m.p);
        break;
      case 'play':
        this.playing = m.on;
        if (m.on) this.reset();
        break;
      case 'vizOn':
        this.vizOn = m.on;
        break;
    }
  }

  // fresh run: playhead home, generation 0, accumulators cleared, stages
  // re-seeded, live pattern back to the authored one
  reset() {
    this.pos = 0;
    this.pass = 0;
    this.fires.clear();
    this.buildStages();
    this.mutRng = new Rng(this.seed ^ 0x7777);
    if (this.authored) this.pattern = this.cloneAuthored(this.authored);
    this.postLive();
  }

  cloneAuthored(p) {
    return {
      grid: p.grid,
      lanes: p.lanes.map((l) => ({
        stage: l.stage, on: l.on, vals: l.vals,
        blocks: l.blocks.map((b) => ({ id: b.id, src: b.id, a: b.a, b: b.b, vals: b.vals, acc: b.acc })),
      })),
    };
  }

  // A new authored pattern arrives on every edit. Keep the live geometry
  // (mutation so far) but refresh each block's settings from its authored
  // source; add blocks the page drew since, drop blocks it erased. A grid
  // change resets the live pattern — cells moved under it.
  applyAuthored(p) {
    const prev = this.authored;
    this.authored = p;
    if (!this.pattern || !prev || prev.grid !== p.grid) { this.pattern = this.cloneAuthored(p); this.postLive(); return; }
    for (let i = 0; i < p.lanes.length; i++) {
      const al = p.lanes[i], ll = this.pattern.lanes[i];
      ll.on = al.on; ll.vals = al.vals;
      const byId = new Map(al.blocks.map((b) => [b.id, b]));
      ll.blocks = ll.blocks.filter((b) => byId.has(b.src));
      for (const b of ll.blocks) { const a = byId.get(b.src); b.vals = a.vals; b.acc = a.acc; }
      const liveSrc = new Set(ll.blocks.map((b) => b.src));
      for (const a of al.blocks) if (!liveSrc.has(a.id)) ll.blocks.push({ id: a.id, src: a.id, a: a.a, b: a.b, vals: a.vals, acc: a.acc });
      ll.blocks.sort((x, y) => x.a - y.a);
    }
    this.postLive();
  }

  postLive() {
    if (!this.pattern) return;
    this.port.postMessage({
      type: 'live', pass: this.pass,
      lanes: this.pattern.lanes.map((l) => ({ stage: l.stage, blocks: l.blocks.map((b) => ({ id: b.id, src: b.src, a: b.a, b: b.b })) })),
    });
  }

  // One generation step, at the wrap. Per lane, MUTATE is the probability
  // mass: blocks shift or resize by a cell, occasionally split; removal is
  // easier than addition (Sequence's tie-flip asymmetry) so a lane thins
  // rather than saturates.
  mutate() {
    const p = this.pattern;
    const grid = p.grid, cell = 1 / grid;
    const rng = this.mutRng;
    const snap = (v) => Math.round(v * grid) / grid;
    let changed = false;
    for (const lane of p.lanes) {
      const m = lane.vals.mutate || 0;
      if (m <= 0 || lane.blocks.length === 0) continue;
      const next = [];
      for (const b of lane.blocks) {
        const r = rng.unit();
        if (r < m * 0.2 && lane.blocks.length > 1) { changed = true; continue; } // remove
        let a = b.a, e = b.b;
        if (rng.unit() < m * 0.5) { const d = rng.bit() ? cell : -cell; a = snap(a + d); e = snap(e + d); changed = true; } // shift
        if (rng.unit() < m * 0.4) { if (rng.bit()) e = snap(e + (rng.bit() ? cell : -cell)); else a = snap(a + (rng.bit() ? cell : -cell)); changed = true; } // resize
        a = Math.max(0, a); e = Math.min(1, e);
        if (e - a < cell * 0.5) { e = Math.min(1, a + cell); if (e - a < cell * 0.5) a = e - cell; }
        if (rng.unit() < m * 0.15 && e - a >= 2 * cell) { // split
          const cut = snap(a + cell * (1 + Math.floor(rng.unit() * Math.round((e - a) / cell - 1))));
          if (cut > a && cut < e) {
            next.push({ ...b, a, b: cut });
            next.push({ ...b, id: `${b.id}.${this.pass}`, a: cut, b: e });
            changed = true;
            continue;
          }
        }
        next.push({ ...b, a, b: e });
      }
      // rare add: a one-cell block on an empty cell
      if (rng.unit() < m * 0.08) {
        const c = Math.floor(rng.unit() * grid) * cell;
        if (!next.some((b) => c >= b.a && c < b.b)) {
          const parent = next[Math.floor(rng.unit() * next.length)] || lane.blocks[0];
          next.push({ ...parent, id: `${parent.id}+${this.pass}`, a: c, b: c + cell });
          changed = true;
        }
      }
      // merge overlaps
      next.sort((x, y) => x.a - y.a);
      const out = [];
      for (const b of next) { const last = out[out.length - 1]; if (last && b.a < last.b) last.b = Math.max(last.b, b.b); else out.push(b); }
      lane.blocks = out;
    }
    if (changed) this.postLive();
  }

  // the block under `frac` in a lane, or null
  blockAt(lane, frac) {
    for (const b of lane.blocks) if (frac >= b.a && frac < b.b) return b;
    return null;
  }

  // block values with the accumulator applied: each fire of the block adds
  // `step` rungs to the target knob, turning per shape
  effectiveVals(block, count) {
    const acc = block.acc;
    if (!acc || acc.shape === 'off' || !acc.target) return block.vals;
    const range = 1 + Math.round(acc.range * 7);
    const stepRungs = Math.round((acc.step - 0.5) * 8);
    let rung;
    if (range <= 1) rung = 0;
    else if (acc.shape === 'hold') rung = Math.min(count, range - 1);
    else if (acc.shape === 'bounce') { const period = 2 * (range - 1); const p = count % period; rung = p < range ? p : period - p; }
    else rung = count % range;
    const steps = KNOB_STEPS[acc.target];
    const unit = steps ? 1 / (steps - 1) : 0.1;
    const v = { ...block.vals };
    v[acc.target] = clamp01(block.vals[acc.target] + rung * stepRungs * unit);
    return v;
  }

  process(inputs, outputs) {
    const outL = outputs[0][0], outR = outputs[0][1];
    const n = outL.length;
    if (!this.playing || !this.bufL || !this.pattern) {
      outL.fill(0); outR.fill(0);
      return true;
    }
    const len = this.len;
    const cellFrames = len / this.pattern.grid;
    // resolve the block under the playhead per stage for this quantum
    const frac = this.pos / len;
    const laneById = {};
    for (const lane of this.pattern.lanes) laneById[lane.stage] = lane;
    for (const id of STAGE_ORDER) {
      const st = this.stages[id];
      const lane = laneById[id];
      st.cellFrames = cellFrames;
      if (!lane || !lane.on) { st.prepare(null, null, null, false); continue; }
      const block = this.blockAt(lane, frac);
      if (!block) { st.prepare(null, null, null, false); continue; }
      const key = `${id}:${block.id}`;
      // the block FIRES when the playhead enters it, and again on every new
      // pass. First entry reads rung 0 (home); the count advances after the
      // read (accumulator.ts consumeStepAccRung) and holds for the block.
      const entering = st.key !== key || st.blockPass !== this.pass;
      if (entering) {
        st.rungCount = this.fires.get(key) || 0;
        this.fires.set(key, st.rungCount + 1);
      }
      st.blockPass = this.pass;
      st.prepare(key, block, this.effectiveVals(block, st.rungCount), entering);
    }
    const x = this.x;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const p = this.pos;
      x[0] = this.bufL[p]; x[1] = this.bufR[p];
      for (const id of STAGE_ORDER) this.stages[id].tick(x, p);
      outL[i] = x[0]; outR[i] = x[1];
      const a = Math.abs(x[0]); if (a > peak) peak = a;
      if (++this.pos >= len) {
        this.pos = 0;
        this.pass++;
        this.mutate();
        this.port.postMessage({ type: 'pass', pass: this.pass });
      }
    }
    if (this.vizOn && (this.vizCount += n) >= sampleRate / 30) {
      this.vizCount = 0;
      const eng = {};
      for (const id of STAGE_ORDER) eng[id] = this.stages[id].eng;
      const ns = this.stages.noise;
      this.port.postMessage({ type: 'viz', pos: this.pos / len, pass: this.pass, eng, peak, pingL: ns.pingLed[0], pingR: ns.pingLed[1] });
      ns.pingLed[0] = 0; ns.pingLed[1] = 0;
    }
    return true;
  }
}

registerProcessor('noise', NoiseProcessor);
