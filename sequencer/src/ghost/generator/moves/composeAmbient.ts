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
  silenceTrack,
} from '../primitives';
import {
  pickChordPlan,
  pickPlanSlow4,
  pickPlanVerySlow4,
  pickPlanSlow6,
  pickPlanSlow8,
  chordMasterPattern,
  flavorSustained,
} from '../progressions';
import type { ComposeContext } from '../types';

// AMBIENT — zero rhythmic surface. No drums (or just a cymbal swell on
// scene start as a wash). Chord master with long slow progressions (slow6
// / slow8 weighted heaviest), bass + motifs silent, 1-3 flavor layers
// sustained on chord-aligned retriggers. The harmonic field IS the music
// — motion macro high so the chord context drifts. Pairs well as
// intro/outro/breakdown scenes in a song arc.
export function composeAmbient(ctx: ComposeContext): BankSlot {
  const palette = getOrCreatePalette();
  // Long chord plans dominant — ambient lives on extended harmonic arcs.
  // slow8 and slow6 most common (3-4 bar progressions); shorter plans land
  // occasionally for ambient with more chord motion.
  const chordPlan = pickChordPlan([
    pickPlanSlow6,
    pickPlanSlow6,
    pickPlanSlow8,
    pickPlanSlow8,
    pickPlanVerySlow4,
    pickPlanSlow4,
  ]);

  // Layered pad activation. Flavor 0 always; 1 mostly (70%) for the
  // primary layer; 2 sometimes (30%) for an extra wash.
  const flavor1Active = Math.random() < 0.7;
  const flavor2Active = Math.random() < 0.3;

  let melodicSlot = -1;
  let drumSlot = -1;
  const tracks = ctx.tracks.map((t) => {
    if (t.section === 'drum') {
      drumSlot++;
      const voice = drumVoiceForSlot(drumSlot);
      const base = populateDrum(t, voice);
      // Ambient is rhythmically silent — all drums (including crash swell)
      // sit out. Harmonic field (chord master + flavor layers) carries the
      // whole texture.
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
      // Bass + motifs silent — ambient = no rhythmic foundation, no melodic
      // walks. Harmonic field is everything.
      if (melodicSlot === 1)
        return silenceTrack(populateBass(t, activeVoice(t, palette.bass)));
      if (melodicSlot === 2)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[0])));
      if (melodicSlot === 3)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[1])));
      if (melodicSlot === 4)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[2])));
      // Flavor 0: primary pad, always active. Retriggers on half-bar
      // chord-aligned positions so each retrigger picks up the current chord.
      if (melodicSlot === 5)
        return flavorSustained(
          populateFlavor(t, activeVoice(t, palette.flavors[0])),
          [0, 8],
          16,
          '1/16',
          0.55,
        );
      // Flavor 1: secondary pad layer. Quieter; different voice for timbre.
      if (melodicSlot === 6) {
        const base = populateFlavor(t, activeVoice(t, palette.flavors[1]));
        return flavor1Active
          ? flavorSustained(base, [0, 8], 16, '1/16', 0.45)
          : silenceTrack(base);
      }
      // Flavor 2: drone layer. Single hit per bar = each bar-length cycle
      // sustains one chord-root note across the full bar, layered behind
      // the more-frequently-retriggering flavors 0 and 1.
      if (melodicSlot === 7) {
        const base = populateFlavor(t, activeVoice(t, palette.flavors[2]));
        return flavor2Active
          ? flavorSustained(base, [0], 16, '1/16', 0.4)
          : silenceTrack(base);
      }
      return cloneTrack(t);
    }
    return cloneTrack(t);
  });
  return {
    tracks,
    // Low density (no fill), low chaos (clean), high motion (harmonic drift),
    // moderate drift / tension. The ambient feel comes from sustained voices
    // + chord changes, not from rhythmic activity.
    macros: { density: 0.2, chaos: 0.1, motion: 0.7, drift: 0.6, tension: 0.4, voicing: 0 },
    kind: 'scene',
  };
}
