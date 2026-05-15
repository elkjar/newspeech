import type { BankSlot, Track } from '../../state/store';
import type { Scale } from '../../audio/scale';

// Two flavors of generation:
//   - "variant" moves take an existing bank as source and produce a perturbed
//     version of it (the original Wreckage Systems-curation framing — user's
//     authored material is the seed).
//   - "compose" moves generate from scratch using the current track structure
//     (track IDs, sections, voice assignments) + key/scale + the existing
//     musical primitives (Euclidean, chord context, pitch interp modes). No
//     source bank needed — the composition is autonomous.
//
// Textural (not narrative) labels for compose intents — sparse / polyrhythmic
// / melodic / drums-only. Per user: "we don't really need to ask it to
// generate a 'verse' or anything like that" since the sample library doesn't
// carry energy metadata yet. The textural framing maps directly onto controls
// we already have (track lengths, Euclidean hits, per-row rates, density
// macro, which sections are populated).

export type GenMove =
  | 'compose-sparse'
  | 'compose-poly'
  | 'compose-melodic'
  | 'compose-drums'
  | 'compose-build'
  | 'compose-hits'
  | 'compose-ambient'
  | 'compose-halftime'
  | 'compose-dance'
  | 'compose-driving';

export const GEN_MOVE_LABELS: Record<GenMove, string> = {
  'compose-sparse': 'sparse',
  'compose-poly': 'polyrhythmic',
  'compose-melodic': 'melodic',
  'compose-drums': 'drums only',
  'compose-build': 'build',
  'compose-hits': 'hits',
  'compose-ambient': 'ambient',
  'compose-halftime': 'halftime',
  'compose-dance': 'dance',
  'compose-driving': 'driving',
};

// Per-recipe natural dwell ranges (bars). The conductor reads these from
// the currently-active bank's `recipe` field to override the global
// sceneGraph min/max. Each recipe has a musical-natural duration:
//   - build / hits: punctuation moments — loop once or twice max
//   - ambient: atmospheric, can stretch long
//   - drums-only: short showcase break
//   - song-body recipes (sparse, melodic, driving, dance, halftime, poly): 4-8 bars
export const RECIPE_DWELL: Record<GenMove, { min: number; max: number }> = {
  'compose-ambient': { min: 6, max: 12 },
  'compose-sparse': { min: 4, max: 8 },
  'compose-melodic': { min: 4, max: 8 },
  'compose-dance': { min: 4, max: 8 },
  'compose-driving': { min: 4, max: 8 },
  'compose-halftime': { min: 3, max: 6 },
  'compose-poly': { min: 4, max: 8 },
  'compose-drums': { min: 1, max: 2 },
  'compose-build': { min: 1, max: 2 },
  'compose-hits': { min: 3, max: 6 },
};

export const COMPOSE_MOVES: GenMove[] = [
  'compose-ambient',
  'compose-sparse',
  'compose-melodic',
  'compose-dance',
  'compose-driving',
  'compose-halftime',
  'compose-poly',
  'compose-drums',
  'compose-build',
  'compose-hits',
];

export interface ComposeContext {
  tracks: Track[];
  rootNote: number;
  scale: Scale;
}

export type MoveDef = { fn: (ctx: ComposeContext) => BankSlot };
