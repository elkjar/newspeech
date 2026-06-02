import { cloneTrack, type BankSlot } from '../../../state/store';
import {
  getOrCreatePalette,
  activeVoice,
  drumVoiceForSlot,
  randomFrom,
  randInt,
} from '../palette';
import {
  populateChordMaster,
  populateBass,
  populateMotif,
  populateDrum,
  populateFlavor,
  applyEuclideanPattern,
  applyProgrammedSteps,
  silenceTrack,
} from '../primitives';
import type { ComposeContext } from '../types';

// DRUMS ONLY — every drum role populated, melodic completely empty. Higher
// tension/chaos OK because no harmonic content to clash with. Kick stays at
// length 16 as the downbeat anchor; everything else drifts at odd lengths
// (snare 13, hat-c 11, hat-o 14, perc 12) — heavy polymeter, no aligned
// "groove" beyond the kick.
//
// Authored as a TRANSITION-kind bank (lands in slot 14/15) so ghost doesn't
// pick it autonomously — see `ghost.ts:pickNextBank` for the transition
// exclusion. The role-diversity multiplier in `entropy.ts` already lowered
// its score, but a drum-solo bank is musically a deliberate gesture (break
// / drum solo), not a climax destination — user-trigger only is the right
// scope. Same kit content, just scoped to user-driven moments.
export function composeDrumsOnly(ctx: ComposeContext): BankSlot {
  const palette = getOrCreatePalette();
  const kickHits = randInt(3, 5);
  const snareLen = randomFrom([11, 13, 14]);
  const snareHits = Math.min(snareLen, randInt(2, 3));
  const snareRot = randInt(3, 5);
  const hatCLen = randomFrom([10, 11, 12]);
  const hatCHits = Math.min(hatCLen, randInt(5, 8));
  const hatCRot = randInt(0, 2);
  const hatOLen = randomFrom([13, 14, 15]);
  const hatOHits = Math.min(hatOLen, randInt(2, 3));
  const hatORot = randInt(3, 5);
  // Cym (crash) — phrase accent on long cycle; ride for sustained comp;
  // toms as single accents at random rotation. Same semantic placement as
  // composePolyrhythmic but with higher activation rates since this is the
  // "drums-only" showcase recipe.
  const cymLen = randomFrom([32, 64]);
  const cymActive = Math.random() < 0.65;
  const rideActive = Math.random() < 0.45;
  const floorActive = Math.random() < 0.5;
  const rackActive = Math.random() < 0.45;
  const floorRot = randInt(0, 12);
  const rackRot = randInt(0, 12);

  let melodicSlot = -1;
  let drumSlot = -1;
  const tracks = ctx.tracks.map((t) => {
    if (t.section === 'drum') {
      drumSlot++;
      const voice = drumVoiceForSlot(drumSlot);
      const base = populateDrum(t, voice);
      if (drumSlot === 0) return applyEuclideanPattern(base, kickHits, 0, 16, '1/16');
      if (drumSlot === 1) return applyEuclideanPattern(base, snareHits, snareRot, snareLen, '1/16');
      if (drumSlot === 2) return applyEuclideanPattern(base, hatCHits, hatCRot, hatCLen, '1/16', 0.7);
      if (drumSlot === 3) return applyEuclideanPattern(base, hatOHits, hatORot, hatOLen, '1/16');
      if (drumSlot === 4)
        return cymActive ? applyProgrammedSteps(base, [0], cymLen, '1/16', 0.7) : silenceTrack(base);
      if (drumSlot === 5)
        return rideActive ? applyProgrammedSteps(base, [0, 4, 8, 12], 16, '1/16', 0.5) : silenceTrack(base);
      if (drumSlot === 6)
        return floorActive ? applyEuclideanPattern(base, 1, floorRot, 16, '1/16', 0.7) : silenceTrack(base);
      if (drumSlot === 7)
        return rackActive ? applyEuclideanPattern(base, 1, rackRot, 16, '1/16', 0.65) : silenceTrack(base);
      return silenceTrack(base);
    }
    if (t.section === 'melodic') {
      melodicSlot++;
      // All melodic voice-assigned but silent — kit-layout stability across
      // bank swaps without firing any harmonic content. silenceTrack zeros
      // mutation so chord-master / bass / motif defaults (0.08 / 0.05 / 0.22)
      // don't flip authored-OFF steps into random hits.
      if (melodicSlot === 0) return silenceTrack(populateChordMaster(t, activeVoice(t, palette.chordMaster)));
      if (melodicSlot === 1) return silenceTrack(populateBass(t, activeVoice(t, palette.bass)));
      if (melodicSlot === 2) return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[0])));
      if (melodicSlot === 3) return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[1])));
      if (melodicSlot === 4) return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[2])));
      if (melodicSlot === 5) return populateFlavor(t, activeVoice(t, palette.flavors[0]));
      if (melodicSlot === 6) return populateFlavor(t, activeVoice(t, palette.flavors[1]));
      if (melodicSlot === 7) return populateFlavor(t, activeVoice(t, palette.flavors[2]));
      return cloneTrack(t);
    }
    return cloneTrack(t);
  });
  return {
    tracks,
    macros: { density: 0.6, chaos: 0.55, motion: 0.3, drift: 0.6, tension: 0.55, voicing: 0 },
    kind: 'transition',
  };
}
