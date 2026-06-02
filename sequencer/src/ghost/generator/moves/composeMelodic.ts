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
import {
  pickChordPlan,
  pickPlanFast4,
  pickPlanSlow4,
  pickPlanVerySlow4,
  pickPlanSlow6,
  pickPlanSlow8,
  chordMasterPattern,
  bassPattern,
  flavorSustained,
  motifPattern,
} from '../progressions';
import type { ComposeContext } from '../types';

// MELODIC — chord master + bass + 2 motifs, minimal drum support. 4-chord
// progression for harmonic interest, motion macro up so the chord context
// shifts over time. Hat-c at length 11, motifs at lengths 13/14 — drifting
// against the length-16 chord master + bass anchor. Two motifs at different
// odd lengths produce intersecting melodic lines that re-align rarely.
export function composeMelodic(ctx: ComposeContext): BankSlot {
  const palette = getOrCreatePalette();
  // Melodic weights toward 4+ chord movement — this is the harmony-forward
  // recipe so the longer progressions belong here most heavily. slow8 and
  // slow6 give 4-bar / 3-bar arcs under the busy motifs; slow4 is the
  // "spacious 4-chord" option; fast4 carves out the original behavior.
  const chordPlan = pickChordPlan([
    pickPlanSlow4,
    pickPlanSlow4,
    pickPlanSlow6,
    pickPlanSlow8,
    pickPlanFast4,
    pickPlanVerySlow4,
  ]);

  // Structural skeleton — melodic uses quarter-note skeleton since bass plays
  // every quarter (harmony-forward recipe). Kick = SUBSET of skeleton (kick
  // less dense than bass for the melodic feel: bass walks the chords, kick
  // marks the strong beats only).
  const skeleton = [0, 4, 8, 12];
  // Kick: always step 0, plus 1-2 more picks from {4, 8, 12}. So kick is a
  // 2-3 hit subset of bass's positions. Always rhythmically aligned.
  const kickAuthoredSteps = (() => {
    const pool = [4, 8, 12];
    const picked = [0];
    const extras = randInt(1, 2);
    for (let i = 0; i < extras && pool.length > 0; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    return picked.sort((a, b) => a - b);
  })();
  const hatCLen = randomFrom([10, 11, 12]);
  const hatCHits = Math.min(hatCLen, randInt(4, 7));
  const hatCRot = randInt(1, 3);
  const motifALen = randomFrom([11, 13, 14]);
  const motifBLen = randomFrom([12, 14, 15]);
  // Motif densities pulled back to match the acoustic-context drum tuning.
  // Was A 0.25-0.45 / B 0.35-0.60 — two motifs at those densities piled into
  // each other under the new drum sparsity. New ranges: A 0.15-0.30 / B
  // 0.20-0.40 (B still slightly busier as the lead voice; both breathe).
  const motifADensity = 0.15 + Math.random() * 0.15;
  const motifBDensity = 0.2 + Math.random() * 0.2;

  let melodicSlot = -1;
  let drumSlot = -1;
  const tracks = ctx.tracks.map((t) => {
    if (t.section === 'drum') {
      drumSlot++;
      const voice = drumVoiceForSlot(drumSlot);
      const base = populateDrum(t, voice);
      // Light drum support — kick + hat-c only. Other drums voice-assigned
      // but silent for kit-layout stability across bank swaps; silenceTrack
      // zeros mutation so they don't fire flips.
      if (drumSlot === 0) return applyProgrammedSteps(base, kickAuthoredSteps, 16, '1/16', 0.5);
      if (drumSlot === 2) return applyEuclideanPattern(base, hatCHits, hatCRot, hatCLen, '1/16', 0.45);
      return silenceTrack(base);
    }
    if (t.section === 'melodic') {
      melodicSlot++;
      if (melodicSlot === 0)
        return chordMasterPattern(populateChordMaster(t, activeVoice(t, palette.chordMaster)), chordPlan.changes, chordPlan.length, '1/16');
      if (melodicSlot === 1)
        return bassPattern(populateBass(t, activeVoice(t, palette.bass)), skeleton, 16, '1/16');
      if (melodicSlot === 2)
        return motifPattern(populateMotif(t, activeVoice(t, palette.motifs[0])), motifALen, '1/16', motifADensity);
      if (melodicSlot === 3)
        return motifPattern(populateMotif(t, activeVoice(t, palette.motifs[1])), motifBLen, '1/16', motifBDensity);
      if (melodicSlot === 4) return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[2])));
      // Flavor 1 active — atmospheric pad behind the melodic lines.
      if (melodicSlot === 5)
        return flavorSustained(populateFlavor(t, activeVoice(t, palette.flavors[0])), [0, 4, 8, 12], 16, '1/16', 0.5);
      if (melodicSlot === 6) return populateFlavor(t, activeVoice(t, palette.flavors[1]));
      if (melodicSlot === 7) return populateFlavor(t, activeVoice(t, palette.flavors[2]));
      return cloneTrack(t);
    }
    return cloneTrack(t);
  });
  return {
    tracks,
    macros: { density: 0.5, chaos: 0.3, motion: 0.65, drift: 0.7, tension: 0.5, voicing: 0 },
    kind: 'scene',
  };
}
