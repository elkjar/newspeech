import type { Track } from '../state/store';
import { sourceMutation } from '../instruments/library';

const TIE_INDEX_OFFSET = 1024;

// Deterministic 0..1 hash from trackId + index. Used to provide a stable
// pseudo-random gate for tie-flip mutation: the same step's tie either
// flips or doesn't flip consistently across renders for a given mutation
// level, instead of re-rolling every render. FNV-1a 32-bit normalized.
// Inlined from the deleted `src/audio/morph.ts` (pattern morph removed
// 2026-05-11) since this was its only remaining caller.
function stepSeed(trackId: string, index: number): number {
  let h = 2166136261;
  for (let i = 0; i < trackId.length; i++) {
    h ^= trackId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= index;
  h = Math.imul(h, 16777619);
  return (h >>> 0) / 0xffffffff;
}

export function effectiveTieToNext(track: Track, i: number): boolean {
  const authored = track.steps[i]?.tieToNext ?? false;
  if (track.mutation === 0 || track.lockTiming) return authored;
  const profile = sourceMutation(track.source);
  // Asymmetric flip — easier to BREAK an existing tie than to CREATE a new
  // one. Stops mutation from building full-bar chains while still letting
  // it add variety to authored sustains. See voices.ts MutationProfile
  // notes for the rate split.
  const rate = authored
    ? profile.tieFlipOffChance
    : profile.tieFlipOnChance;
  if (rate === 0) return authored;
  const seed = stepSeed(track.id, i + TIE_INDEX_OFFSET);
  if (seed < track.mutation * rate) return !authored;
  return authored;
}
