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
  chordMasterPattern,
  bassPattern,
  flavorSustained,
} from '../progressions';
import type { ComposeContext } from '../types';

// DRIVING — caveman 4-on-the-floor pound. 4-on-the-floor anchor but with a
// constant CRASH carpet instead of hi-hats — crash on every quarter is
// what makes it actually drive. Floortom doubles the kick on every
// quarter for thickness. No hi-hats (those are the "dance" feel),
// no motifs (caveman doesn't noodle), no ride. Just kick + snare +
// crash + tom-pound + bass-and-chord.
export function composeDriving(ctx: ComposeContext): BankSlot {
  const palette = getOrCreatePalette();
  // Slow harmonic motion under the relentless pulse — driving wants
  // harmonic WEIGHT, not motion. Chord per half-bar or per bar.
  const chordPlan = pickChordPlan([
    pickPlanSlow4,
    pickPlanVerySlow4,
    pickPlanVerySlow4,
    pickPlanSlow6,
  ]);

  // Skeleton = quarter notes. Kick + bass + crash + floortom all on this.
  const skeleton = [0, 4, 8, 12];

  // Racktom adds extra heft 50% of generations — on backbeats so it
  // accents the snare without doubling the kick/floortom-on-1.
  const rackActive = Math.random() < 0.5;

  let melodicSlot = -1;
  let drumSlot = -1;
  const tracks = ctx.tracks.map((t) => {
    if (t.section === 'drum') {
      drumSlot++;
      const voice = drumVoiceForSlot(drumSlot);
      const base = populateDrum(t, voice);
      // Kick: every quarter.
      if (drumSlot === 0) return applyProgrammedSteps(base, skeleton, 16, '1/16');
      // Snare: backbeats.
      if (drumSlot === 1) return applyProgrammedSteps(base, [4, 12], 16, '1/16');
      // Hat-c / hat-o silent — caveman driving has no hi-hats. The crash is the
      // time-keeping voice.
      if (drumSlot === 2) return silenceTrack(base);
      if (drumSlot === 3) return silenceTrack(base);
      // Crash: every quarter. THE driving element — acoustic crash decay
      // tails wash together into a constant cymbal carpet. Velocity
      // moderate so the pile-up doesn't overwhelm the mix.
      if (drumSlot === 4)
        return applyProgrammedSteps(base, skeleton, 16, '1/16', 0.6);
      // Ride silent.
      if (drumSlot === 5) return silenceTrack(base);
      // Floortom: every quarter, doubling the kick. Thickens the low-end
      // pound to caveman levels.
      if (drumSlot === 6) return applyProgrammedSteps(base, skeleton, 16, '1/16', 0.7);
      // Racktom: 50% chance, on backbeats with snare. Adds heft to the 2-and-4.
      if (drumSlot === 7)
        return rackActive
          ? applyProgrammedSteps(base, [4, 12], 16, '1/16', 0.65)
          : silenceTrack(base);
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
      // Bass = skeleton (locks with kick + floortom).
      if (melodicSlot === 1)
        return bassPattern(
          populateBass(t, activeVoice(t, palette.bass)),
          skeleton,
          16,
          '1/16',
        );
      // Motifs silent — caveman pulse, no melodic noodling.
      if (melodicSlot === 2)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[0])));
      if (melodicSlot === 3)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[1])));
      if (melodicSlot === 4)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[2])));
      // Flavor 0 sustained — gives the pound a harmonic floor.
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
    // High tension (heavy primal feel), low chaos (clean repetition),
    // moderate density. Drift low so density-fill doesn't ghost in extra
    // hits between the deliberate quarter-note pound.
    macros: { density: 0.5, chaos: 0.15, motion: 0.4, drift: 0.3, tension: 0.7 },
    kind: 'scene',
  };
}
