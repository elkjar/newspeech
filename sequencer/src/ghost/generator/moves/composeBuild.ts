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
  pickPlanVerySlow4,
  chordMasterPattern,
  bassPattern,
  flavorSustained,
} from '../progressions';
import type { ComposeContext } from '../types';

// BUILD — caveman tribal build. Quarter-note toms hammering throughout the
// 4-bar (length 64) cycle, alternating floor / rack so every quarter has
// a tom hit. Kick anchors bar downbeats. Snare stays out for the first
// half (bars 0-1 = pure tom pound), enters with backbeats in bar 2, and
// explodes into an 8th-note roll in bar 3. Hat / cymbal / ride / motifs
// all silent — the build is rhythmic dynamics, not metal volume. Loops as
// a self-contained crescendo scene; pairs before hits or melodic in an arc.
export function composeBuild(ctx: ComposeContext): BankSlot {
  const palette = getOrCreatePalette();
  // Slow 4-chord progression across the 4 bars — chord per bar gives the
  // crescendo a harmonic arc.
  const chordPlan = pickPlanVerySlow4();

  // Kick: bar downbeats. The thump under the tom pulse.
  const kickSteps = [0, 16, 32, 48];

  // Toms = the build's primary voice. Every quarter note across the 4-bar
  // cycle gets a tom hit, alternating between floortom (downbeat quarters
  // of each half-bar) and racktom (the other quarters). Combined they form
  // a relentless quarter-note pulse — "DOOM, dum, DOOM, dum" — that's the
  // caveman pound the recipe is built around.
  const floortomSteps = [0, 8, 16, 24, 32, 40, 48, 56];
  const racktomSteps = [4, 12, 20, 28, 36, 44, 52, 60];

  // Snare stays out for bars 0-1 (pure tom pound), enters with backbeats
  // in bar 2, and rolls in bar 3 as the release into whatever comes next.
  //   bar 0 (steps 0-15)  → silence (toms + kick only)
  //   bar 1 (steps 16-31) → silence
  //   bar 2 (steps 32-47) → [36, 44]                  (backbeats)
  //   bar 3 (steps 48-63) → [52, 54, 56, 58, 60, 62]  (8th-note roll)
  const snareSteps = [36, 44, 52, 54, 56, 58, 60, 62];

  let melodicSlot = -1;
  let drumSlot = -1;
  const tracks = ctx.tracks.map((t) => {
    if (t.section === 'drum') {
      drumSlot++;
      const voice = drumVoiceForSlot(drumSlot);
      const base = populateDrum(t, voice);
      if (drumSlot === 0) return applyProgrammedSteps(base, kickSteps, 64, '1/16');
      if (drumSlot === 1) return applyProgrammedSteps(base, snareSteps, 64, '1/16');
      // Toms loud — they're the lead voice, not background percussion.
      if (drumSlot === 6) return applyProgrammedSteps(base, floortomSteps, 64, '1/16', 0.85);
      if (drumSlot === 7) return applyProgrammedSteps(base, racktomSteps, 64, '1/16', 0.8);
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
      // Bass: one hit per bar (length 16, [0]). Held under the build.
      if (melodicSlot === 1)
        return bassPattern(populateBass(t, activeVoice(t, palette.bass)), [0], 16, '1/16');
      if (melodicSlot === 2)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[0])));
      if (melodicSlot === 3)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[1])));
      if (melodicSlot === 4)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[2])));
      // Flavor 0 sustained as harmonic floor.
      if (melodicSlot === 5)
        return flavorSustained(
          populateFlavor(t, activeVoice(t, palette.flavors[0])),
          [0],
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
    // High tension (the build's defining macro), low chaos (straight time),
    // low motion (rhythm carries the arc, not modulation).
    macros: { density: 0.4, chaos: 0.15, motion: 0.3, drift: 0.5, tension: 0.7, voicing: 0 },
    kind: 'scene',
  };
}
