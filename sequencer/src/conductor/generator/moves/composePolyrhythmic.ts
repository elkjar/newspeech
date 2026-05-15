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
  pickPlanFast2,
  pickPlanSlow2,
  pickPlanFast4,
  pickPlanSlow4,
  pickPlanSlow6,
  pickPlanSlow8,
  chordMasterPattern,
  bassPattern,
  flavorSustained,
  motifPattern,
} from '../progressions';
import type { ComposeContext } from '../types';

// POLYRHYTHMIC — vary track lengths so the layers drift in and out of phase.
// All drum slots active (kick + snare + hat-c + hat-o + perc), motif at odd
// length. Chord master at standard 16-step length so the harmonic skeleton
// stays referenceable. Lengths AND hits AND rotations all randomized per
// call — same intent, different specifics each Generate.
export function composePolyrhythmic(ctx: ComposeContext): BankSlot {
  const palette = getOrCreatePalette();
  // Poly weights across every plan length. Fast2 stays common (preserves the
  // current "polymetric drift with steady harmonic pulse" feel) but the long
  // pickers land often enough that scenes get noticeable harmonic shape over
  // 3-4 bar arcs.
  const chordPlan = pickChordPlan([
    pickPlanFast2,
    pickPlanFast2,
    pickPlanSlow2,
    pickPlanSlow4,
    pickPlanSlow6,
    pickPlanSlow8,
    pickPlanFast4,
  ]);

  // Per-call rhythmic randomization. Lengths picked from odd pools to keep
  // the polymetric drift; kick + cymbal stay 16-aligned as phrase anchors.
  // With acoustic drum samples in the default kit (ns-kit-1), individual
  // snare / hat-c / hat-o tracks each have their own straight-time "anchor"
  // mode that overrides the polyrhythmic length-and-rotation rolls below.
  // The result: most generations have ONE or more drums locked to a
  // recognizable straight pattern (backbeat snare, comp hat) while the
  // others drift polyrhythmically — natural with real samples.
  const snareLen = randomFrom([11, 13, 14]);
  const hatCLen = randomFrom([11, 12, 13]);
  // Snare anchor (~40%): length 16 with backbeat hits at [4, 12]. 30% of
  // anchor calls add a pickup hit at step 14 for the "and-of-4" anticipation
  // pattern (very common in post-rock / indie acoustic kits).
  const snareAnchor = Math.random() < 0.4;
  const snareAnchorPickup = Math.random() < 0.3;
  const snareAnchorSteps = snareAnchorPickup ? [4, 12, 14] : [4, 12];
  // Hat-c anchor (~35%): length 16 with a straight pulse. 40% eighths (8
  // hits, every other step) / 60% quarters (4 hits) — quarters weight higher
  // because user wants overall density pulled back; eighths still appear
  // for "drive" generations.
  const hatCAnchor = Math.random() < 0.35;
  const hatCAnchorEighths = Math.random() < 0.4;
  const hatCAnchorSteps = hatCAnchorEighths
    ? [0, 2, 4, 6, 8, 10, 12, 14]
    : [0, 4, 8, 12];
  // Open-hat: two modes.
  //   - Anchor (~35%): length 16, 4 hits at quarter offbeats (steps
  //     2,6,10,14). Driving "lift" feel against the length-16 kick.
  //   - Short-cycle polyrhythm (~65%): length 3/4/5/6/7 with ONE hit at
  //     step 0. The accent rotates through the bar each cycle, producing
  //     3-against-4 / 5-against-4 / 7-against-4 cross-rhythms against the
  //     kick's 16-cycle.
  const hatOAnchor = Math.random() < 0.35;
  const hatOLen = hatOAnchor ? 16 : randomFrom([3, 4, 5, 6, 7]);
  // Cym (crash) — phrase accent only. Long cycle (32 or 64) so crash fires
  // every 2 or 4 bars. Acoustic crash decay bleeds into the next bar; this
  // is the only placement that doesn't wash out the rest of the kit.
  const cymLen = randomFrom([32, 64]);
  const motifLen = randomFrom([11, 13, 14]);

  // Structural skeleton — kick + bass share these positions. Poly uses the
  // half-bar standard [0, 8] so the low-end always reads as locked even
  // when the rest of the kit drifts polyrhythmically.
  const skeleton = [0, 8];
  // Kick = skeleton + 0-2 offbeat decoration steps. 40% no decoration (kick
  // dead-locked to bass); else 1-2 extras for groove against the polymetric
  // top end.
  const kickDecorationPool = [4, 6, 10, 12, 14];
  const kickDecorationCount = Math.random() < 0.4 ? 0 : randInt(1, 2);
  const kickAuthoredSteps = (() => {
    const pool = [...kickDecorationPool];
    const picked = [...skeleton];
    for (let i = 0; i < kickDecorationCount && pool.length > 0; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    return picked.sort((a, b) => a - b);
  })();

  // Density tuning pass 2 (acoustic-kit-aware). Each acoustic hit has a
  // longer perceived "weight" than a synth hit, so the same hit-count read
  // as more dense on the new kit. Trimmed snare / hatC further too.
  const snareHits = Math.min(snareLen, randInt(1, 3));
  const hatCHits = Math.min(hatCLen, randInt(3, 5));
  // Anchor: 4 quarter-offbeat hits. Short-cycle poly: single hit at step 0.
  const hatOHits = hatOAnchor ? 4 : 1;

  const snareRot = randInt(1, 4);
  const hatCRot = randInt(0, 2);
  // Anchor: rotation 2 (quarter offbeats). Short-cycle poly: rotation 0
  // (single hit on step 0 of each cycle, accent rotates through the bar).
  const hatORot = hatOAnchor ? 2 : 0;

  // Per-slot activation rolls. Snare stays at 65% (backbeat is structural).
  // Cym low — acoustic crashes decay into the next bar so less is more.
  const snareActive = Math.random() < 0.65;
  const hatCActive = Math.random() < 0.65;
  const hatOActive = Math.random() < 0.5;
  const cymActive = Math.random() < 0.3;

  // Ride — comp voice for sparse passages within polyrhythmic. Active when
  // hat-c is silent (mutually exclusive comp role), so generations with no
  // hat-c get the ride as a quarter-note light pulse instead of nothing.
  // 70% conditional on hat-c silence; some hat-c-silent generations skip
  // ride too for the "all polymeter, no straight comp" sound.
  const rideActive = !hatCActive && Math.random() < 0.7;
  // Toms — single-hit accents at random rotation. Low activation; toms are
  // loud acoustic samples that punch through the mix.
  const floorActive = Math.random() < 0.22;
  const rackActive = Math.random() < 0.22;
  const floorRot = randInt(0, 12);
  const rackRot = randInt(0, 12);

  // Motif density pulled back — acoustic-context tuning. Prior range
  // 0.30-0.50 read as too many melodic stabs against the now-sparser drum
  // kit; new range 0.18-0.30 gives a counter-line that breathes.
  const motifDensity = 0.18 + Math.random() * 0.12;
  // Second motif — 40% (was 60%) so most generations run a single melodic
  // line. Density floor pulled lower so when it does land, it sits behind
  // motif 0 as occasional color rather than a parallel voice.
  const motif2Active = Math.random() < 0.4;
  const motif2Len = randomFrom([10, 12, 15]);
  const motif2Density = 0.1 + Math.random() * 0.12;

  let melodicSlot = -1;
  let drumSlot = -1;
  const tracks = ctx.tracks.map((t) => {
    if (t.section === 'drum') {
      drumSlot++;
      const voice = drumVoiceForSlot(drumSlot);
      const base = populateDrum(t, voice);
      // Per-slot activation gates each non-kick drum. Inactive slots get
      // silenceTrack so their default mutation (0.18) doesn't fire flips on
      // the all-OFF authored pattern.
      if (drumSlot === 0)
        return applyProgrammedSteps(base, kickAuthoredSteps, 16, '1/16');
      if (drumSlot === 1) {
        if (!snareActive) return silenceTrack(base);
        return snareAnchor
          ? applyProgrammedSteps(base, snareAnchorSteps, 16, '1/16')
          : applyEuclideanPattern(base, snareHits, snareRot, snareLen, '1/16');
      }
      if (drumSlot === 2) {
        if (!hatCActive) return silenceTrack(base);
        return hatCAnchor
          ? applyProgrammedSteps(base, hatCAnchorSteps, 16, '1/16', 0.65)
          : applyEuclideanPattern(base, hatCHits, hatCRot, hatCLen, '1/16', 0.65);
      }
      if (drumSlot === 3)
        return hatOActive ? applyEuclideanPattern(base, hatOHits, hatORot, hatOLen, '1/16') : silenceTrack(base);
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
      if (melodicSlot === 0)
        return chordMasterPattern(populateChordMaster(t, activeVoice(t, palette.chordMaster)), chordPlan.changes, chordPlan.length, '1/16');
      // Bass = skeleton (locked to kick downbeats). Every bass retrigger
      // picks up the currently-published chord via chord context, so this
      // works across all chord-plan lengths.
      if (melodicSlot === 1)
        return bassPattern(populateBass(t, activeVoice(t, palette.bass)), skeleton, 16, '1/16');
      if (melodicSlot === 2)
        return motifPattern(populateMotif(t, activeVoice(t, palette.motifs[0])), motifLen, '1/16', motifDensity);
      if (melodicSlot === 3) {
        const base = populateMotif(t, activeVoice(t, palette.motifs[1]));
        return motif2Active ? motifPattern(base, motif2Len, '1/16', motif2Density) : silenceTrack(base);
      }
      if (melodicSlot === 4) return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[2])));
      // Flavor 1 active as atmospheric layer; flavors 2-3 silent. Flavor
      // length stays at 16 with [0,8] hits — must align with the 2-chord
      // progression's chord-change rhythm to avoid harmonic clash (sustained
      // flavor note holding bar 0's root while chord master moved to bar 0's
      // second chord).
      if (melodicSlot === 5)
        return flavorSustained(populateFlavor(t, activeVoice(t, palette.flavors[0])), [0, 8], 16, '1/16', 0.55);
      if (melodicSlot === 6) return populateFlavor(t, activeVoice(t, palette.flavors[1]));
      if (melodicSlot === 7) return populateFlavor(t, activeVoice(t, palette.flavors[2]));
      return cloneTrack(t);
    }
    return cloneTrack(t);
  });
  return {
    tracks,
    macros: { density: 0.4, chaos: 0.55, motion: 0.5, drift: 0.8, tension: 0.6 },
    kind: 'scene',
  };
}
