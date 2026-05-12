import type { ChordVoicing } from './chords';

// Module-level voicing-drift counters for pad-type chord-master tracks.
// Same shape as mutationOverlay / chordContext — no Zustand because updates
// fire at dispatch rate and React subscribers don't need to know.
//
// `lastVoicing` is captured but currently unused at dispatch — keeps the
// shape extensible for future "drift FROM the last voicing rather than
// authored" behaviour without a schema change.
interface PadDriftState {
  triggerCount: number;
  lastVoicing: ChordVoicing | null;
}

const state = new Map<string, PadDriftState>();

// Increment + return the new count. Caller checks `count % everyN === 0` to
// decide whether this trigger drifts.
export function tickPadDrift(trackId: string): number {
  const s = state.get(trackId) ?? { triggerCount: 0, lastVoicing: null };
  s.triggerCount += 1;
  state.set(trackId, s);
  return s.triggerCount;
}

export function rememberPadVoicing(trackId: string, v: ChordVoicing): void {
  const s = state.get(trackId) ?? { triggerCount: 0, lastVoicing: null };
  s.lastVoicing = v;
  state.set(trackId, s);
}

// Reset on `importProject`, `applyBankSlot`, and init-* preset apply so
// drift cadence doesn't carry across pattern swaps.
export function resetPadDrift(trackId?: string): void {
  if (trackId === undefined) state.clear();
  else state.delete(trackId);
}
