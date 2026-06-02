// Scale-degree-driven chord voicings. The NDLR-style mental model: everything
// is relative to the scene's scale. The user picks a degree (I-VII) and an
// extension (triad / 7 / 9 / 11 / sus2 / sus4); the actual chord quality
// (maj/min/dim) falls out of stacking thirds on the current scale at that
// degree. Switching scale auto-reharmonizes every chord step.

import { quantize, type Scale } from './scale';

export type ChordDegree = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type ChordExtension = 'triad' | '7' | '9' | '11' | 'sus2' | 'sus4';
export type ChordInversion = 0 | 1 | 2;
export type ChordSpread = 'close' | 'open' | 'wide';

export interface ChordVoicing {
  degree: ChordDegree;      // 0 = single note (no chord assembly), 1-7 = scale degree
  extension: ChordExtension;
  inversion: ChordInversion;
  spread: ChordSpread;
}

export const CHORD_DEGREES: ChordDegree[] = [0, 1, 2, 3, 4, 5, 6, 7];
export const CHORD_EXTENSIONS: ChordExtension[] = ['triad', '7', '9', '11', 'sus2', 'sus4'];
export const CHORD_INVERSIONS: ChordInversion[] = [0, 1, 2];
export const CHORD_SPREADS: ChordSpread[] = ['close', 'open', 'wide'];

// Roman numeral display for the degree picker. Single-character "—" for 0 so
// the dropdown reads at-a-glance in the compact inspector layout.
export const DEGREE_LABELS: Record<ChordDegree, string> = {
  0: '—',
  1: 'I',
  2: 'II',
  3: 'III',
  4: 'IV',
  5: 'V',
  6: 'VI',
  7: 'VII',
};

// Compact option labels for spread + extension to keep the inspector narrow.
export const EXTENSION_LABELS: Record<ChordExtension, string> = {
  triad: 'tri',
  '7': '7',
  '9': '9',
  '11': '11',
  sus2: 's2',
  sus4: 's4',
};

export const SPREAD_LABELS: Record<ChordSpread, string> = {
  close: 'c',
  open: 'o',
  wide: 'w',
};

export const DEFAULT_CHORD_VOICING: ChordVoicing = {
  degree: 0,
  extension: 'triad',
  inversion: 0,
  spread: 'close',
};

// Default for the chord-master row (currently row 1 by position; locked
// topology lands in Stage 5). A plain I triad in whatever scale the scene
// is in — auto-follows when the user changes scale.
export const CHORD_MASTER_DEFAULT: ChordVoicing = {
  degree: 1,
  extension: 'triad',
  inversion: 0,
  spread: 'close',
};

// Stack-of-thirds scale-degree offsets per extension. Indices are interpreted
// as offsets in the scene scale (so `2` means "two scale degrees up," not two
// semitones). `sus2` and `sus4` replace the 3rd with 2nd / 4th respectively.
const EXTENSION_DEGREE_OFFSETS: Record<ChordExtension, number[]> = {
  triad: [0, 2, 4],
  '7': [0, 2, 4, 6],
  '9': [0, 2, 4, 6, 8],
  '11': [0, 2, 4, 6, 8, 10],
  sus2: [0, 1, 4],
  sus4: [0, 3, 4],
};

export function extensionSupportsInversion(ext: ChordExtension): boolean {
  return EXTENSION_DEGREE_OFFSETS[ext].length >= 2;
}

// True if the voicing produces > 1 simultaneous note. Used by callers that
// gate jitter / pan / phasing mitigations on multi-note triggers.
export function isChord(voicing: ChordVoicing): boolean {
  return voicing.degree > 0;
}

export interface ResolvedChord {
  root: number;       // MIDI value of the chord root (lowest pre-inversion note)
  intervals: number[]; // semitone offsets from root, post-inversion + spread
}

// Resolve a ChordVoicing against the current scale into concrete MIDI notes.
// `rootMidi` is the scene tonic; `pitchOffset` is an additional scale-degree
// offset (e.g. the step's `pitch` field) layered on top of the chord's degree
// — letting the user shift a chord up an octave or to a non-diatonic root.
//
// Algorithm:
//   1. Anchor the chord root at scale degree `(voicing.degree - 1) + pitchOffset`.
//   2. Stack the extension's scale-degree offsets on top, quantized to scale.
//   3. Convert each note to an interval from the root.
//   4. Apply inversion (rotate lowest up an octave per step).
//   5. Apply spread (open: drop the middle/upper-middle; wide: + raise top).
export function resolveChord(
  rootMidi: number,
  scale: Scale,
  voicing: ChordVoicing,
  pitchOffset = 0
): ResolvedChord {
  if (voicing.degree === 0) {
    return {
      root: quantize(rootMidi, scale, pitchOffset),
      intervals: [0],
    };
  }

  const rootDegreeIdx = (voicing.degree - 1) + pitchOffset;
  const root = quantize(rootMidi, scale, rootDegreeIdx);

  const offsets = EXTENSION_DEGREE_OFFSETS[voicing.extension];
  const intervals = offsets.map((d) => quantize(rootMidi, scale, rootDegreeIdx + d) - root);

  // Inversion: lowest note up an octave, applied `inversion` times.
  const inverted = [...intervals];
  for (let i = 0; i < voicing.inversion; i++) {
    const lowest = inverted.shift();
    if (lowest === undefined) break;
    inverted.push(lowest + 12);
  }

  // Spread.
  const result = [...inverted];
  if (voicing.spread === 'open' || voicing.spread === 'wide') {
    const middleIdx = result.length >= 4 ? result.length - 2 : 1;
    if (middleIdx >= 0 && middleIdx < result.length) {
      result[middleIdx] -= 12;
    }
  }
  if (voicing.spread === 'wide') {
    result[result.length - 1] += 12;
  }
  result.sort((a, b) => a - b);

  return { root, intervals: result };
}

// Global "voicing" macro — a single continuous openness control (0..1) that
// re-voices the chord without touching the authored notes (Telepathic Orchid's
// voicing dial). Two bands, monotonic, non-destructive:
//   SIMPLE  (lower half) — reposition the chord: one inversion, then open
//           the spread. No new tones, always consonant.
//   ADVANCED(upper half) — stack diatonic color tones (triad → 7 → 9 → 11).
// At amount 0 (or degree 0 = single note) the authored voicing is returned
// untouched, so existing patterns are unchanged until the knob is turned. The
// macro only ever ESCALATES past the authored voicing (max with authored), so
// per-step authored voicing variation survives as a floor the macro lifts.
// sus2/sus4 keep their suspension — only their position is moved, not stacked.
//
// Bounded UPWARD reach. Each axis (inversion, spread, extension) raises pitch,
// and they compound: a 2nd inversion + 'wide' spread (raise the top +8ve) on an
// 11th sent the top voice ~+28 semitones (≈2.5 octaves) above the root — the
// chord "jumped 2 octaves" as the knob rose. So the cascade caps inversion at 1
// and spread at 'open' (drops the MIDDLE down rather than raising the top up).
// That holds the top to ~+14 — just over an octave of total opening, no leap.
export function applyVoicingMacro(voicing: ChordVoicing, amount: number): ChordVoicing {
  if (amount <= 0 || voicing.degree === 0) return voicing;
  const a = Math.min(1, amount);

  // SIMPLE: a single inversion, then open the spread. Capped at inversion 1 +
  // 'open' so the voicing opens without translating up the keyboard (see above).
  let inv = voicing.inversion as number;
  if (a >= 0.12 && inv < 1) inv = 1;

  let sprIdx = CHORD_SPREADS.indexOf(voicing.spread);
  if (a >= 0.3 && sprIdx < 1) sprIdx = 1; // open (drop the middle down)

  // ADVANCED: fold in diatonic extensions. Leave sus voicings' tone-stack alone.
  let extension = voicing.extension;
  if (extension !== 'sus2' && extension !== 'sus4') {
    const RICHNESS: ChordExtension[] = ['triad', '7', '9', '11'];
    let richIdx = Math.max(0, RICHNESS.indexOf(extension));
    if (a >= 0.58 && richIdx < 1) richIdx = 1; // 7th
    if (a >= 0.76 && richIdx < 2) richIdx = 2; // 9th
    if (a >= 0.92 && richIdx < 3) richIdx = 3; // 11th
    extension = RICHNESS[richIdx];
  }

  return {
    degree: voicing.degree,
    extension,
    inversion: inv as ChordInversion,
    spread: CHORD_SPREADS[sprIdx],
  };
}

// Parallel-mode pairing for `borrowChord`. Major and minor swap; pentatonic
// and chromatic have no idiomatic parallel and are intentionally omitted —
// callers fall through to the authored chord when this lookup misses.
export const PARALLEL_SCALE: Partial<Record<Scale, Scale>> = {
  major: 'minor',
  minor: 'major',
};

// Stage 7 chord-aware mutation primitives. All four are pure functions
// invoked at dispatch time; none modify pattern state. App.tsx selects
// one uniformly when the chord-master's mutation roll hits.

// Drop one non-root chord tone. Operates on the post-resolve intervals
// array (index 0 is always the bass anchor and is preserved). Returns
// the input unchanged for single-note (degree=0) results.
export function dropChordTone(intervals: number[]): number[] {
  if (intervals.length <= 1) return intervals;
  const dropIdx = 1 + Math.floor(Math.random() * (intervals.length - 1));
  return intervals.filter((_, i) => i !== dropIdx);
}

// Drop one non-root tone with a bias toward UPPER tones. Used by pad-type
// dispatch in samplePlayer so the sparser triggers keep the bass anchor
// and lose tops more often (perceptually: chord thins from the top down,
// not random gaps in the middle).
//   upperBias = 0 → uniform across non-bass candidates (same as dropChordTone)
//   upperBias = 1 → always pick the topmost tone
// Power-law weights: w_k = ((k+1) / candidates) ^ (1 + bias * 3) so bias=0
// is linear and bias=1 leans hard on the top.
export function dropChordToneWeighted(intervals: number[], upperBias: number): number[] {
  if (intervals.length <= 1) return intervals;
  const candidates = intervals.length - 1;
  const weights: number[] = [];
  for (let k = 0; k < candidates; k++) {
    const norm = (k + 1) / candidates;
    weights.push(Math.pow(norm, 1 + upperBias * 3));
  }
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  let pickIdx = candidates - 1;
  for (let k = 0; k < candidates; k++) {
    r -= weights[k];
    if (r <= 0) { pickIdx = k; break; }
  }
  return intervals.filter((_, i) => i !== pickIdx + 1);
}

// Pick a different inversion than authored. No-op for FIXED_SHAPE
// extensions (those with < 2 chord tones — only sus voicings dodge this
// because they're 3-tone). Triads / 7 / 9 / 11 / sus2 / sus4 all qualify.
export function shuffleInversion(voicing: ChordVoicing): ChordVoicing {
  if (!extensionSupportsInversion(voicing.extension)) return voicing;
  const others = CHORD_INVERSIONS.filter((i) => i !== voicing.inversion);
  if (others.length === 0) return voicing;
  return { ...voicing, inversion: others[Math.floor(Math.random() * others.length)] };
}

// Pick a different spread (close / open / wide) than authored.
export function shiftSpread(voicing: ChordVoicing): ChordVoicing {
  const others = CHORD_SPREADS.filter((s) => s !== voicing.spread);
  if (others.length === 0) return voicing;
  return { ...voicing, spread: others[Math.floor(Math.random() * others.length)] };
}

// Re-resolve the voicing against the parallel scale (major↔minor). Returns
// null when no parallel exists for the current scene scale (pentatonic /
// chromatic) — caller falls through to the authored chord. When the parallel
// resolve happens to produce the same intervals as the authored chord (e.g.
// V triad shares 1-3-5 across parallel major/minor for the dominant), the
// caller sees identical output and the roll is effectively a no-op; that's
// fine and matches the harmonic reality.
export function borrowChord(
  rootMidi: number,
  currentScale: Scale,
  voicing: ChordVoicing,
  pitchOffset = 0
): ResolvedChord | null {
  const parallel = PARALLEL_SCALE[currentScale];
  if (!parallel) return null;
  return resolveChord(rootMidi, parallel, voicing, pitchOffset);
}

// Strict parser for the new schema. Old (Stage 4 v2) `{type, inversion, spread}`
// values fail validation and the caller defaults to `DEFAULT_CHORD_VOICING`.
// Position-based defaulting then promotes the first melodic row to the chord
// master default — same migration shape as Stage 4 used.
export function parseChordVoicing(saved: unknown): ChordVoicing | null {
  if (!saved || typeof saved !== 'object') return null;
  const v = saved as Partial<ChordVoicing>;
  const degree = typeof v.degree === 'number' && (CHORD_DEGREES as number[]).includes(v.degree)
    ? (v.degree as ChordDegree)
    : null;
  if (degree === null) return null;
  const extension =
    typeof v.extension === 'string' && (CHORD_EXTENSIONS as string[]).includes(v.extension)
      ? (v.extension as ChordExtension)
      : 'triad';
  const inversionRaw = typeof v.inversion === 'number' ? Math.floor(v.inversion) : 0;
  const inversion = (CHORD_INVERSIONS as number[]).includes(inversionRaw)
    ? (inversionRaw as ChordInversion)
    : 0;
  const spread =
    typeof v.spread === 'string' && (CHORD_SPREADS as string[]).includes(v.spread)
      ? (v.spread as ChordSpread)
      : 'close';
  return { degree, extension, inversion, spread };
}
