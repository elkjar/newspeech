#!/usr/bin/env node
// wave-harvest — cuts newspeech kits into single-cycle wave tables for
// waves.html (and Sequence's wavetable voice / the Polyend Tracker).
//
// For each pitched kit under sequencer/public/samples/{pads,instruments,bass}
// it picks the sample nearest C2, walks its life from onset to fade-out and
// lifts WINDOWS single cycles, denser near the attack (where the sound
// moves fastest). Each cycle is:
//   - period-refined by autocorrelation around the note's nominal period
//     (kit notes are named, so no pitch detection from scratch)
//   - resampled to FRAMES points, seam step removed with a linear tilt
//   - DC removed, band-limited to the source's own Nyquist
//   - phase-aligned (see align()): neighbours in a table line up, and
//     tables line up with each other, so crossfades morph instead of
//     comb-cancelling
//   - RMS-matched (peak capped) so steps sit at one level
//
// Output: waves/<kit>.wav (mono 16-bit, WINDOWS × FRAMES frames — the
// Tracker / Sequence wavetable layout) + waves/index.json.
//
//   node tools/wave-harvest.mjs [--kits a,b] [--windows 32]

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'sequencer/public/samples');
const OUT = path.join(ROOT, 'waves');
const CATS = ['pads', 'instruments', 'bass'];
const FRAMES = 2048;

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const WINDOWS = +flag('windows', 32);
const ONLY = flag('kits', '') ? new Set(flag('kits').split(',')) : null;

// --- wav io -----------------------------------------------------------------
function readWav(file) {
  const b = fs.readFileSync(file);
  let p = 12, fmt = null, data = null;
  while (p + 8 <= b.length) {
    const id = b.toString('ascii', p, p + 4);
    const size = b.readUInt32LE(p + 4);
    if (id === 'fmt ') fmt = { tag: b.readUInt16LE(p + 8), ch: b.readUInt16LE(p + 10), sr: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) };
    if (id === 'data') data = b.subarray(p + 8, p + 8 + size);
    p += 8 + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('bad wav ' + file);
  const bps = fmt.bits / 8, n = Math.floor(data.length / (bps * fmt.ch));
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < fmt.ch; c++) {
      const o = (i * fmt.ch + c) * bps;
      if (fmt.tag === 3 && fmt.bits === 32) s += data.readFloatLE(o);
      else if (fmt.bits === 16) s += data.readInt16LE(o) / 32768;
      else if (fmt.bits === 24) s += (data.readIntLE(o, 3)) / 8388608;
      else if (fmt.bits === 32) s += data.readInt32LE(o) / 2147483648;
    }
    out[i] = s / fmt.ch;
  }
  return { x: out, sr: fmt.sr };
}

function writeWav16(file, x, sr) {
  const b = Buffer.alloc(44 + x.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + x.length * 2, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(x.length * 2, 40);
  for (let i = 0; i < x.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, x[i])) * 32767), 44 + i * 2);
  fs.writeFileSync(file, b);
}

// --- fft (in place, radix-2) ------------------------------------------------
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const a = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(a), wi = Math.sin(a);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

// --- analysis ---------------------------------------------------------------
const NOTE = { C: 0, Cs: 1, D: 2, Ds: 3, E: 4, F: 5, Fs: 6, G: 7, Gs: 8, A: 9, As: 10, B: 11 };
function noteOf(name) {
  const m = name.match(/[-_]([A-G]s?)(\d)(?:-\d+)?\.wav$/);
  return m ? 12 * (+m[2] + 1) + NOTE[m[1]] : null;
}

function cubic(x, t) {
  const i = Math.floor(t), f = t - i;
  const a = x[i - 1] ?? 0, b = x[i] ?? 0, c = x[i + 1] ?? 0, d = x[i + 2] ?? 0;
  return b + 0.5 * f * (c - a + f * (2 * a - 5 * b + 4 * c - d + f * (3 * (b - c) + d - a)));
}

// Normalized autocorrelation peak near the nominal period, parabolic-refined.
function refinePeriod(x, t, p0) {
  const span = Math.round(p0 * 2);
  const lo = Math.floor(p0 * 0.94), hi = Math.ceil(p0 * 1.06);
  let best = -2, bestL = p0;
  const score = new Map();
  for (let L = lo; L <= hi; L++) {
    let num = 0, ea = 0, eb = 0;
    for (let i = 0; i < span; i++) {
      const a = x[t + i] ?? 0, b = x[t + i + L] ?? 0;
      num += a * b; ea += a * a; eb += b * b;
    }
    const s = num / Math.sqrt(ea * eb + 1e-12);
    score.set(L, s);
    if (s > best) { best = s; bestL = L; }
  }
  const a = score.get(bestL - 1), b = best, c = score.get(bestL + 1);
  if (a !== undefined && c !== undefined && a - 2 * b + c < 0) return bestL + 0.5 * (a - c) / (a - 2 * b + c);
  return bestL;
}

function cycleAt(x, t, p0) {
  const P = refinePeriod(x, Math.floor(t), p0);
  const re = new Float64Array(FRAMES), im = new Float64Array(FRAMES);
  const seam = cubic(x, t + P) - cubic(x, t);
  for (let k = 0; k < FRAMES; k++) re[k] = cubic(x, t + (k * P) / FRAMES) - seam * (k / FRAMES);
  fft(re, im, false);
  re[0] = im[0] = 0;
  const maxH = Math.min(FRAMES / 2 - 1, Math.floor(P / 2));
  for (let h = maxH + 1; h < FRAMES - maxH; h++) re[h] = im[h] = 0;
  return { re, im, maxH };
}

// Rotate a cycle's spectrum by phase shift phi (harmonic h turns by h·phi).
function rotated(c, phi) {
  const re = new Float64Array(FRAMES), im = new Float64Array(FRAMES);
  for (let h = 1; h <= c.maxH; h++) {
    const co = Math.cos(-h * phi), si = Math.sin(-h * phi);
    const r = c.re[h] * co - c.im[h] * si, i = c.re[h] * si + c.im[h] * co;
    re[h] = r; im[h] = i; re[FRAMES - h] = r; im[FRAMES - h] = -i;
  }
  return { re, im };
}

// Phase alignment. Each cycle after the first is circularly shifted to its
// best match with the previous one (cross-correlation via the spectra), so a
// table scans smoothly. The first cycle puts its DOMINANT harmonic h* in sine
// phase, choosing among the h* equivalent rotations the one with the
// fundamental nearest sine phase — so tables line up with each other wherever
// there's a fundamental at all, and crossfades between tables morph instead
// of comb-cancelling.
function corr(a, b, maxH) {
  let s = 0;
  for (let h = 1; h <= maxH; h++) s += a.re[h] * b.re[h] + a.im[h] * b.im[h];
  return s;
}

function align(c, prev) {
  if (prev) {
    const re = new Float64Array(FRAMES), im = new Float64Array(FRAMES);
    for (let h = 1; h <= c.maxH; h++) {
      re[h] = c.re[h] * prev.re[h] + c.im[h] * prev.im[h];
      im[h] = c.im[h] * prev.re[h] - c.re[h] * prev.im[h];
      re[FRAMES - h] = re[h]; im[FRAMES - h] = -im[h];
    }
    fft(re, im, true);
    let n = 0;
    for (let k = 1; k < FRAMES; k++) if (re[k] > re[n]) n = k;
    const A = rotated(c, (2 * Math.PI * n) / FRAMES), B = rotated(c, (-2 * Math.PI * n) / FRAMES);
    return corr(A, prev, c.maxH) >= corr(B, prev, c.maxH) ? A : B;
  }
  let hs = 1, best = 0;
  for (let h = 1; h <= c.maxH; h++) {
    const m = c.re[h] * c.re[h] + c.im[h] * c.im[h];
    if (m > best) { best = m; hs = h; }
  }
  const base = (Math.atan2(c.im[hs], c.re[hs]) + Math.PI / 2) / hs;
  let pick = null, score = -Infinity;
  for (let k = 0; k < hs; k++) {
    const r = rotated(c, base + (2 * Math.PI * k) / hs);
    const s = -r.im[1] - Math.abs(r.re[1]); // sine phase: X[1] ∝ −i
    if (s > score) { score = s; pick = r; }
  }
  return pick;
}

function toWave(spec) {
  const re = Float64Array.from(spec.re), im = Float64Array.from(spec.im);
  fft(re, im, true);
  let ss = 0, pk = 0;
  for (let k = 0; k < FRAMES; k++) { ss += re[k] * re[k]; pk = Math.max(pk, Math.abs(re[k])); }
  const rms = Math.sqrt(ss / FRAMES);
  const g = Math.min(0.3 / (rms + 1e-9), 0.97 / (pk + 1e-9), 40);
  const out = new Float32Array(FRAMES);
  for (let k = 0; k < FRAMES; k++) out[k] = re[k] * g;
  return out;
}

function envelope(x, hop) {
  const env = [];
  for (let i = 0; i + hop <= x.length; i += hop) {
    let s = 0;
    for (let j = 0; j < hop; j++) s += x[i + j] * x[i + j];
    env.push(Math.sqrt(s / hop));
  }
  return env;
}

function harvest(file, midi) {
  const { x, sr } = readWav(file);
  const p0 = sr / (440 * Math.pow(2, (midi - 69) / 12));
  const hop = 256, env = envelope(x, hop);
  const peak = Math.max(...env);
  const on = env.findIndex((e) => e > peak * 0.05);
  let off = env.length - 1;
  while (off > on && env[off] < peak * 0.016) off--; // −36 dB
  const t0 = on * hop, t1 = Math.max(t0 + p0 * 4, off * hop - p0 * 3);
  const waves = [];
  let prev = null;
  for (let k = 0; k < WINDOWS; k++) {
    const t = t0 + (t1 - t0) * Math.pow(k / (WINDOWS - 1), 1.6);
    prev = align(cycleAt(x, t, p0), prev);
    waves.push(toWave(prev));
  }
  return { waves, sr };
}

// --- kits -------------------------------------------------------------------
fs.mkdirSync(OUT, { recursive: true });
const index = [];
for (const cat of CATS) {
  for (const kit of fs.readdirSync(path.join(SRC, cat)).sort()) {
    if (ONLY && !ONLY.has(kit)) continue;
    const dir = path.join(SRC, cat, kit);
    if (!fs.statSync(dir).isDirectory()) continue;
    const cands = fs.readdirSync(dir).filter((f) => f.endsWith('.wav'))
      .map((f) => ({ f, m: noteOf(f) })).filter((c) => c.m !== null);
    if (!cands.length) { console.log(`skip ${cat}/${kit} (no note-named samples)`); continue; }
    cands.sort((a, b) => Math.abs(a.m - 36) - Math.abs(b.m - 36) || a.f.localeCompare(b.f));
    const pick = cands[0];
    const { waves, sr } = harvest(path.join(dir, pick.f), pick.m);
    const flat = new Float32Array(WINDOWS * FRAMES);
    waves.forEach((w, i) => flat.set(w, i * FRAMES));
    writeWav16(path.join(OUT, kit + '.wav'), flat, sr);
    index.push({ id: kit, cat, src: `${cat}/${kit}/${pick.f}`, windows: WINDOWS, frames: FRAMES });
    console.log(`${cat}/${kit} ← ${pick.f}`);
  }
}
if (!ONLY) fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify(index, null, 1) + '\n');
console.log(`${index.length} tables → ${path.relative(ROOT, OUT)}/`);
