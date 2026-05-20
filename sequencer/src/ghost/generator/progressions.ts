import { type StepRate, type Track } from '../../state/store';
import { CHORD_MASTER_DEFAULT, type ChordDegree } from '../../audio/chords';
import { emptyStep, emptyStepsArr, chordStep, noteStep } from './primitives';

// ----------------------------------------------------------------------------
// COMPOSE MOVES
// ----------------------------------------------------------------------------

// Pick a chord progression in the current scale. For v0 every progression is
// 2-chord (degrees at steps 0 and 8 within a 16-step / 1-bar-at-1/16 row) or
// 4-chord (steps 0, 4, 8, 12). The actual quality (maj/min/dim) falls out of
// the scale's intervals — the user's scene rootNote+scale determines that
// automatically via the existing chord-context machinery.
const PROGRESSIONS_2: Array<[ChordDegree, ChordDegree]> = [
  [1, 5],
  [1, 4],
  [1, 6],
  [6, 5],
];
const PROGRESSIONS_4: Array<[ChordDegree, ChordDegree, ChordDegree, ChordDegree]> = [
  [1, 5, 6, 4],
  [1, 6, 4, 5],
  [6, 4, 1, 5],
  [1, 4, 6, 5],
];
// 6-chord progressions — extended phrases with non-repeating motion and
// occasional iii color. Useful at length 48 (chord per half-bar over 3 bars)
// for slow harmonic motion that's still in motion. Each is diatonic to the
// scene scale (quality falls out automatically).
const PROGRESSIONS_6: ChordDegree[][] = [
  [1, 5, 6, 3, 4, 5],     // axis with iii color resolving back to V
  [6, 4, 1, 5, 4, 5],     // extended Andalusian with V-IV-V tail
  [1, 4, 5, 4, 6, 5],     // folk-leaning with vi suspension
  [1, 6, 4, 5, 6, 5],     // pop-modal pivot around V
  [1, 3, 4, 5, 6, 4],     // ascending opening into pop turn
];
// 8-chord progressions — 4-bar phrases with strong shape. Pachelbel-style
// cycles, modal drift, and doubled pop loops. At length 64 (chord per half-
// bar over 4 bars) these read as "the long arc" — a slow-but-active scene.
const PROGRESSIONS_8: ChordDegree[][] = [
  [1, 5, 6, 3, 4, 1, 4, 5],   // Canon in D / Pachelbel — heavy post-rock vocabulary
  [6, 5, 4, 5, 6, 5, 4, 5],   // minor-key cycling, V as pivot
  [1, 6, 4, 5, 1, 6, 4, 5],   // doubled 50s — turns into a riff
  [6, 3, 4, 1, 6, 3, 4, 1],   // modal drift, no V cadence
  [1, 4, 6, 5, 4, 6, 1, 5],   // non-repeating 8-bar phrase
];

// Chord plan bundles the chord change positions with the chord-master row
// length they're meant to live in. Bass/flavor patterns stay at length 16
// regardless — their retriggers pick up whatever chord is currently published
// to the chord context, so a length-32 chord master with length-16 bass
// means the bass cycles twice while harmony moves once (musically: bass
// follows along, hitting each chord on its retrigger).
export interface ChordPlan {
  changes: Array<{ step: number; degree: ChordDegree }>;
  length: number;
}

function pickProgression2(): Array<{ step: number; degree: ChordDegree }> {
  const prog = PROGRESSIONS_2[Math.floor(Math.random() * PROGRESSIONS_2.length)];
  return [
    { step: 0, degree: prog[0] },
    { step: 8, degree: prog[1] },
  ];
}

function pickProgression4(): Array<{ step: number; degree: ChordDegree }> {
  const prog = PROGRESSIONS_4[Math.floor(Math.random() * PROGRESSIONS_4.length)];
  return [
    { step: 0, degree: prog[0] },
    { step: 4, degree: prog[1] },
    { step: 8, degree: prog[2] },
    { step: 12, degree: prog[3] },
  ];
}

// Fast 2-chord: chord per half-bar over 1 bar (current default). Steady,
// short-cycle harmony.
export function pickPlanFast2(): ChordPlan {
  return { changes: pickProgression2(), length: 16 };
}

// Slow 2-chord: chord per bar over 2 bars. "One chord per bar" is the
// classic post-rock / shoegaze pacing.
export function pickPlanSlow2(): ChordPlan {
  const prog = PROGRESSIONS_2[Math.floor(Math.random() * PROGRESSIONS_2.length)];
  return {
    changes: [
      { step: 0, degree: prog[0] },
      { step: 16, degree: prog[1] },
    ],
    length: 32,
  };
}

// Fast 4-chord: chord per quarter beat over 1 bar (current melodic default).
// Lots of harmonic motion packed tight.
export function pickPlanFast4(): ChordPlan {
  return { changes: pickProgression4(), length: 16 };
}

// Slow 4-chord: chord per half-bar over 2 bars. The "slow progression"
// option the chord-progression system was originally designed to support —
// 4-chord movement at half the speed of the current melodic default.
export function pickPlanSlow4(): ChordPlan {
  const prog = PROGRESSIONS_4[Math.floor(Math.random() * PROGRESSIONS_4.length)];
  return {
    changes: [
      { step: 0, degree: prog[0] },
      { step: 8, degree: prog[1] },
      { step: 16, degree: prog[2] },
      { step: 24, degree: prog[3] },
    ],
    length: 32,
  };
}

// Very slow 4-chord: chord per bar over 4 bars. The longest "still feels
// like a 4-chord progression" pacing — each chord gets a full bar.
export function pickPlanVerySlow4(): ChordPlan {
  const prog = PROGRESSIONS_4[Math.floor(Math.random() * PROGRESSIONS_4.length)];
  return {
    changes: [
      { step: 0, degree: prog[0] },
      { step: 16, degree: prog[1] },
      { step: 32, degree: prog[2] },
      { step: 48, degree: prog[3] },
    ],
    length: 64,
  };
}

// 6-chord progression: chord per half-bar over 3 bars (length 48). Extended
// phrase with non-repeating motion — bass at length 16 hits each chord once
// across the cycle.
export function pickPlanSlow6(): ChordPlan {
  const prog = PROGRESSIONS_6[Math.floor(Math.random() * PROGRESSIONS_6.length)];
  return {
    changes: prog.map((degree, i) => ({ step: i * 8, degree })),
    length: 48,
  };
}

// 8-chord progression: chord per half-bar over 4 bars (length 64). Long arc
// — 4 bars of harmonic movement per cycle, with Pachelbel-flavored or modal
// progressions filling the phrase.
export function pickPlanSlow8(): ChordPlan {
  const prog = PROGRESSIONS_8[Math.floor(Math.random() * PROGRESSIONS_8.length)];
  return {
    changes: prog.map((degree, i) => ({ step: i * 8, degree })),
    length: 64,
  };
}

// Weighted-roll picker: pool entries can repeat to bias the selection.
export function pickChordPlan(weighted: Array<() => ChordPlan>): ChordPlan {
  return weighted[Math.floor(Math.random() * weighted.length)]();
}

export function chordMasterPattern(
  track: Track,
  changes: Array<{ step: number; degree: ChordDegree }>,
  length: number,
  rate: StepRate
): Track {
  const steps = emptyStepsArr();
  for (const c of changes) {
    if (c.step < length) steps[c.step] = chordStep(c.degree);
  }
  return {
    ...track,
    steps,
    length,
    rate,
    euclidean: { hits: 0, rotation: 0 },
    defaultChordVoicing: { ...CHORD_MASTER_DEFAULT },
  };
}

export function bassPattern(
  track: Track,
  hitSteps: number[],
  length: number,
  rate: StepRate
): Track {
  // Bass holds each note via a tieToNext chain until the step before the next
  // hit (or the end of the pattern). Single-step bass hits sound mechanical;
  // sustained notes between retriggers are how bass actually plays. Each hit
  // is the root of the current chord (pitch=0 in chord-tone mode); the chord
  // context machinery handles the actual midi note.
  const steps = emptyStepsArr();
  const sorted = [...hitSteps].filter((h) => h < length).sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const hit = sorted[i];
    const nextHit = sorted[i + 1] ?? length;
    // Hit step: triggers the note, opens the tie chain.
    steps[hit] = { ...emptyStep(), on: true, velocity: 0.9, pitch: 0, tieToNext: true };
    // Intermediate steps: hold the note (tieToNext=true). The dispatch's
    // isSilencedByTie machinery prevents these from retriggering even if
    // step.on is set elsewhere.
    for (let j = hit + 1; j < nextHit - 1 && j < length; j++) {
      steps[j] = { ...emptyStep(), pitch: 0, tieToNext: true };
    }
    // Break the chain on the last step before the next hit so the note
    // releases cleanly rather than carrying into the next retrigger.
    const breakStep = nextHit - 1;
    if (breakStep > hit && breakStep < length) {
      steps[breakStep] = { ...emptyStep(), pitch: 0, tieToNext: false };
    }
  }
  return {
    ...track,
    steps,
    length,
    rate,
    euclidean: { hits: 0, rotation: 0 },
  };
}

// Flavor pattern — like bass but with gate=2 and lower velocity. One hit per
// chord-change position, tied chain to sustain the note between changes.
// pitchInterp is chord-tone (set via populateFlavor) with pitch=0 → plays
// the current chord's root through ties. Each retrigger picks up the new
// chord's root via the chord context machinery.
export function flavorSustained(
  track: Track,
  hitSteps: number[],
  length: number,
  rate: StepRate,
  velocity = 0.55
): Track {
  const steps = emptyStepsArr();
  const sorted = [...hitSteps].filter((h) => h < length).sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    const hit = sorted[i];
    const nextHit = sorted[i + 1] ?? length;
    steps[hit] = {
      ...emptyStep(),
      on: true,
      velocity,
      pitch: 0,
      tieToNext: true,
      gate: 2,
    };
    for (let j = hit + 1; j < nextHit - 1 && j < length; j++) {
      steps[j] = { ...emptyStep(), pitch: 0, tieToNext: true };
    }
    const breakStep = nextHit - 1;
    if (breakStep > hit && breakStep < length) {
      steps[breakStep] = { ...emptyStep(), pitch: 0, tieToNext: false };
    }
  }
  return {
    ...track,
    steps,
    length,
    rate,
    euclidean: { hits: 0, rotation: 0 },
  };
}

export function motifPattern(
  track: Track,
  length: number,
  rate: StepRate,
  density: number
): Track {
  // Random chord-tone walks. step.pitch in chord-tone mode is an index into
  // the chord's intervals (0=root, 1=3rd, 2=5th, 3=7th).
  const steps = emptyStepsArr();
  for (let i = 0; i < length; i++) {
    if (Math.random() < density) {
      const chordTone = Math.floor(Math.random() * 4);
      steps[i] = noteStep(chordTone, 0.7 + Math.random() * 0.2);
    }
  }
  return {
    ...track,
    steps,
    length,
    rate,
    euclidean: { hits: 0, rotation: 0 },
  };
}
