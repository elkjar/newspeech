// Global chord context — the most recently played chord assembly from the
// chord master row (melodic slot 0). Updated by the dispatcher each time
// row 0 fires a step with `chordVoicing.degree > 0`; read by followers
// (`root-follow` / `chord-tone` pitch-interp modes) to harmonize with
// whatever the chord master last established.
//
// Lives in a module-level singleton rather than the Zustand store on
// purpose: the context updates every chord-master step (potentially every
// beat or oftener) and React subscribers don't need to re-render for it.
// Same pattern as `mutationOverlay`.

import { CHORD_MASTER_DEFAULT, resolveChord, type ChordVoicing } from './chords';
import type { Scale } from './scale';

export interface ChordContext {
  root: number;          // MIDI value of the chord root (post-inversion lowest note)
  intervals: number[];   // semitone offsets from root, post inversion + spread
  voicing: ChordVoicing; // the voicing that produced this context — for debug / future UI
}

function computeDefault(rootMidi: number, scale: Scale): ChordContext {
  const resolved = resolveChord(rootMidi, scale, CHORD_MASTER_DEFAULT, 0);
  return {
    root: resolved.root,
    intervals: resolved.intervals,
    voicing: CHORD_MASTER_DEFAULT,
  };
}

let current: ChordContext = computeDefault(60, 'major');

export function getChordContext(): ChordContext {
  return current;
}

export function setChordContext(ctx: ChordContext): void {
  current = ctx;
}

// Re-seed the context from a scene root + scale. Called at boot and after
// `importProject` so followers have a sensible chord to harmonize with
// before row 0 has actually played anything.
export function resetChordContext(rootMidi: number, scale: Scale): void {
  current = computeDefault(rootMidi, scale);
}

// Pick a chord-tone interval by index, wrapping octave-up / octave-down
// for indices past the chord's tone count. Triad at index 4 = root + 1
// octave; maj7 at index 4 = 9th (one degree above the 7th, root+12+2);
// negative indices walk down by octaves.
export function chordToneMidi(ctx: ChordContext, pitchIndex: number): number {
  const len = ctx.intervals.length;
  if (len === 0) return ctx.root;
  const octaveShift = Math.floor(pitchIndex / len);
  const idx = ((pitchIndex % len) + len) % len;
  return ctx.root + ctx.intervals[idx] + octaveShift * 12;
}
