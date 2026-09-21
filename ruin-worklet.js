// ruin-worklet — the EP listening room's player + "ruin" stage.
//
// The worklet PLAYS the record itself from a decoded buffer (like glitch and
// decay do) rather than sitting on an <audio> element: that is what makes
// tape-style speed possible in every browser (elements mute at extreme rates
// in Safari/Firefox) and what lets the offline print be the same code path as
// the live stream, sample for sample.
//
// Every ruin decision is POSITIONAL — hashed from (seed, cell index in the
// record) rather than drawn from a running RNG — so live, print and a shared
// {seed, amount} agree. Cells are 16ths at the track tempo, in RECORD time:
// slow the record down and the holes stretch with it.
//
// Stages:
//   HOLES  — per cell, a dice roll opens a gap; gaps lengthen with amount and
//            past ~0.85 start swallowing whole cells, then runs of them.
//   CRUSH  — per 4-cell block, a dice roll engages a bit/rate crush whose
//            depth is drawn per block; bitrot crackle rides in above ~0.6.
// Reverb lives outside, in a ConvolverNode with a seeded impulse.
//
// messages in:
//   { type:'buffer', l, r, sr }         the decoded record (Float32Arrays)
//   { type:'set', amount?, seed?, bpm?, speed? }   → replies { type:'ack' }
//   { type:'play', on }                 transport
//   { type:'seek', frame }              record frame (may be negative: pre-roll silence)
// messages out:
//   { type:'ack' }                      after every 'set' (offline prints wait for it)
//   { type:'pos', frame }               ~20×/s while playing
//   { type:'ended' }                    once, when the record runs out

function hash(seed, a, b) {
  let h = (seed ^ Math.imul((a + 0x9e3779b9) | 0, 0x85ebca6b) ^ Math.imul((b + 0x27d4eb2f) | 0, 0xc2b2ae35)) | 0;
  h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
function seedFromString(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h || 1;
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 4-point Hermite — slowed playback wants better than linear
function readHermite(buf, pos) {
  const i = Math.floor(pos), f = pos - i, n = buf.length;
  if (i < 0 || i >= n) return 0;
  const xm1 = i > 0 ? buf[i - 1] : buf[i];
  const x0 = buf[i];
  const x1 = i + 1 < n ? buf[i + 1] : x0;
  const x2 = i + 2 < n ? buf[i + 2] : x1;
  const c = (x1 - xm1) * 0.5;
  const v = x0 - x1;
  const w = c + v;
  const a = w + v + (x2 - x0) * 0.5;
  const b = w + a;
  return ((a * f - b) * f + c) * f + x0;
}

class RuinProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufL = null; this.bufR = null; this.len = 0; this.bufSr = sampleRate;
    this.pos = 0;            // record frame (fractional)
    this.playing = false;
    this.ended = false;
    this.speed = 1;
    this.amount = 0;
    this.seed = 1;
    this.bpm = 120;
    this.cellFrames = 1;
    this.lastCell = -1; this.lastBlock = -1;
    // holes
    this.holeStart = -1; this.holeEnd = -1; this.gain = 1;
    // crush
    this.crushOn = false; this.crushMix = 0; this.bits = 12; this.div = 1;
    this.hold = [0, 0]; this.holdCount = 0; this.holdIdx = 0; this.rot = 0;
    this.slew = 1 - Math.exp(-1 / (0.004 * sampleRate)); // ~4ms engage
    this.edge = 1 - Math.exp(-1 / (0.0012 * sampleRate)); // ~1ms hole edge
    this.posCount = 0;
    this.port.onmessage = (e) => {
      const m = e.data;
      switch (m.type) {
        case 'buffer':
          this.bufL = m.l; this.bufR = m.r || m.l; this.len = this.bufL.length; this.bufSr = m.sr || sampleRate;
          this.recalcCell(); this.ended = false;
          break;
        case 'set':
          if (m.amount != null) this.amount = clamp(+m.amount || 0, 0, 1);
          if (m.seed != null) this.seed = typeof m.seed === 'string' ? seedFromString(m.seed) : (m.seed >>> 0) || 1;
          if (m.bpm) { this.bpm = m.bpm; this.recalcCell(); }
          if (m.speed != null) this.speed = clamp(+m.speed || 1, 0.03125, 4);
          this.lastCell = -1; this.lastBlock = -1; // re-decide the current cell with the new settings
          this.port.postMessage({ type: 'ack' });
          break;
        case 'play':
          this.playing = !!m.on;
          if (this.playing && this.ended) { this.pos = 0; this.ended = false; }
          break;
        case 'seek':
          this.pos = +m.frame || 0; this.ended = false;
          this.lastCell = -1; this.lastBlock = -1; this.holeStart = this.holeEnd = -1;
          break;
      }
    };
  }
  recalcCell() { this.cellFrames = Math.max(64, Math.round(this.bufSr * 60 / this.bpm / 4)); }

  decideCell(cell) {
    const a = this.amount, cf = this.cellFrames, s = this.seed;
    // HOLES: probability and length both climb with amount on steep curves,
    // so the first two-thirds of the knob stays an edit and the collapse is
    // packed into the last stretch — the top is still deliberately broken.
    const pHole = 0.022 + Math.pow(a, 2.2) * 0.6; // floor: a hole every few seconds at any nonzero amount
    if (hash(s, cell, 1) < pHole) {
      let lenFrac = 0.12 + Math.pow(hash(s, cell, 3), 0.7) * (0.15 + Math.pow(a, 1.5) * 0.7);
      if (a > 0.85) lenFrac += (a - 0.85) * 10 * hash(s, cell, 8); // runs of cells
      const len = Math.round(cf * lenFrac);
      const room = Math.max(0, cf - Math.min(len, cf));
      const start = cell * cf + Math.round(hash(s, cell, 2) * room);
      if (start + len > this.holeEnd) { this.holeStart = start; this.holeEnd = start + len; }
    }
    // CRUSH: decided per 4-cell block so it holds for a beat, flickering in
    // and out against the holes rather than moving with them.
    const block = Math.floor(cell / 4);
    if (block !== this.lastBlock) {
      this.lastBlock = block;
      const pCrush = Math.pow(a, 1.8) * 0.7;
      this.crushOn = a > 0 && hash(s, block, 4) < pCrush;
      if (this.crushOn) {
        const depth = Math.pow(hash(s, block, 5), 0.6) * Math.pow(a, 1.4); // 0..a^1.4
        this.bits = clamp(Math.round(12 - depth * 10), 2, 12);
        this.div = 1 + Math.round(depth * 23 * hash(s, block, 6)); // 1..24
        this.rot = a > 0.6 ? Math.pow((a - 0.6) * 2.5, 2) * 0.4 : 0;
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const oL = out[0], oR = out[1] || out[0];
    const n = oL.length;
    if (!this.playing || !this.bufL) {
      oL.fill(0); if (oR !== oL) oR.fill(0);
      return true;
    }
    const step = this.speed * (this.bufSr / sampleRate); // record frames per output sample
    const cf = this.cellFrames;
    const ruinOn = this.amount > 0;
    for (let i = 0; i < n; i++) {
      const pos = this.pos;
      let l = 0, r = 0;
      if (pos >= 0 && pos < this.len) {
        l = readHermite(this.bufL, pos);
        r = readHermite(this.bufR, pos);
        if (ruinOn) {
          const cell = Math.floor(pos / cf);
          if (cell !== this.lastCell) { this.lastCell = cell; this.decideCell(cell); }
          // CRUSH
          const mixTarget = this.crushOn ? 1 : 0;
          this.crushMix += (mixTarget - this.crushMix) * this.slew;
          if (this.crushMix > 1e-3) {
            if (--this.holdCount <= 0) {
              this.holdCount = this.div;
              this.holdIdx++;
              const levels = Math.pow(2, this.bits - 1);
              let ql = Math.round(l * levels), qr = Math.round(r * levels);
              if (this.rot > 0 && hash(this.seed, this.holdIdx, 7) < this.rot * 0.35) {
                const bit = 1 << Math.floor(hash(this.seed, this.holdIdx, 9) * Math.max(1, this.bits - 1));
                ql ^= bit; qr ^= bit;
              }
              this.hold[0] = clamp(ql / levels, -1, 1);
              this.hold[1] = clamp(qr / levels, -1, 1);
            }
            const m = this.crushMix;
            l = l * (1 - m) + this.hold[0] * m;
            r = r * (1 - m) + this.hold[1] * m;
          }
          // HOLES
          const inHole = pos >= this.holeStart && pos < this.holeEnd;
          this.gain += ((inHole ? 0 : 1) - this.gain) * this.edge;
          l *= this.gain; r *= this.gain;
        }
      }
      oL[i] = l; oR[i] = r;
      this.pos += step;
    }
    if (this.pos >= this.len && !this.ended) {
      this.ended = true; this.playing = false;
      this.port.postMessage({ type: 'ended' });
    }
    this.posCount += n;
    if (this.posCount >= sampleRate / 20) { this.posCount = 0; this.port.postMessage({ type: 'pos', frame: this.pos }); }
    return true;
  }
}

registerProcessor('ruin', RuinProcessor);
