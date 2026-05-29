export type Scale =
  | 'major'
  | 'minor'
  | 'harmonic-minor'
  | 'dorian'
  | 'phrygian'
  | 'lydian'
  | 'mixolydian'
  | 'pentatonic'
  | 'minor-pentatonic'
  | 'blues'
  | 'chromatic';

// `pentatonic` is the MAJOR pentatonic (kept this name for `.seq` backward-
// compat with files saved before minor-pentatonic landed). Modes added
// 2026-05-20 — diatonic family + variant minors + pent completion; matches
// Hydrasynth's built-in list to de-risk scale-follow plumbing later.
const SCALE_INTERVALS: Record<Scale, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  pentatonic: [0, 2, 4, 7, 9],
  'minor-pentatonic': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export const SCALES: Scale[] = [
  'major',
  'minor',
  'harmonic-minor',
  'dorian',
  'phrygian',
  'lydian',
  'mixolydian',
  'pentatonic',
  'minor-pentatonic',
  'blues',
  'chromatic',
];

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function quantize(rootMidi: number, scale: Scale, degree: number): number {
  const intervals = SCALE_INTERVALS[scale];
  const len = intervals.length;
  const octaveShift = Math.floor(degree / len);
  const idx = ((degree % len) + len) % len;
  return rootMidi + octaveShift * 12 + intervals[idx];
}

export function midiToName(midi: number): string {
  const octave = Math.floor(midi / 12) - 1;
  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  return `${name}${octave}`;
}

export function octaveDegrees(scale: Scale): number {
  return SCALE_INTERVALS[scale].length;
}

// Find the scale-degree index of `midi` relative to `sceneTonic`. Returns
// null if `midi` doesn't land on a scale tone (rare — chord roots produced
// by `resolveChord` always quantize to the scene scale, so a non-null result
// is the expected case at dispatch). The returned index is octave-aware:
// values past one octave above tonic return `scaleLength + remainder`, etc.
export function scaleDegreeOf(midi: number, sceneTonic: number, scale: Scale): number | null {
  const intervals = SCALE_INTERVALS[scale];
  const len = intervals.length;
  const semitoneDelta = midi - sceneTonic;
  const fullOctaves = Math.floor(semitoneDelta / 12);
  const remainder = ((semitoneDelta % 12) + 12) % 12;
  const idx = intervals.indexOf(remainder);
  if (idx === -1) return null;
  return idx + fullOctaves * len;
}

// Snap an arbitrary MIDI note to the nearest in-scale pitch. Ties (a
// chromatic note equidistant between two scale tones — e.g. Bb in C major)
// round DOWN to the lower scale tone. Cross-octave snap is handled: B in
// C-major-pentatonic [0,2,4,7,9] correctly picks the next octave's C
// rather than the current octave's A. `chromatic` is a no-op.
export function snapToScale(midi: number, rootMidi: number, scale: Scale): number {
  const intervals = SCALE_INTERVALS[scale];
  if (intervals.length === 12) return midi;
  const centerOctave = Math.floor((midi - rootMidi) / 12);
  let best = midi;
  let bestDist = Infinity;
  for (let octShift = -1; octShift <= 1; octShift++) {
    const oct = centerOctave + octShift;
    for (const interval of intervals) {
      const candidate = rootMidi + oct * 12 + interval;
      const dist = Math.abs(midi - candidate);
      if (dist < bestDist || (dist === bestDist && candidate < best)) {
        best = candidate;
        bestDist = dist;
      }
    }
  }
  return best;
}

export function fifthDegrees(scale: Scale): number {
  const intervals = SCALE_INTERVALS[scale];
  const idx = intervals.indexOf(7);
  return idx >= 0 ? idx : Math.floor(intervals.length / 2) + 1;
}
