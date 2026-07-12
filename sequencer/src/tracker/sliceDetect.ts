// Transient onset detection for slice-mode auto-slicing (Phase D, S2). Runs in
// JS on the decoded mono buffer and returns sorted 0..1 slice START points
// (always including 0), min-gap-guarded and capped at MAX_SLICES. The tunable
// `sensitivity` is the app's edge over the Tracker's own auto-slicer, which
// detects transients but exposes no sensitivity control.
//
// SLICE COUNT (48 = the .pti format limit, Chris 2026-07-11): kept at the full
// 48 rather than a tighter "playability" cap. Slices trigger by SCALE-DEGREE
// above root (samplePlayer); a step's pitch is ±14 degrees on the grid, but the
// per-track OCTAVE shift (±4 octaves) plus the degree wrap extend reach so the
// upper slices are addressable by pushing a row up an octave — Chris likes that
// this makes higher slices a deliberate register move. So detection keeps every
// transient up to 48 (the .pti slices[48] bound); tune density with sensitivity.
//
// Split into an EXPENSIVE analysis pass (envelope + log-novelty over the whole
// buffer, run once per voice) and a CHEAP pick pass (threshold + peak-pick),
// so twisting the sensitivity knob re-slices live without re-scanning the audio.

import { loadVoiceMono } from './waveformPeaks';

export interface OnsetAnalysis {
  nov: Float32Array; // per-frame positive log-energy rise (novelty)
  hop: number; // frames per analysis step
  frames: number; // source length in frames
  maxNov: number; // peak novelty (for the absolute floor)
}

// Envelope hop ~5ms; a hit's onset is a few ms so this resolves closely-packed
// breakbeat hits without over-fragmenting sustained material.
const HOP_SECS = 0.005;

// Max slices auto-slice will produce (incl. slice 0) — the .pti format bound, see
// the file header. Keeps the strongest onsets when more are detected.
export const MAX_SLICES = 48;

// Compute the novelty function for a voice's sample. Cached by voiceId — the
// audio scan happens once; sensitivity changes only re-run pickOnsets. Null when
// the voice has no resolvable sample.
const analysisCache = new Map<string, OnsetAnalysis>();

export async function analyzeVoiceOnsets(voiceId: string): Promise<OnsetAnalysis | null> {
  const hit = analysisCache.get(voiceId);
  if (hit) return hit;
  const src = await loadVoiceMono(voiceId);
  if (!src || src.frames < 2) return null;
  const { mono, frames, sampleRate } = src;
  const hop = Math.max(1, Math.floor(sampleRate * HOP_SECS));
  const nF = Math.floor(frames / hop);
  if (nF < 2) return null;
  // RMS energy per hop.
  const env = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    const c = f * hop;
    const e = Math.min(frames, c + hop);
    let sum = 0;
    for (let i = c; i < e; i++) sum += mono[i] * mono[i];
    env[f] = Math.sqrt(sum / Math.max(1, e - c));
  }
  // Log-energy positive difference — log compression makes a soft ghost-note
  // rise comparable to a loud kick, so sensitivity behaves consistently across
  // the sample's dynamic range (a linear diff would only ever find the loudest).
  const nov = new Float32Array(nF);
  let maxNov = 0;
  for (let f = 1; f < nF; f++) {
    const d = Math.log(env[f] + 1e-4) - Math.log(env[f - 1] + 1e-4);
    const v = d > 0 ? d : 0;
    nov[f] = v;
    if (v > maxNov) maxNov = v;
  }
  const out: OnsetAnalysis = { nov, hop, frames, maxNov };
  analysisCache.set(voiceId, out);
  return out;
}

// Peak-pick onsets from a precomputed analysis at a given sensitivity (0..1,
// higher = more slices). Cheap: safe to call per pointer-move as the knob turns.
// Returns sorted 0..1 fractions, always leading with 0, ≤48 points.
export function pickOnsets(a: OnsetAnalysis, sensitivity: number): number[] {
  const { nov, hop, frames, maxNov } = a;
  if (maxNov <= 0 || frames <= 0) return [0];
  const s = Math.max(0, Math.min(1, sensitivity));
  const nF = nov.length;
  const sampleRate = hop / HOP_SECS; // recover SR from the hop (hop = SR · HOP_SECS)
  const framesToF = (secs: number) => Math.max(1, Math.floor((secs * sampleRate) / hop));
  // Local-mean threshold factor + absolute floor, both eased by sensitivity.
  // Low sensitivity → high factor + high floor (only strong, well-separated
  // hits); high sensitivity → both relax toward catching ghost notes.
  const factor = 1.1 + (1 - s) * 2.4; // 3.5 → 1.1
  const floor = (0.28 - s * 0.25) * maxNov; // 0.28·max → 0.03·max
  const meanW = framesToF(0.06); // ~60ms trailing mean window
  const minGapF = framesToF(0.03); // ~30ms between onsets

  // Collect candidates (novelty local maxima that clear both thresholds),
  // gap-guarded, carrying their strength so an over-count can keep the strongest.
  const cand: { f: number; v: number }[] = [];
  let lastF = -minGapF;
  for (let f = 1; f < nF; f++) {
    const v = nov[f];
    if (v < floor) continue;
    if (v < nov[f - 1] || (f + 1 < nF && v < nov[f + 1])) continue; // not a local max
    let sum = 0;
    let n = 0;
    for (let k = Math.max(1, f - meanW); k < f; k++) {
      sum += nov[k];
      n++;
    }
    if (v < (n ? sum / n : 0) * factor) continue;
    if (f - lastF < minGapF) continue;
    cand.push({ f, v });
    lastF = f;
  }

  // Slice 0 is always the sample start; keep ≤ MAX_SLICES-1 detected onsets. If
  // over, keep the strongest by novelty, then re-sort by time.
  let picks = cand;
  if (picks.length > MAX_SLICES - 1) {
    picks = [...cand]
      .sort((x, y) => y.v - x.v)
      .slice(0, MAX_SLICES - 1)
      .sort((x, y) => x.f - y.f);
  }
  const out = [0];
  for (const p of picks) {
    const frac = (p.f * hop) / frames;
    if (frac > 0.002) out.push(frac);
  }
  return out;
}
