// ruin-worklet — the EP listening room's "ruin" stage.
//
// One insert on the record: clean at amount 0, wrecked at 1. Every decision is
// POSITIONAL — hashed from (seed, cell index) rather than drawn from a running
// RNG — so the live stream and the offline print of the same track make the
// same wreck at the same moment, and a shared {seed, amount} reproduces it on
// anyone's machine. The room keeps the worklet's playhead honest with 'sync'
// messages (the <audio> element's currentTime); seeking just snaps the clock.
//
// Cells are 16ths at the track tempo, so the holes fall on the grid and read
// as edits rather than dropouts. Two stages in this increment:
//   HOLES  — per cell, a dice roll opens a gap; gaps lengthen with amount and
//            past ~0.7 start swallowing whole cells, then runs of them.
//   CRUSH  — per 4-cell block, a dice roll engages a bit/rate crush whose
//            depth is drawn per block; bitrot crackle rides in above ~0.5.
// Tape wear / stutter are the next stages once this feel is right.
//
// messages in:  { type:'set', amount, seed, bpm }   { type:'sync', frame }
// messages out: { type:'ack' } after every 'set' — an OfflineAudioContext
//               must not start rendering before the settings have landed

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

class RuinProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.amount = 0;
    this.seed = 1;
    this.cellFrames = Math.round(sampleRate * 60 / 120 / 4);
    this.pos = 0;
    this.lastCell = -1;
    this.lastBlock = -1;
    // holes
    this.holeStart = -1; this.holeEnd = -1; this.gain = 1;
    // crush
    this.crushOn = false; this.crushMix = 0; this.bits = 12; this.div = 1;
    this.hold = [0, 0]; this.holdCount = 0; this.holdIdx = 0; this.rot = 0;
    this.slew = 1 - Math.exp(-1 / (0.004 * sampleRate)); // ~4ms engage
    this.edge = 1 - Math.exp(-1 / (0.0012 * sampleRate)); // ~1ms hole edge
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'set') {
        if (m.amount != null) this.amount = clamp(+m.amount || 0, 0, 1);
        if (m.seed != null) this.seed = typeof m.seed === 'string' ? seedFromString(m.seed) : (m.seed >>> 0) || 1;
        if (m.bpm) this.cellFrames = Math.max(64, Math.round(sampleRate * 60 / m.bpm / 4));
        this.lastCell = -1; this.lastBlock = -1; // re-decide the current cell with the new settings
        this.port.postMessage({ type: 'ack' }); // offline prints wait for this before rendering
      } else if (m.type === 'sync') {
        const f = Math.max(0, m.frame | 0);
        if (Math.abs(f - this.pos) > 4096) { this.pos = f; this.lastCell = -1; this.lastBlock = -1; }
      }
    };
  }

  decideCell(cell) {
    const a = this.amount, cf = this.cellFrames, s = this.seed;
    // HOLES: probability and length both climb with amount; the top of the
    // range is deliberately broken — most of the record is gone at 1.
    const pHole = 0.015 + Math.pow(a, 1.5) * 0.7;
    if (hash(s, cell, 1) < pHole) {
      let lenFrac = 0.12 + Math.pow(hash(s, cell, 3), 0.7) * (0.2 + a * 0.8);
      if (a > 0.7) lenFrac += (a - 0.7) * 8 * hash(s, cell, 8); // runs of cells
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
      const pCrush = Math.pow(a, 1.2) * 0.75;
      this.crushOn = a > 0 && hash(s, block, 4) < pCrush;
      if (this.crushOn) {
        const depth = Math.pow(hash(s, block, 5), 0.6) * a;      // 0..a
        this.bits = clamp(Math.round(12 - depth * 10), 2, 12);
        this.div = 1 + Math.round(depth * 23 * hash(s, block, 6)); // 1..24
        this.rot = a > 0.5 ? Math.pow((a - 0.5) * 2, 2) * 0.4 : 0;
      }
    }
  }

  process(inputs, outputs) {
    const inp = inputs[0], out = outputs[0];
    if (!inp || !inp.length) return true;
    const iL = inp[0], iR = inp[1] || inp[0];
    const oL = out[0], oR = out[1] || out[0];
    const n = iL.length;
    if (this.amount <= 0 && this.crushMix < 1e-3 && this.gain > 0.999) {
      oL.set(iL); if (oR !== oL) oR.set(iR);
      this.pos += n;
      return true;
    }
    const cf = this.cellFrames;
    for (let i = 0; i < n; i++) {
      const pos = this.pos + i;
      const cell = Math.floor(pos / cf);
      if (cell !== this.lastCell) { this.lastCell = cell; this.decideCell(cell); }

      let l = iL[i], r = iR[i];
      // CRUSH
      const mixTarget = this.crushOn && this.amount > 0 ? 1 : 0;
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
      oL[i] = l * this.gain;
      oR[i] = r * this.gain;
    }
    this.pos += n;
    return true;
  }
}

registerProcessor('ruin', RuinProcessor);
