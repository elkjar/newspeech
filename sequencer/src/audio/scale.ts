export type Scale = 'major' | 'minor' | 'pentatonic' | 'chromatic';

const SCALE_INTERVALS: Record<Scale, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  pentatonic: [0, 2, 4, 7, 9],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

export const SCALES: Scale[] = ['major', 'minor', 'pentatonic', 'chromatic'];

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
