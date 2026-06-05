import type { ChordVoicing } from './chords';

export interface OverlayValue {
  on: boolean;
  velocity: number;
  pitch: number;
  gate: number;
  // Trigger decisions captured at dispatch time (probability gate result and
  // final ratchet count). The freeze replay uses these so density / row-chance
  // / row-ratchet randomness lock to the previous cycle rather than re-rolling.
  gated: boolean;
  ratchet: number;
  // Per-tick harmonic-motion offset (scale degrees, from motion/drift) applied
  // to melodic pitch at dispatch. The `chord` field's root already bakes this
  // in; this carries it for non-chord rows so the roll can show motion/drift.
  harmonicShift?: number;
  // Stage 7: chord-master rows capture their resolved (and possibly mutated)
  // chord so freeze replays the same harmony + intervals. `intervals` is the
  // post-drop audible set; the chord context publishes the same set on freeze
  // replay. Absent for follower rows and non-melodic tracks.
  chord?: { root: number; intervals: number[]; voicing: ChordVoicing };
}

const overlay = new Map<string, Map<number, OverlayValue>>();

export function setOverlay(trackId: string, stepIndex: number, val: OverlayValue): void {
  let m = overlay.get(trackId);
  if (!m) {
    m = new Map();
    overlay.set(trackId, m);
  }
  m.set(stepIndex, val);
}

export function getOverlay(trackId: string, stepIndex: number): OverlayValue | undefined {
  return overlay.get(trackId)?.get(stepIndex);
}

export function clearOverlay(): void {
  overlay.clear();
}

// Stage 7: patch the chord field on an existing overlay entry without
// disturbing the trigger-decision fields. The chord master writes the
// trigger fields early (at the same point any track does) but only knows
// the resolved + possibly mutated chord later, after the chord-master
// branch in App.tsx has run. No-op if no entry exists for this step
// (e.g. the trigger-decision write was skipped).
export function attachChordToOverlay(
  trackId: string,
  stepIndex: number,
  chord: { root: number; intervals: number[]; voicing: ChordVoicing }
): void {
  const existing = overlay.get(trackId)?.get(stepIndex);
  if (!existing) return;
  existing.chord = chord;
}
