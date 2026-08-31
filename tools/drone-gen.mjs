#!/usr/bin/env node
// drone-gen — batch-render additive drone kits for the sample library.
//
// The voice descends from decay.html's demo loop: six sine partials with
// its amplitude rolloff, each breathing on its own slow seeded LFO, right
// channel detuned +0.13% for width — but at harmonic ratios of one
// fundamental, so each file is a single TONE (Sequence voices the chords).
// Parameterized by root note and seed only — transposition is exact (scale
// the partial frequencies), so one voice renders as a full note-named kit
// in the sequencer's auto-manifest convention (<kit>-C2.wav, <kit>-E2.wav,
// <kit>-Gs2.wav, ...).
//
// Unlike the page (where the decay worklet crossfades the loop seam at
// playback), these files must loop clean on their own: the render runs long
// and folds the tail back over the head, so the wrap point is seamless in
// any player.
//
//   node tools/drone-gen.mjs                        # tone kit, random seed
//   node tools/drone-gen.mjs --seed 4f2a            # reproducible
//   node tools/drone-gen.mjs --start C1 --count 9   # note range
//   node tools/drone-gen.mjs --secs 16 --out ~/Desktop/samples
//
// Output: <out>/<kit>/<kit>-<NOTE>.wav — 48k/24-bit stereo, peak -3dBFS,
// kit named drone-<seed>. Audition, then move the folder into the
// library yourself.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// ---- args ---------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] != null ? args[i + 1] : dflt;
};
const SR = 48000;
const SECS = parseFloat(flag('secs', '8'));
const SEED = (flag('seed', Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0'))).toLowerCase();
const START = flag('start', 'C2');
const COUNT = parseInt(flag('count', '9'), 10);
const OUT = flag('out', path.join(path.dirname(new URL(import.meta.url).pathname), 'drone-gen-out'));

// ---- seeded rng (mulberry32, same as the page) ----------------------------
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

// ---- notes: the library's C/E/Gs-per-octave convention --------------------
const NOTE_SEMIS = { C: 0, E: 4, Gs: 8 };
const NOTE_ORDER = ['C', 'E', 'Gs'];
function noteList(start, count) {
  const m = start.match(/^(C|E|Gs)(\d)$/);
  if (!m) throw new Error(`bad --start "${start}" — use C2, E2, Gs2, ...`);
  let ni = NOTE_ORDER.indexOf(m[1]);
  let oct = parseInt(m[2], 10);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({ name: NOTE_ORDER[ni] + oct, midi: 12 * (oct + 1) + NOTE_SEMIS[NOTE_ORDER[ni]] });
    if (++ni === 3) { ni = 0; oct++; }
  }
  return out;
}
const hz = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// ---- the voice: six harmonics of one fundamental, the demo loop's rolloff ----
// Each file is a single breathing TONE so Sequence's chord-relative engine
// can voice chords from it. (The chord-interval version of this voice lives
// on as decay.html's demo pad.)
const VOICING = [
  { r: 1.0, a: 0.40 },
  { r: 2.0, a: 0.26 },
  { r: 3.0, a: 0.22 },
  { r: 4.0, a: 0.18 },
  { r: 5.0, a: 0.12 },
  { r: 6.0, a: 0.05 },
];
// breath depth — written as (1-DEP)+DEP*sin (not 0.7+0.3*sin) so the byte
// stream matches tools/drone-lab.html's export at default knobs exactly
const DEP = 0.3;

function renderNote(rootHz, rng) {
  const n = Math.round(SR * SECS);
  const xf = Math.round(SR * Math.min(0.25, SECS * 0.05)); // seam fold
  const total = n + xf;
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  // per-partial LFO rate + phase drawn from the kit's seeded stream — the
  // whole kit shares one breath character, notes get consecutive draws
  const am = VOICING.map(() => 0.04 + rng() * 0.08);
  const ph = VOICING.map(() => rng() * Math.PI * 2);
  for (let i = 0; i < total; i++) {
    const t = i / SR;
    let l = 0, r = 0;
    for (let p = 0; p < VOICING.length; p++) {
      const f = rootHz * VOICING[p].r;
      const env = (1 - DEP) + DEP * Math.sin(2 * Math.PI * am[p] * t + ph[p]);
      l += Math.sin(2 * Math.PI * f * t) * VOICING[p].a * env;
      r += Math.sin(2 * Math.PI * f * 1.0013 * t + 0.3) * VOICING[p].a * env;
    }
    L[i] = l; R[i] = r;
  }
  // fold the tail over the head so the loop wrap is seamless anywhere
  const outL = L.subarray(0, n).slice();
  const outR = R.subarray(0, n).slice();
  for (let i = 0; i < xf; i++) {
    const w = i / xf; // 0 = pure tail (continuous from sample n-1), 1 = pure head
    outL[i] = L[n + i] * (1 - w) + L[i] * w;
    outR[i] = R[n + i] * (1 - w) + R[i] * w;
  }
  // normalize peak to -3dBFS (library convention)
  let pk = 0;
  for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(outL[i]), Math.abs(outR[i]));
  const g = pk > 0 ? Math.pow(10, -3 / 20) / pk : 1;
  for (let i = 0; i < n; i++) { outL[i] *= g; outR[i] *= g; }
  return { L: outL, R: outR };
}

// ---- 24-bit stereo WAV -----------------------------------------------------
function writeWav24(file, L, R) {
  const n = L.length;
  const dataBytes = n * 2 * 3;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2 * 3, 28); buf.writeUInt16LE(6, 32); buf.writeUInt16LE(24, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  let off = 44;
  const put = (v) => {
    const s = Math.max(-1, Math.min(1, v));
    const q = Math.round(s * 8388607);
    buf.writeUInt8(q & 0xff, off++);
    buf.writeUInt8((q >> 8) & 0xff, off++);
    buf.writeUInt8((q >> 16) & 0xff, off++);
  };
  for (let i = 0; i < n; i++) { put(L[i]); put(R[i]); }
  fs.writeFileSync(file, buf);
}

// ---- main -------------------------------------------------------------------
const seedNum = parseInt(SEED, 16);
if (!isFinite(seedNum)) throw new Error(`bad --seed "${SEED}" — hex expected`);
const rng = mulberry32(seedNum);
const kit = `drone-${SEED}`;
const outDir = path.join(OUT.replace(/^~/, os.homedir()), kit);
fs.mkdirSync(outDir, { recursive: true });

const notes = noteList(START, COUNT);
console.log(`${kit} — ${notes.length} notes · ${SECS}s · 48k/24-bit · seed ${SEED}`);
for (const nt of notes) {
  const { L, R } = renderNote(hz(nt.midi), rng);
  const file = path.join(outDir, `${kit}-${nt.name}.wav`);
  writeWav24(file, L, R);
  // seam check: the wrap point should be step-free
  const seam = Math.abs(L[0] - L[L.length - 1]);
  console.log(`  ${path.basename(file)}  root ${hz(nt.midi).toFixed(1)}Hz  seam Δ ${seam.toFixed(4)}`);
}
console.log(`→ ${outDir}`);
