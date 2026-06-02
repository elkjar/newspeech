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
  pickPlanSlow2,
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

// SPARSE — minimal kick + tasteful hat (length 13 drifts against the kick's
// 16-bar loop), slow chord progression, bass on downbeats. Macros pulled
// low for a meditative feel. Chord master + bass stay at length 16 as the
// harmonic anchor layer. Each call randomizes across 5 dimensions (kick
// shape, hat-c length, bass placement, motif activation/slot/length, flavor
// length) so two sparse generations don't sound the same.
export function composeSparse(ctx: ComposeContext): BankSlot {
  const palette = getOrCreatePalette();
  // Sparse weights heavy on long progressions — the meditative pacing leaves
  // room for harmonic movement that just isn't possible at faster tempos.
  // Prior weighting landed on 2-chord ~43% of calls which read as "stuck on
  // I-V" even though the scene was technically using slow tempi. New mix:
  // slow6 + slow8 dominant (~58% combined), slow4/verySlow4 as variety, only
  // slow2 represents 2-chord. Fast2 / fast4 both unused (too busy for sparse).
  const chordPlan = pickChordPlan([
    pickPlanSlow6,
    pickPlanSlow6,
    pickPlanSlow8,
    pickPlanSlow8,
    pickPlanSlow4,
    pickPlanVerySlow4,
    pickPlanSlow2,
  ]);

  // Structural skeleton — the shared rhythmic spine that kick + bass + chord
  // changes all lock onto. Each compose generation picks ONE skeleton; kick
  // adds decoration on top, bass plays the skeleton exactly, chord plan
  // positions naturally land on these same multiples of 8.
  // Pool weighted toward [0, 8] (the half-bar rock standard); [0] for the
  // most stripped one-anchor-per-bar feel.
  const skeleton = randomFrom([[0], [0, 8], [0, 8], [0, 8]]);

  // Kick = skeleton + optional decoration. 45% of generations skip decoration
  // entirely (kick locked tight to bass at exactly the skeleton positions);
  // otherwise 1-2 offbeat extras for groove. Decoration pool excludes the
  // skeleton positions to avoid double-counting.
  const decorationPool = [4, 6, 10, 12, 14].filter((s) => !skeleton.includes(s));
  const kickDecorationCount = Math.random() < 0.45 ? 0 : randInt(1, 2);
  const kickAuthoredSteps = (() => {
    const pool = [...decorationPool];
    const picked = [...skeleton];
    for (let i = 0; i < kickDecorationCount && pool.length > 0; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    return picked.sort((a, b) => a - b);
  })();

  // Hat-c length pool widened from 11-13 to 10-14 for a wider drift range
  // against the length-16 kick.
  const hatCLen = randomFrom([10, 11, 12, 13, 14]);
  const hatCHits = randInt(2, 4);
  const hatCRot = randInt(0, hatCLen - 1);

  // Bass — 50% of calls drop it entirely. Sparse with a sustained flavor
  // already gives the harmonic floor; bass on top tips into "heavy" too
  // often. When active, bass plays the SKELETON EXACTLY — tight lock to
  // kick downbeats so the low-end reads as one rhythmic unit instead of
  // two independent voices.
  const bassActive = Math.random() < 0.5;
  const bassSteps = skeleton;

  // Motif activation — 70% of calls assigns one motif slot a low-density
  // chord-tone walk at an odd length. Previously sparse had no melodic
  // motion beyond the hat-c drift; this gives sparse a moving melodic voice.
  // Slot randomization across 2/3/4 picks which of the 3 palette motif
  // voices fires, so the voice itself varies across generations.
  const motifActiveSlot = Math.random() < 0.7 ? randomFrom([2, 3, 4]) : -1;
  const motifLen = randomFrom([11, 13, 14]);
  const motifDensity = 0.1 + Math.random() * 0.15;

  // Flavor 0 length: usually 16 (anchor-aligned with chord-change rhythm),
  // sometimes 13 for slow drift against the chord master.
  const flavor0Len = randomFrom([16, 16, 13]);
  const flavor0Steps = flavor0Len === 16 ? [0, 8] : [0];

  // Sparse comp voice: hat-c OR ride, mutually exclusive (50/50 split). Ride
  // is the "ambient" comp voice — quarter-note placement at [0,4,8,12], the
  // classic light-drive sustained-cymbal pattern. Either way only one comp
  // voice fires so sparse stays sparse.
  const useRide = Math.random() < 0.5;
  // Cymbal — phrase accent. ~25% of sparse generations, single hit on step
  // 0 of a long cycle (32 or 64) so crashes are rare and feel like scene
  // markers rather than rhythmic content.
  const cymActive = Math.random() < 0.25;
  const cymLen = randomFrom([32, 64]);

  let melodicSlot = -1;
  let drumSlot = -1;
  const tracks = ctx.tracks.map((t) => {
    if (t.section === 'drum') {
      drumSlot++;
      const voice = drumVoiceForSlot(drumSlot);
      const base = populateDrum(t, voice);
      // Sparse: kick + one comp voice (hat-c OR ride) + occasional cymbal
      // accent. Other slots stay silent (silenceTrack zeros mutation so the
      // voice-assigned-but-empty rows don't fire mutation flips).
      if (drumSlot === 0) {
        // Kick = skeleton + decoration (computed above). Always programmed
        // now so the skeleton lock is preserved.
        return applyProgrammedSteps(base, kickAuthoredSteps, 16, '1/16');
      }
      if (drumSlot === 2) {
        if (useRide) return silenceTrack(base);
        return applyEuclideanPattern(base, hatCHits, hatCRot, hatCLen, '1/16', 0.6);
      }
      if (drumSlot === 4) {
        return cymActive ? applyProgrammedSteps(base, [0], cymLen, '1/16', 0.7) : silenceTrack(base);
      }
      if (drumSlot === 5) {
        if (!useRide) return silenceTrack(base);
        return applyProgrammedSteps(base, [0, 4, 8, 12], 16, '1/16', 0.5);
      }
      return silenceTrack(base);
    }
    if (t.section === 'melodic') {
      melodicSlot++;
      if (melodicSlot === 0)
        return chordMasterPattern(populateChordMaster(t, activeVoice(t, palette.chordMaster)), chordPlan.changes, chordPlan.length, '1/16');
      if (melodicSlot === 1) {
        const base = populateBass(t, activeVoice(t, palette.bass));
        return bassActive ? bassPattern(base, bassSteps, 16, '1/16') : silenceTrack(base);
      }
      // Motif slots 2-4: the active one gets a motifPattern, the others get
      // silenceTrack so their non-zero default mutation doesn't fire flips.
      if (melodicSlot === 2) {
        const base = populateMotif(t, activeVoice(t, palette.motifs[0]));
        return motifActiveSlot === 2 ? motifPattern(base, motifLen, '1/16', motifDensity) : silenceTrack(base);
      }
      if (melodicSlot === 3) {
        const base = populateMotif(t, activeVoice(t, palette.motifs[1]));
        return motifActiveSlot === 3 ? motifPattern(base, motifLen, '1/16', motifDensity) : silenceTrack(base);
      }
      if (melodicSlot === 4) {
        const base = populateMotif(t, activeVoice(t, palette.motifs[2]));
        return motifActiveSlot === 4 ? motifPattern(base, motifLen, '1/16', motifDensity) : silenceTrack(base);
      }
      // Flavor 1 active in sparse — single sustained atmospheric layer.
      if (melodicSlot === 5)
        return flavorSustained(populateFlavor(t, activeVoice(t, palette.flavors[0])), flavor0Steps, flavor0Len, '1/16', 0.5);
      if (melodicSlot === 6) return populateFlavor(t, activeVoice(t, palette.flavors[1]));
      if (melodicSlot === 7) return populateFlavor(t, activeVoice(t, palette.flavors[2]));
      return cloneTrack(t);
    }
    return cloneTrack(t);
  });
  return {
    tracks,
    macros: { density: 0.25, chaos: 0.2, motion: 0.4, drift: 0.7, tension: 0.3, voicing: 0 },
    kind: 'scene',
  };
}
