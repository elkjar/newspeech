import { cloneTrack, type BankSlot } from '../../../state/store';
import type { ChordDegree } from '../../../audio/chords';
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
  applyHitsCharacter,
  silenceTrack,
} from '../primitives';
import { chordMasterPattern } from '../progressions';
import type { ComposeContext } from '../types';

// HITS — angular riff of chord changes. Every voice in the band stabs
// together on shared positions, but those positions are off-grid and dense
// (4-7 hits per bar, sometimes 8-9 across 2 bars). Each hit gets its own
// chord — listener hears a flowing RIFF of harmonic motion instead of
// "four chords hit at once." Short gates make each chord stab punchy; max
// fxSend drives every voice through the FX bus for distorted character.
// Bass uses applyProgrammedSteps (no ties) so it punches each hit instead
// of sustaining between them. Flavor silent — sustained pad would smear
// the rapid chord changes.
export function composeHits(ctx: ComposeContext): BankSlot {
  const palette = getOrCreatePalette();

  // 40% chance of a 2-bar riff (length 32) vs 1-bar riff (length 16). Both
  // pools weight toward angular, syncopated positions — anything that
  // breaks the kick-on-1, 5, 9, 13 anchor pattern. Length-4 alignment kept
  // OUT of the pools so the riffs never feel like quarter-note stabs.
  const useTwoBar = Math.random() < 0.4;
  const hitLength = useTwoBar ? 32 : 16;
  const oneBarRiffs: number[][] = [
    [0, 3, 6, 10],            // 4 hits, syncopated
    [0, 2, 6, 10, 14],        // 5 hits, on/off mix
    [0, 4, 7, 10, 14],        // 5 hits, displaced
    [0, 3, 6, 9, 12, 14],     // 6 hits, climbing-then-near
    [0, 2, 5, 8, 11, 14],     // 6 hits, every-3-then-anchor
    [0, 3, 7, 10, 13],        // 5 hits, anchor-less
    [0, 2, 4, 7, 10, 13],     // 6 hits, ramping
    [0, 4, 6, 10, 12],        // 5 hits, anchor + offbeat pair
  ];
  const twoBarRiffs: number[][] = [
    [0, 3, 6, 10, 14, 18, 22, 26, 30],   // 9 hits over 2 bars
    [0, 2, 6, 10, 14, 17, 20, 24, 28],   // 9 hits, varies bar 1 vs bar 2
    [0, 4, 7, 10, 14, 18, 22, 26],       // 8 hits
    [0, 3, 6, 12, 14, 19, 22, 28],       // 8 hits, very angular
    [0, 2, 5, 9, 12, 18, 21, 25, 29],    // 9 hits, scattered
  ];
  const hitPattern = useTwoBar
    ? randomFrom(twoBarRiffs)
    : randomFrom(oneBarRiffs);

  // Riff progression — longer chord arcs (6-8 chord progressions) cycled
  // via modulo across however many hits the riff has. 4-hit riffs get the
  // first 4 of the progression; 9-hit riffs wrap around. The variety
  // across generations comes from both the riff pattern AND the picked
  // progression.
  const progPool: ChordDegree[][] = [
    [1, 6, 4, 5, 1, 6, 4, 5],   // doubled axis
    [1, 5, 6, 3, 4, 1, 4, 5],   // Pachelbel
    [6, 5, 4, 5, 6, 5, 4, 5],   // modal V-stabs
    [1, 3, 4, 5, 6, 4, 5, 1],   // ascending then resolve
    [6, 4, 1, 5, 6, 4, 1, 5],   // doubled Andalusian
    [1, 6, 4, 3, 4, 5, 6, 1],   // non-repeating phrase
    [1, 4, 5, 4, 6, 5, 1, 4],   // folk-suspension riff
  ];
  const prog = randomFrom(progPool);
  const chordChanges = hitPattern.map((step, i) => ({
    step,
    degree: prog[i % prog.length],
  }));

  let melodicSlot = -1;
  let drumSlot = -1;
  const tracks = ctx.tracks.map((t) => {
    if (t.section === 'drum') {
      drumSlot++;
      const voice = drumVoiceForSlot(drumSlot);
      const base = populateDrum(t, voice);
      // All hit voices lock fully into the riff — kick, snare, crash, both
      // toms hit on every step. The "band lands together" reading: every
      // stab is a full kit pile-up, not a real-drummer compromise. Crash
      // velocity trimmed (0.75) since it's now playing every step rather
      // than once as an accent.
      if (drumSlot === 0)
        return applyHitsCharacter(applyProgrammedSteps(base, hitPattern, hitLength, '1/16', 0.9));
      if (drumSlot === 1)
        return applyHitsCharacter(applyProgrammedSteps(base, hitPattern, hitLength, '1/16', 0.9));
      if (drumSlot === 4)
        return applyHitsCharacter(applyProgrammedSteps(base, hitPattern, hitLength, '1/16', 0.75));
      if (drumSlot === 6)
        return applyHitsCharacter(applyProgrammedSteps(base, hitPattern, hitLength, '1/16', 0.8));
      if (drumSlot === 7)
        return applyHitsCharacter(applyProgrammedSteps(base, hitPattern, hitLength, '1/16', 0.75));
      return silenceTrack(base);
    }
    if (t.section === 'melodic') {
      melodicSlot++;
      if (melodicSlot === 0)
        return applyHitsCharacter(
          chordMasterPattern(
            populateChordMaster(t, activeVoice(t, palette.chordMaster)),
            chordChanges,
            hitLength,
            '1/16',
          ),
        );
      // Bass: applyProgrammedSteps instead of bassPattern — no ties, so
      // each hit is a punchy isolated note. Pitch defaults to 0 (chord
      // root via chord-tone interp from populateBass). Short gate matches
      // the rest of the stab.
      if (melodicSlot === 1)
        return applyHitsCharacter(
          applyProgrammedSteps(
            populateBass(t, activeVoice(t, palette.bass)),
            hitPattern,
            hitLength,
            '1/16',
            0.9,
          ),
        );
      // Motifs + flavors silent. Sustained or random-walk content would
      // smear the rapid harmonic motion — the riff IS the music.
      if (melodicSlot === 2)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[0])));
      if (melodicSlot === 3)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[1])));
      if (melodicSlot === 4)
        return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[2])));
      if (melodicSlot === 5)
        return silenceTrack(populateFlavor(t, activeVoice(t, palette.flavors[0])));
      if (melodicSlot === 6) return populateFlavor(t, activeVoice(t, palette.flavors[1]));
      if (melodicSlot === 7) return populateFlavor(t, activeVoice(t, palette.flavors[2]));
      return cloneTrack(t);
    }
    return cloneTrack(t);
  });
  return {
    tracks,
    // High density + higher chaos (the riff is the chaos), moderate motion,
    // low drift (hits should land where authored, no density-fill ghosts),
    // high tension.
    macros: { density: 0.6, chaos: 0.35, motion: 0.4, drift: 0.3, tension: 0.75, voicing: 0 },
    kind: 'scene',
  };
}
