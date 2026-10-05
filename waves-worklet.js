// waves-worklet.js — polyphonic wave-sequence voice for waves.html.
//
// Each held note is a voice that plays a single-cycle wave at the note's
// pitch and steps through the page's wave sequence on ITS OWN clock: step
// lengths are milliseconds, rolled per step (jitter) and scaled per voice
// (drift), counted from that voice's note-on. Nothing is quantized to a
// shared grid — a chord's voices start together and walk apart, and no two
// steps are quite the same length. The last XFADE share of every step morphs
// toward the next wave (smoothstep, never shorter than MIN_XF_MS so a hard
// step doesn't click).
//
// Waves arrive pre-band-limited as mip levels (level i keeps harmonics
// ≤ 1024 >> i); a voice reads the richest level that stays under Nyquist at
// its pitch. Library waves are phase-aligned, so a morph between any two is
// a timbre blend rather than a comb-filtered dip.
//
// messages in:  bank-add {waves:[{levels:[Float32Array 2048 × 11]}]} —
//               the bank only grows, so a steps message can never point at
//               a wave this side hasn't received
//               steps {steps:[bankIndex…]} · params {p} · on {note, vel}
//               off {note} · panic
// messages out: viz {voices:[{note, idx, frac, env}]} at ~30 Hz

const FRAMES = 2048;
const LEVELS = 11;
const MAX_VOICES = 24;
const MIN_XF_MS = 1.5;

function makeVoice() {
  return {
    active: false, note: 0, vel: 0, freq: 0, phase: 0,
    gate: false, env: 0, stage: 0, age: 0,
    idx: 0, stepPos: 0, stepLen: 1, rate: 1,
    panL: 0.7, panR: 0.7, ic1: 0, ic2: 0, lvl: 0,
  };
}

class WavesProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bank = [];
    this.steps = [];
    this.voices = Array.from({ length: MAX_VOICES }, makeVoice);
    this.p = {
      stepMs: 180, jitter: 0.35, xfade: 0.5, drift: 0.3,
      attack: 0.01, release: 0.6, cutoff: 6000, res: 0.2, level: 0.8,
    };
    this.cut = this.p.cutoff;
    this.ageCounter = 0;
    this.vizEvery = Math.round(sampleRate / 30 / 128);
    this.blocks = 0;
    this.port.onmessage = (e) => this.onMsg(e.data);
  }

  onMsg(m) {
    if (m.type === 'bank-add') this.bank.push(...m.waves);
    else if (m.type === 'steps') this.steps = m.steps;
    else if (m.type === 'params') Object.assign(this.p, m.p);
    else if (m.type === 'on') this.noteOn(m.note, m.vel ?? 0.8);
    else if (m.type === 'off') this.noteOff(m.note);
    else if (m.type === 'panic') for (const v of this.voices) { v.active = false; v.gate = false; }
  }

  rollStep(v) {
    const j = this.p.jitter;
    const jit = Math.pow(2, j * 1.6 * (2 * Math.random() - 1));
    v.stepLen = Math.max(8, (this.p.stepMs * sampleRate / 1000) * v.rate * jit);
    v.stepPos = 0;
  }

  noteOn(note, vel) {
    // Free voice, else the quietest releasing one, else the oldest.
    let v = this.voices.find((x) => !x.active);
    if (!v) {
      const rel = this.voices.filter((x) => !x.gate);
      v = rel.length
        ? rel.reduce((a, b) => (a.env < b.env ? a : b))
        : this.voices.reduce((a, b) => (a.age < b.age ? a : b));
    }
    const d = this.p.drift;
    // A stolen voice keeps its env level + filter state (retriggers from where
    // it is, no click); a free one starts from silence.
    if (!v.active) { v.env = 0; v.ic1 = 0; v.ic2 = 0; }
    Object.assign(v, {
      active: true, note, vel, gate: true, stage: 1, age: ++this.ageCounter,
      freq: 440 * Math.pow(2, (note - 69) / 12), phase: Math.random(),
      idx: 0, rate: Math.pow(2, d * (2 * Math.random() - 1)),
    });
    const pan = (Math.random() * 2 - 1) * 0.35;
    v.panL = Math.cos((pan + 1) * Math.PI / 4);
    v.panR = Math.sin((pan + 1) * Math.PI / 4);
    // Richest mip level whose top harmonic stays under Nyquist at this pitch.
    const maxH = Math.max(1, Math.floor(sampleRate / 2 / v.freq));
    v.lvl = Math.min(LEVELS - 1, Math.max(0, Math.ceil(Math.log2(1024 / maxH))));
    this.rollStep(v);
  }

  noteOff(note) {
    for (const v of this.voices) if (v.active && v.gate && v.note === note) { v.gate = false; v.stage = 3; }
  }

  process(_in, outputs) {
    const out = outputs[0];
    const L = out[0], R = out[1] || out[0];
    const n = L.length;
    L.fill(0);
    if (R !== L) R.fill(0);
    const nSteps = this.steps.length;
    const p = this.p;

    // Cutoff glides per block (one-pole on Hz) so knob moves don't zipper.
    this.cut += (p.cutoff - this.cut) * 0.25;
    const g = Math.tan(Math.PI * Math.min(this.cut, sampleRate * 0.45) / sampleRate);
    const k = 2 - 1.98 * p.res;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const atkInc = 1 / Math.max(1, p.attack * sampleRate);
    const relCoef = Math.exp(-5 / Math.max(1, p.release * sampleRate));
    const minXf = MIN_XF_MS * sampleRate / 1000;

    if (nSteps && this.bank.length) {
      const bank = this.bank, steps = this.steps;
      for (const v of this.voices) {
        if (!v.active) continue;
        if (v.idx >= nSteps) v.idx %= nSteps;
        const inc = v.freq / sampleRate, lvl = v.lvl, amp = v.vel;
        // Locals for the hot loop; written back after the block.
        let env = v.env, stage = v.stage, phase = v.phase, ic1 = v.ic1, ic2 = v.ic2;
        let ta = bank[steps[v.idx]].levels[lvl];
        let tb = bank[steps[(v.idx + 1) % nSteps]].levels[lvl];
        let xf = Math.min(v.stepLen, Math.max(minXf, p.xfade * v.stepLen));
        let xfStart = v.stepLen - xf, xfInv = 1 / xf;
        for (let i = 0; i < n; i++) {
          if (stage === 1) { env += atkInc; if (env >= 1) { env = 1; stage = 2; } }
          else if (stage === 3) {
            env *= relCoef;
            if (env < 1e-4) { v.active = false; break; }
          }
          // step clock (voice-local, ms-based, never on a grid)
          if (v.stepPos >= v.stepLen) {
            v.idx = (v.idx + 1) % nSteps;
            this.rollStep(v);
            ta = tb;
            tb = bank[steps[(v.idx + 1) % nSteps]].levels[lvl];
            xf = Math.min(v.stepLen, Math.max(minXf, p.xfade * v.stepLen));
            xfStart = v.stepLen - xf;
            xfInv = 1 / xf;
          }
          const pos = phase * FRAMES;
          const i0 = pos | 0, fr = pos - i0, i1 = (i0 + 1) & (FRAMES - 1);
          let s = ta[i0] + (ta[i1] - ta[i0]) * fr;
          const into = v.stepPos - xfStart;
          if (into > 0) {
            const b = tb[i0] + (tb[i1] - tb[i0]) * fr;
            const t = into * xfInv;
            s += (b - s) * (t * t * (3 - 2 * t)); // smoothstep morph
          }
          v.stepPos++;
          phase += inc;
          if (phase >= 1) phase -= 1;
          // TPT state-variable lowpass
          const v3 = s - ic2;
          const v1 = a1 * ic1 + a2 * v3;
          const v2 = ic2 + a2 * ic1 + a3 * v3;
          ic1 = 2 * v1 - ic1;
          ic2 = 2 * v2 - ic2;
          const y = v2 * env * amp;
          L[i] += y * v.panL;
          if (R !== L) R[i] += y * v.panR;
        }
        v.env = env; v.stage = stage; v.phase = phase; v.ic1 = ic1; v.ic2 = ic2;
      }
    }

    const gain = p.level * 0.5;
    for (let i = 0; i < n; i++) {
      L[i] = Math.tanh(L[i] * gain);
      if (R !== L) R[i] = Math.tanh(R[i] * gain);
    }

    if (++this.blocks >= this.vizEvery) {
      this.blocks = 0;
      const voices = [];
      for (const v of this.voices) {
        if (!v.active) continue;
        const xf = Math.min(v.stepLen, Math.max(minXf, p.xfade * v.stepLen));
        const into = v.stepPos - (v.stepLen - xf);
        voices.push({
          note: v.note, idx: v.idx, frac: Math.min(1, v.stepPos / v.stepLen),
          mix: into > 0 ? (t => t * t * (3 - 2 * t))(Math.min(1, into / xf)) : 0,
          env: v.env, phase: v.phase,
        });
      }
      this.port.postMessage({ type: 'viz', voices });
    }
    return true;
  }
}

registerProcessor('waves', WavesProcessor);
