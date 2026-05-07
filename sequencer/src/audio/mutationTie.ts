import type { Track } from '../state/store';
import { stepSeed } from './morph';
import { voiceMutation } from './voices';

const TIE_INDEX_OFFSET = 1024;

export function effectiveTieToNext(track: Track, i: number): boolean {
  const authored = track.steps[i]?.tieToNext ?? false;
  if (track.mutation === 0) return authored;
  const profile = voiceMutation(track.voice);
  if (profile.tieFlipChance === 0) return authored;
  const seed = stepSeed(track.id, i + TIE_INDEX_OFFSET);
  if (seed < track.mutation * profile.tieFlipChance) return !authored;
  return authored;
}
