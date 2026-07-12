// Live "which slice just fired" telemetry for the slice-mode waveform. The
// playback dispatch emits the triggered slice index per voice as the sequence
// runs; the editor waveform (scoped to the focused voice) subscribes and flashes
// the active cell, so you can watch the sequence walk across a chopped break.
//
// Session-only, no persistence, no store — a bare pub/sub. Emission is a no-op
// fast path when nothing subscribes (nobody's on the params tab), so it costs
// nothing on the audio dispatch path during normal playback.

type SliceHitListener = (voiceId: string, index: number) => void;

const listeners = new Set<SliceHitListener>();

// Emit from the dispatch path when a slice-mode note fires. Cheap no-op when the
// editor waveform isn't mounted (no listeners).
export function emitSliceHit(voiceId: string, index: number): void {
  if (listeners.size === 0) return;
  for (const l of listeners) l(voiceId, index);
}

// Subscribe (the editor waveform). Returns an unsubscribe.
export function onSliceHit(listener: SliceHitListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
