import { cloneTrack, type BankSlot } from '../../../state/store';
import {
  getOrCreatePalette,
  activeVoice,
  drumVoiceForSlot,
  randomFrom,
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
  pickPlanFast4,
  pickPlanSlow4,
  pickPlanSlow6,
  chordMasterPattern,
  bassPattern,
  flavorSustained,
  motifPattern,
} from '../progressions';
import type { ComposeContext } from '../types';

// DANCE — 4-on-the-floor verse/chorus groove. Kick on every quarter,
// snare backbeats, hat-c carpet (8ths or 16ths), optional hat-o offbeat
// for disco lift. Bass locks to the quarter-note skeleton; chord plan
// lands on those same beats. Motif 0 active at medium density for a
// hooky melodic line over the pulse. Toms + ride silent — driving is
// pulse and propulsion, no fills.
export function composeDance(ctx: ComposeContext): BankSlot {
  const palette = getOrCreatePalette();
  // Medium-paced chord plans. Slow4 / slow6 give verse-arc harmonic motion;
  // fast4 carved out for the occasional "chord per quarter beat" intensity
  // generation.
  const chordPlan = pickChordPlan([
    pickPlanSlow4,
    pickPlanSlow4,
    pickPlanSlow6,
    pickPlanFast4,
  ]);

  // Skeleton = quarter notes. Kick + bass + chord-plan changes all lock here.
  const skeleton = [0, 4, 8, 12];

  // Hat-c: 8ths (default 75%) or 16ths (25%, techno-leaning). The "driving
  // carpet" voice — provides the propulsive ride underneath kick + snare.
  const hatC16ths = Math.random() < 0.25;
  const hatCSteps = hatC16ths
    ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]
    : [0, 2, 4, 6, 8, 10, 12, 14];

  // Hat-o: optional offbeat 8ths (~40%) — disco "tsss" lift. Lands on the
  // and-of-each-beat for the classic 4-on-floor with open-hat counter.
  const hatOActive = Math.random() < 0.4;

  // Cym: rare phrase accent on long cycle.
  const cymActive = Math.random() < 0.35;
  const cymLen = randomFrom([32, 64]);

  // Motif 0: medium-density hook line. Hookiness comes from the steady
  // pulse — the motif just adds melodic color.
  const motifLen = randomFrom([11, 13, 14, 16]);
  const motifDensity = 0.22 + Math.random() * 0.18;

  let melodicSlot = -1;
  let drumSlot = -1;
  const tracks = ctx.tracks.map((t) => {
    if (t.section === 'drum') {
      drumSlot++;
      const voice = drumVoiceForSlot(drumSlot);
      const base = populateDrum(t, voice);
      // Kick: 4-on-the-floor every quarter.
      if (drumSlot === 0) return applyProgrammedSteps(base, skeleton, 16, '1/16');
      // Snare: backbeats — beats 2 and 4 (steps 4 and 12).
      if (drumSlot === 1) return applyProgrammedSteps(base, [4, 12], 16, '1/16');
      // Hat-c: 8th-note or 16th-note carpet.
      if (drumSlot === 2)
        return applyProgrammedSteps(base, hatCSteps, 16, '1/16', 0.65);
      // Hat-o: optional offbeat 8ths for disco-style lift.
      if (drumSlot === 3)
        return hatOActive
          ? applyProgrammedSteps(base, [2, 6, 10, 14], 16, '1/16', 0.55)
          : silenceTrack(base);
      // Cym: rare phrase accent.
      if (drumSlot === 4)
        return cymActive
          ? applyProgrammedSteps(base, [0], cymLen, '1/16', 0.7)
          : silenceTrack(base);
      // Ride + toms silent — driving doesn't need additional voices, the
      // 4-on-floor + hat carpet IS the engine.
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
      // Bass = skeleton (every quarter, locks with kick).
      if (melodicSlot === 1)
        return bassPattern(
          populateBass(t, activeVoice(t, palette.bass)),
          skeleton,
          16,
          '1/16',
        );
      // Motif 0 carries the hook line.
      if (melodicSlot === 2)
        return motifPattern(
          populateMotif(t, activeVoice(t, palette.motifs[0])),
          motifLen,
          '1/16',
          motifDensity,
        );
      if (melodicSlot === 3)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[1])));
      if (melodicSlot === 4)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[2])));
      // Flavor 0 sustained wash behind the pulse.
      if (melodicSlot === 5)
        return flavorSustained(
          populateFlavor(t, activeVoice(t, palette.flavors[0])),
          [0, 8],
          16,
          '1/16',
          0.5,
        );
      if (melodicSlot === 6) return populateFlavor(t, activeVoice(t, palette.flavors[1]));
      if (melodicSlot === 7) return populateFlavor(t, activeVoice(t, palette.flavors[2]));
      return cloneTrack(t);
    }
    return cloneTrack(t);
  });
  return {
    tracks,
    // Steady energy — full but repetitive. Chaos low (driving = clean
    // pulse), motion moderate (chord arc carries), drift moderate so
    // density-fill can add subtle variation across bars.
    macros: { density: 0.5, chaos: 0.2, motion: 0.5, drift: 0.5, tension: 0.5, voicing: 0 },
    kind: 'scene',
  };
}
