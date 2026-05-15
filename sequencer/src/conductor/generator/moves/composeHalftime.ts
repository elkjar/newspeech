import { cloneTrack, type BankSlot } from '../../../state/store';
import {
  getOrCreatePalette,
  activeVoice,
  drumVoiceForSlot,
} from '../palette';
import {
  populateChordMaster,
  populateBass,
  populateMotif,
  populateDrum,
  populateFlavor,
  applyProgrammedSteps,
  silenceTrack,
} from '../primitives';
import {
  pickChordPlan,
  pickPlanSlow4,
  pickPlanVerySlow4,
  pickPlanSlow6,
  pickPlanSlow8,
  chordMasterPattern,
  bassPattern,
  flavorSustained,
} from '../progressions';
import type { ComposeContext } from '../types';

// HALFTIME — big heavy half-time feel. Length 32 (2-bar loop). Kick on bar
// downbeats only `[0, 16]`, snare on the half-time backbeat `[8, 24]` (= beat
// 3 of each bar, not beats 2 and 4). Crash repeating every quarter note
// across the cycle so its decay tails wash together into a wall-of-cymbals
// carpet that keeps time-keeping audible while the kick/snare feel slow.
// Hat / ride / toms / motifs silent — the BIG kick-snare + cymbal wash is
// the whole thing. Pairs as a doom/anthem section between sparse and hits.
export function composeHalftime(ctx: ComposeContext): BankSlot {
  const palette = getOrCreatePalette();
  // Slow chord plans — half-time wants harmonic space underneath. slow6 /
  // slow8 land long arcs; verySlow4 gives chord-per-bar; slow4 the busiest
  // option (chord per half-bar over 2 bars).
  const chordPlan = pickChordPlan([
    pickPlanSlow4,
    pickPlanVerySlow4,
    pickPlanVerySlow4,
    pickPlanSlow6,
    pickPlanSlow8,
  ]);

  const halftimeLength = 32;
  const kickSteps = [0, 16];
  const snareSteps = [8, 24];
  // Crash on every quarter — 8 hits across the 2 bars. Acoustic crash
  // decay (~2-3s) bleeds into the next hit so the cycle reads as a
  // sustained cymbal wash rather than 8 distinct attacks. Velocity
  // moderate (0.55) so the pile-up doesn't overwhelm the mix.
  const cymSteps = [0, 4, 8, 12, 16, 20, 24, 28];

  let melodicSlot = -1;
  let drumSlot = -1;
  const tracks = ctx.tracks.map((t) => {
    if (t.section === 'drum') {
      drumSlot++;
      const voice = drumVoiceForSlot(drumSlot);
      const base = populateDrum(t, voice);
      // Kick + snare BIG (high velocity). Crash carpet moderate.
      if (drumSlot === 0)
        return applyProgrammedSteps(base, kickSteps, halftimeLength, '1/16', 0.95);
      if (drumSlot === 1)
        return applyProgrammedSteps(base, snareSteps, halftimeLength, '1/16', 0.9);
      if (drumSlot === 4)
        return applyProgrammedSteps(base, cymSteps, halftimeLength, '1/16', 0.55);
      return silenceTrack(base);
    }
    if (t.section === 'melodic') {
      melodicSlot++;
      if (melodicSlot === 0)
        return chordMasterPattern(
          populateChordMaster(t, activeVoice(t, palette.chordMaster)),
          chordPlan.changes,
          chordPlan.length,
          '1/16',
        );
      // Bass: one hit per bar (length 16, [0]). Locks with kick on each
      // bar downbeat. Big single note holds under the half-time pulse.
      if (melodicSlot === 1)
        return bassPattern(
          populateBass(t, activeVoice(t, palette.bass)),
          [0],
          16,
          '1/16',
        );
      // Motifs silent — half-time = no melodic noodling, just BIG and slow.
      if (melodicSlot === 2)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[0])));
      if (melodicSlot === 3)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[1])));
      if (melodicSlot === 4)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[2])));
      // Flavor 0 as sustained chord wash underneath.
      if (melodicSlot === 5)
        return flavorSustained(
          populateFlavor(t, activeVoice(t, palette.flavors[0])),
          [0, 8],
          16,
          '1/16',
          0.55,
        );
      if (melodicSlot === 6) return populateFlavor(t, activeVoice(t, palette.flavors[1]));
      if (melodicSlot === 7) return populateFlavor(t, activeVoice(t, palette.flavors[2]));
      return cloneTrack(t);
    }
    return cloneTrack(t);
  });
  return {
    tracks,
    // High tension (heavy feel), moderate density, low chaos (clean and
    // big). Drift low so density-fill doesn't ghost in extra hits between
    // the deliberately-sparse kick/snare.
    macros: { density: 0.4, chaos: 0.15, motion: 0.5, drift: 0.3, tension: 0.7 },
    kind: 'scene',
  };
}
