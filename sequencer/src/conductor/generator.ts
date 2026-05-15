import {
  useSequencerStore,
  cloneTrack,
  BANK_SLOT_COUNT,
  TRANSITION_SLOT_START,
  type BankSlot,
  type BankKind,
  type Step,
  type StepRate,
  type Track,
} from '../state/store';
import { euclidean } from '../audio/euclidean';
import {
  CHORD_MASTER_DEFAULT,
  DEFAULT_CHORD_VOICING,
  type ChordDegree,
  type ChordVoicing,
} from '../audio/chords';
import type { Scale } from '../audio/scale';
import { voiceTrackDefaults } from '../audio/voices';
import { DEFAULT_TRACK_MIDI } from '../state/store';

// Voice pools by role. Composer picks one voice per role per compose call so
// the resulting bank has consistent timbre across each row's lifetime. All
// IDs match the existing VOICES list — anything renamed/added there should be
// reflected here too. The curation lives in the sample library + Faust output
// chain (not in this taxonomy); these pools just sort the curated voices by
// the role they're best suited to.
const CHORD_MASTER_VOICES = [
  'rhodes-mk1',
  'soft-piano',
  'tape-piano',
  'under-piano',
  'encounter',
  'pulsed',
  'sinewaves-scope',
];

// Track.monophonic = true on bass tracks (set by populateBass) handles the
// retrigger choke for long-sustain voices like mini-moog when used as bass.
// The same voice stays polyphonic when picked for motif/flavor roles.
const BASS_VOICES = ['bass', 'mini-moog'];

const MOTIF_VOICES = [
  'rhodes-mk1',
  'soft-piano',
  'tape-piano',
  'under-piano',
  'hydra-plaits',
  'mini-moog',
  'root-grain',
  'sinewaves-scope',
];

// Flavor voices — pad-y / atmospheric. Sit behind the rhythmic content as
// sustained layers, follow chord changes via chord-tone pitchInterp.
const FLAVOR_VOICES = [
  'encounter',
  'pulsed',
  'sinewaves-scope',
  'under-piano',
  'tape-piano',
];

// Drum kit layout — locked to ns-kit-1. Slot index = positional role:
//   0 kick / 1 snare / 2 hat-c / 3 hat-o / 4 cym (crash) /
//   5 ride / 6 floortom / 7 racktom
// Locking the layout (rather than rolling percussion picks per session)
// lets the conductor reason about each slot SEMANTICALLY — cym is for
// phrase accents, ride is the ambient/sparse comp voice, toms are fill
// accents. blck_noir voices stay available via the manual picker.
const DRUM_BY_SLOT = [
  'ns1-kick',
  'ns1-snare',
  'ns1-hat-c',
  'ns1-hat-o',
  'ns1-cym',
  'ns1-ride',
  'ns1-floortom',
  'ns1-racktom',
] as const;

function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Inclusive integer in [min, max]. Used to roll fresh Euclidean params per
// compose call so two compose-X invocations don't produce identical drum
// patterns. Voice picks already varied; rhythmic params do too now.
function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function drumVoiceForSlot(slot: number): string {
  return DRUM_BY_SLOT[slot] ?? DRUM_BY_SLOT[DRUM_BY_SLOT.length - 1];
}

// Band-identity resolver. Applied to MELODIC voices only (chord master,
// bass, motifs, flavors) — if the track already has a voice assigned,
// compose moves preserve it so user-driven voice swaps persist across
// new bank generations. Falls back to the palette pick only when the
// slot is empty.
//
// DRUM voices are NOT routed through this — they always use DRUM_BY_SLOT
// directly. The drum kit layout is intentionally locked (slot 0 = kick,
// 1 = snare, etc. all ns-kit-1), so auto-generated banks consistently
// use the kit regardless of what the default-preset's drum slots happen
// to be set to.
function activeVoice(t: Track, fallback: string): string {
  return t.source.kind === 'voice' ? t.source.id : fallback;
}

// Voice palette — session-scoped band identity. First compose call (any
// intent) picks all the voices; subsequent compose calls reuse them so
// transitions feel like the same ensemble playing different ideas rather
// than swapping to a different ensemble entirely. Module-scope so page
// reload regenerates; expose resetPalette() for explicit "fresh band"
// reset via UI.
interface VoicePalette {
  chordMaster: string;
  bass: string;
  motifs: string[]; // length 3
  flavors: string[]; // length 3
}

let currentPalette: VoicePalette | null = null;

// Fisher-Yates shuffle, then slice — guarantees distinct picks. Falls back
// to random-with-repeat if requested count exceeds pool size.
function pickDistinctVoices(pool: readonly string[], count: number): string[] {
  if (count >= pool.length) {
    const out: string[] = [];
    for (let i = 0; i < count; i++) out.push(pool[i % pool.length]);
    return out;
  }
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

function getOrCreatePalette(): VoicePalette {
  if (currentPalette) return currentPalette;
  currentPalette = {
    chordMaster: randomFrom(CHORD_MASTER_VOICES),
    bass: randomFrom(BASS_VOICES),
    motifs: pickDistinctVoices(MOTIF_VOICES, 3),
    flavors: pickDistinctVoices(FLAVOR_VOICES, 3),
  };
  return currentPalette;
}

export function resetPalette(): void {
  currentPalette = null;
}

export function getCurrentPalette(): VoicePalette | null {
  return currentPalette;
}

// Per-role mutation + fxSend defaults. The composer applies these in populate
// helpers so generated tracks are immediately routed into the FX chain and
// participate in the existing mutation pipeline rather than sounding sterile.
// Chaos macro globally multiplies mutation at dispatch — these baselines tune
// the per-role "starting point" the macro lenses sit on top of.
const ROLE_DEFAULTS = {
  chordMaster: { mutation: 0.08, fxSend: 0.55 },
  bass: { mutation: 0.05, fxSend: 0.18 },
  motif: { mutation: 0.22, fxSend: 0.42 },
  flavor: { mutation: 0, fxSend: 0.7 },
  drum: { mutation: 0.18, fxSend: 0.22 },
} as const;

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

interface ComposeContext {
  tracks: Track[];
  rootNote: number;
  scale: Scale;
}

type MoveDef = { fn: (ctx: ComposeContext) => BankSlot };

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

function emptyStep(): Step {
  return {
    on: false,
    velocity: 1,
    pitch: 0,
    probability: 100,
    ratchet: 1,
    microTiming: 0,
    gate: 1,
    tieToNext: false,
  };
}

function emptyStepsArr(): Step[] {
  return Array.from({ length: 64 }, emptyStep);
}

function applyEuclideanPattern(
  track: Track,
  hits: number,
  rotation: number,
  length: number,
  rate: StepRate,
  velocityBase = 0.85
): Track {
  const pattern = euclidean(length, hits, rotation);
  const steps = emptyStepsArr();
  for (let i = 0; i < length; i++) {
    if (pattern[i]) {
      steps[i] = {
        ...steps[i],
        on: true,
        velocity: velocityBase + Math.random() * 0.15,
      };
    }
  }
  return {
    ...track,
    steps,
    length,
    rate,
    euclidean: { hits, rotation },
  };
}

// Direct step-position placement — used when a compose move wants explicit
// hit locations rather than the even spacing euclidean gives. Velocity gets
// the same small jitter as applyEuclideanPattern so authored and generated
// hits sit at the same dynamic level. Optional `gate` shortens each hit's
// note duration — useful for "stab" patterns (hits, accents) where the
// long sample tail would smear the rapid changes.
function applyProgrammedSteps(
  track: Track,
  hitSteps: number[],
  length: number,
  rate: StepRate,
  velocityBase = 0.85,
  gate = 1,
): Track {
  const steps = emptyStepsArr();
  for (const hit of hitSteps) {
    if (hit >= 0 && hit < length) {
      steps[hit] = {
        ...steps[hit],
        on: true,
        velocity: velocityBase + Math.random() * 0.15,
        gate,
      };
    }
  }
  return {
    ...track,
    steps,
    length,
    rate,
    euclidean: { hits: hitSteps.length, rotation: 0 },
  };
}

// Hits-recipe character — push fxSend high (band runs through tape/glitch/
// saturation for the distorted "big riff" character the recipe wants) and
// shorten gates on authored ON steps so each chord change punches instead
// of smearing into the next. Used by composeHits across every voice in the
// stab. Drum gate is harmless to set (samples play their full decay) but
// chord-master / bass gates produce real audible "stab" character.
function applyHitsCharacter(t: Track, fxSend = 0.95, gate = 0.45): Track {
  return {
    ...t,
    fxSend,
    steps: t.steps.map((s) => (s.on ? { ...s, gate } : s)),
  };
}

// Voice-default merge — applies per-voice trackDefaults (filterCutoff /
// fxSend / gain / etc) on top of whatever the role populate just set.
// Voice defaults represent voice-specific tone knowledge (rhodes wants its
// cutoff at 52% to sit cleanly; mini-moog needs gain trimmed because the
// sample is hot). Same mechanism the manual setTrackSource path uses.
function applyVoiceDefaults(t: Track, voiceId: string): Track {
  const def = voiceTrackDefaults(voiceId);
  if (!def) return t;
  return { ...t, ...def };
}

// Voice-assigned-but-silent helper. Inactive drum / motif slots stay
// voice-assigned for kit-layout stability across bank swaps, but their
// authored steps are all OFF. populateDrum/populateMotif assign non-zero
// mutation defaults (drum 0.18, motif 0.22), which would otherwise flip
// authored-OFF steps to ON via the dispatch's mutation logic — silent
// channels would still fire random hits. Zero mutation and rowRatchet on
// inactive slots to truly silence them.
function silenceTrack(t: Track): Track {
  return { ...t, mutation: 0, rowRatchet: 0 };
}

// Strip a track to a known-default per-track state, preserving only identity
// (id, section). Used both for tracks that compose decides to leave empty
// and as the base for tracks compose is about to populate. Distinct from
// hydrate.ts `blankTrack` which also resets `section` — we keep section
// because it's structural to the track's slot identity.
function emptyTrackForCompose(t: Track): Track {
  return {
    id: t.id,
    section: t.section,
    source: { kind: 'empty' },
    steps: emptyStepsArr(),
    mute: false,
    solo: false,
    length: 16,
    lastPitch: 0,
    viewPage: 0,
    mutation: 0,
    rowRatchet: 0,
    rate: '1/16',
    lockTiming: false,
    euclidean: { hits: 0, rotation: 0 },
    midi: { ...DEFAULT_TRACK_MIDI },
    gain: 1,
    fxSend: 0,
    pan: 0.5,
    filterCutoff: 1,
    filterResonance: 0,
    defaultChordVoicing: { ...DEFAULT_CHORD_VOICING },
    pitchInterp: 'semitones',
    octave: 0,
    monophonic: false,
  };
}

function populateChordMaster(t: Track, voiceId: string): Track {
  return applyVoiceDefaults({
    ...emptyTrackForCompose(t),
    source: { kind: 'voice', id: voiceId },
    pitchInterp: 'semitones',
    defaultChordVoicing: { ...CHORD_MASTER_DEFAULT },
    octave: 0,
    mutation: ROLE_DEFAULTS.chordMaster.mutation,
    fxSend: ROLE_DEFAULTS.chordMaster.fxSend,
  }, voiceId);
}

function populateBass(t: Track, voiceId: string): Track {
  return applyVoiceDefaults({
    ...emptyTrackForCompose(t),
    source: { kind: 'voice', id: voiceId },
    pitchInterp: 'chord-tone',
    octave: -2,
    mutation: ROLE_DEFAULTS.bass.mutation,
    fxSend: ROLE_DEFAULTS.bass.fxSend,
    // Bass is monophonic — long-sustain bass voices (mini-moog) would
    // otherwise layer when retriggered. Motif/flavor variants of the same
    // voice stay polyphonic because they use populateMotif/populateFlavor
    // which leave monophonic at the emptyTrackForCompose default (false).
    monophonic: true,
  }, voiceId);
}

function populateMotif(t: Track, voiceId: string): Track {
  return applyVoiceDefaults({
    ...emptyTrackForCompose(t),
    source: { kind: 'voice', id: voiceId },
    pitchInterp: 'chord-tone',
    octave: 0,
    mutation: ROLE_DEFAULTS.motif.mutation,
    fxSend: ROLE_DEFAULTS.motif.fxSend,
  }, voiceId);
}

function populateDrum(t: Track, voiceId: string): Track {
  return applyVoiceDefaults({
    ...emptyTrackForCompose(t),
    source: { kind: 'voice', id: voiceId },
    pitchInterp: 'semitones',
    octave: 0,
    mutation: ROLE_DEFAULTS.drum.mutation,
    fxSend: ROLE_DEFAULTS.drum.fxSend,
  }, voiceId);
}

// Flavor track — atmospheric pad layer. Sustained between chord changes,
// chord-tone interp so it tracks the harmony, lower gain so it sits behind
// the rhythmic content. Mutation locked to 0 (this is a stable bed, not
// a varied element).
function populateFlavor(t: Track, voiceId: string): Track {
  return applyVoiceDefaults({
    ...emptyTrackForCompose(t),
    source: { kind: 'voice', id: voiceId },
    pitchInterp: 'chord-tone',
    octave: 0,
    mutation: ROLE_DEFAULTS.flavor.mutation,
    fxSend: ROLE_DEFAULTS.flavor.fxSend,
    gain: 0.7,
  }, voiceId);
}

function chordStep(degree: ChordDegree, velocity = 1): Step {
  const voicing: ChordVoicing = { ...CHORD_MASTER_DEFAULT, degree };
  return { ...emptyStep(), on: true, velocity, chordVoicing: voicing };
}

function noteStep(pitch: number, velocity = 0.9): Step {
  return { ...emptyStep(), on: true, velocity, pitch };
}

function chordMasterPattern(
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

function bassPattern(
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
function flavorSustained(
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

function motifPattern(
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
interface ChordPlan {
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
function pickPlanFast2(): ChordPlan {
  return { changes: pickProgression2(), length: 16 };
}

// Slow 2-chord: chord per bar over 2 bars. "One chord per bar" is the
// classic post-rock / shoegaze pacing.
function pickPlanSlow2(): ChordPlan {
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
function pickPlanFast4(): ChordPlan {
  return { changes: pickProgression4(), length: 16 };
}

// Slow 4-chord: chord per half-bar over 2 bars. The "slow progression"
// option the chord-progression system was originally designed to support —
// 4-chord movement at half the speed of the current melodic default.
function pickPlanSlow4(): ChordPlan {
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
function pickPlanVerySlow4(): ChordPlan {
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
function pickPlanSlow6(): ChordPlan {
  const prog = PROGRESSIONS_6[Math.floor(Math.random() * PROGRESSIONS_6.length)];
  return {
    changes: prog.map((degree, i) => ({ step: i * 8, degree })),
    length: 48,
  };
}

// 8-chord progression: chord per half-bar over 4 bars (length 64). Long arc
// — 4 bars of harmonic movement per cycle, with Pachelbel-flavored or modal
// progressions filling the phrase.
function pickPlanSlow8(): ChordPlan {
  const prog = PROGRESSIONS_8[Math.floor(Math.random() * PROGRESSIONS_8.length)];
  return {
    changes: prog.map((degree, i) => ({ step: i * 8, degree })),
    length: 64,
  };
}

// Weighted-roll picker: pool entries can repeat to bias the selection.
function pickChordPlan(weighted: Array<() => ChordPlan>): ChordPlan {
  return weighted[Math.floor(Math.random() * weighted.length)]();
}

// SPARSE — minimal kick + tasteful hat (length 13 drifts against the kick's
// 16-bar loop), slow chord progression, bass on downbeats. Macros pulled
// low for a meditative feel. Chord master + bass stay at length 16 as the
// harmonic anchor layer. Each call randomizes across 5 dimensions (kick
// shape, hat-c length, bass placement, motif activation/slot/length, flavor
// length) so two sparse generations don't sound the same.
function composeSparse(ctx: ComposeContext): BankSlot {
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
    macros: { density: 0.25, chaos: 0.2, motion: 0.4, drift: 0.7, tension: 0.3 },
    kind: 'scene',
  };
}

// POLYRHYTHMIC — vary track lengths so the layers drift in and out of phase.
// All drum slots active (kick + snare + hat-c + hat-o + perc), motif at odd
// length. Chord master at standard 16-step length so the harmonic skeleton
// stays referenceable. Lengths AND hits AND rotations all randomized per
// call — same intent, different specifics each Generate.
function composePolyrhythmic(ctx: ComposeContext): BankSlot {
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

// MELODIC — chord master + bass + 2 motifs, minimal drum support. 4-chord
// progression for harmonic interest, motion macro up so the chord context
// shifts over time. Hat-c at length 11, motifs at lengths 13/14 — drifting
// against the length-16 chord master + bass anchor. Two motifs at different
// odd lengths produce intersecting melodic lines that re-align rarely.
function composeMelodic(ctx: ComposeContext): BankSlot {
  const palette = getOrCreatePalette();
  // Melodic weights toward 4+ chord movement — this is the harmony-forward
  // recipe so the longer progressions belong here most heavily. slow8 and
  // slow6 give 4-bar / 3-bar arcs under the busy motifs; slow4 is the
  // "spacious 4-chord" option; fast4 carves out the original behavior.
  const chordPlan = pickChordPlan([
    pickPlanSlow4,
    pickPlanSlow4,
    pickPlanSlow6,
    pickPlanSlow8,
    pickPlanFast4,
    pickPlanVerySlow4,
  ]);

  // Structural skeleton — melodic uses quarter-note skeleton since bass plays
  // every quarter (harmony-forward recipe). Kick = SUBSET of skeleton (kick
  // less dense than bass for the melodic feel: bass walks the chords, kick
  // marks the strong beats only).
  const skeleton = [0, 4, 8, 12];
  // Kick: always step 0, plus 1-2 more picks from {4, 8, 12}. So kick is a
  // 2-3 hit subset of bass's positions. Always rhythmically aligned.
  const kickAuthoredSteps = (() => {
    const pool = [4, 8, 12];
    const picked = [0];
    const extras = randInt(1, 2);
    for (let i = 0; i < extras && pool.length > 0; i++) {
      const idx = Math.floor(Math.random() * pool.length);
      picked.push(pool.splice(idx, 1)[0]);
    }
    return picked.sort((a, b) => a - b);
  })();
  const hatCLen = randomFrom([10, 11, 12]);
  const hatCHits = Math.min(hatCLen, randInt(4, 7));
  const hatCRot = randInt(1, 3);
  const motifALen = randomFrom([11, 13, 14]);
  const motifBLen = randomFrom([12, 14, 15]);
  // Motif densities pulled back to match the acoustic-context drum tuning.
  // Was A 0.25-0.45 / B 0.35-0.60 — two motifs at those densities piled into
  // each other under the new drum sparsity. New ranges: A 0.15-0.30 / B
  // 0.20-0.40 (B still slightly busier as the lead voice; both breathe).
  const motifADensity = 0.15 + Math.random() * 0.15;
  const motifBDensity = 0.2 + Math.random() * 0.2;

  let melodicSlot = -1;
  let drumSlot = -1;
  const tracks = ctx.tracks.map((t) => {
    if (t.section === 'drum') {
      drumSlot++;
      const voice = drumVoiceForSlot(drumSlot);
      const base = populateDrum(t, voice);
      // Light drum support — kick + hat-c only. Other drums voice-assigned
      // but silent for kit-layout stability across bank swaps; silenceTrack
      // zeros mutation so they don't fire flips.
      if (drumSlot === 0) return applyProgrammedSteps(base, kickAuthoredSteps, 16, '1/16', 0.5);
      if (drumSlot === 2) return applyEuclideanPattern(base, hatCHits, hatCRot, hatCLen, '1/16', 0.45);
      return silenceTrack(base);
    }
    if (t.section === 'melodic') {
      melodicSlot++;
      if (melodicSlot === 0)
        return chordMasterPattern(populateChordMaster(t, activeVoice(t, palette.chordMaster)), chordPlan.changes, chordPlan.length, '1/16');
      if (melodicSlot === 1)
        return bassPattern(populateBass(t, activeVoice(t, palette.bass)), skeleton, 16, '1/16');
      if (melodicSlot === 2)
        return motifPattern(populateMotif(t, activeVoice(t, palette.motifs[0])), motifALen, '1/16', motifADensity);
      if (melodicSlot === 3)
        return motifPattern(populateMotif(t, activeVoice(t, palette.motifs[1])), motifBLen, '1/16', motifBDensity);
      if (melodicSlot === 4) return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[2])));
      // Flavor 1 active — atmospheric pad behind the melodic lines.
      if (melodicSlot === 5)
        return flavorSustained(populateFlavor(t, activeVoice(t, palette.flavors[0])), [0, 4, 8, 12], 16, '1/16', 0.5);
      if (melodicSlot === 6) return populateFlavor(t, activeVoice(t, palette.flavors[1]));
      if (melodicSlot === 7) return populateFlavor(t, activeVoice(t, palette.flavors[2]));
      return cloneTrack(t);
    }
    return cloneTrack(t);
  });
  return {
    tracks,
    macros: { density: 0.5, chaos: 0.3, motion: 0.65, drift: 0.7, tension: 0.5 },
    kind: 'scene',
  };
}

// DRUMS ONLY — every drum role populated, melodic completely empty. Higher
// tension/chaos OK because no harmonic content to clash with. Kick stays at
// length 16 as the downbeat anchor; everything else drifts at odd lengths
// (snare 13, hat-c 11, hat-o 14, perc 12) — heavy polymeter, no aligned
// "groove" beyond the kick.
function composeDrumsOnly(ctx: ComposeContext): BankSlot {
  const palette = getOrCreatePalette();
  const kickHits = randInt(3, 5);
  const snareLen = randomFrom([11, 13, 14]);
  const snareHits = Math.min(snareLen, randInt(2, 3));
  const snareRot = randInt(3, 5);
  const hatCLen = randomFrom([10, 11, 12]);
  const hatCHits = Math.min(hatCLen, randInt(5, 8));
  const hatCRot = randInt(0, 2);
  const hatOLen = randomFrom([13, 14, 15]);
  const hatOHits = Math.min(hatOLen, randInt(2, 3));
  const hatORot = randInt(3, 5);
  // Cym (crash) — phrase accent on long cycle; ride for sustained comp;
  // toms as single accents at random rotation. Same semantic placement as
  // composePolyrhythmic but with higher activation rates since this is the
  // "drums-only" showcase recipe.
  const cymLen = randomFrom([32, 64]);
  const cymActive = Math.random() < 0.65;
  const rideActive = Math.random() < 0.45;
  const floorActive = Math.random() < 0.5;
  const rackActive = Math.random() < 0.45;
  const floorRot = randInt(0, 12);
  const rackRot = randInt(0, 12);

  let melodicSlot = -1;
  let drumSlot = -1;
  const tracks = ctx.tracks.map((t) => {
    if (t.section === 'drum') {
      drumSlot++;
      const voice = drumVoiceForSlot(drumSlot);
      const base = populateDrum(t, voice);
      if (drumSlot === 0) return applyEuclideanPattern(base, kickHits, 0, 16, '1/16');
      if (drumSlot === 1) return applyEuclideanPattern(base, snareHits, snareRot, snareLen, '1/16');
      if (drumSlot === 2) return applyEuclideanPattern(base, hatCHits, hatCRot, hatCLen, '1/16', 0.7);
      if (drumSlot === 3) return applyEuclideanPattern(base, hatOHits, hatORot, hatOLen, '1/16');
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
      // All melodic voice-assigned but silent — kit-layout stability across
      // bank swaps without firing any harmonic content. silenceTrack zeros
      // mutation so chord-master / bass / motif defaults (0.08 / 0.05 / 0.22)
      // don't flip authored-OFF steps into random hits.
      if (melodicSlot === 0) return silenceTrack(populateChordMaster(t, activeVoice(t, palette.chordMaster)));
      if (melodicSlot === 1) return silenceTrack(populateBass(t, activeVoice(t, palette.bass)));
      if (melodicSlot === 2) return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[0])));
      if (melodicSlot === 3) return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[1])));
      if (melodicSlot === 4) return silenceTrack(populateMotif(t, activeVoice(t, palette.motifs[2])));
      if (melodicSlot === 5) return populateFlavor(t, activeVoice(t, palette.flavors[0]));
      if (melodicSlot === 6) return populateFlavor(t, activeVoice(t, palette.flavors[1]));
      if (melodicSlot === 7) return populateFlavor(t, activeVoice(t, palette.flavors[2]));
      return cloneTrack(t);
    }
    return cloneTrack(t);
  });
  return {
    tracks,
    macros: { density: 0.6, chaos: 0.55, motion: 0.3, drift: 0.6, tension: 0.55 },
    kind: 'scene',
  };
}

// BUILD — caveman tribal build. Quarter-note toms hammering throughout the
// 4-bar (length 64) cycle, alternating floor / rack so every quarter has
// a tom hit. Kick anchors bar downbeats. Snare stays out for the first
// half (bars 0-1 = pure tom pound), enters with backbeats in bar 2, and
// explodes into an 8th-note roll in bar 3. Hat / cymbal / ride / motifs
// all silent — the build is rhythmic dynamics, not metal volume. Loops as
// a self-contained crescendo scene; pairs before hits or melodic in an arc.
function composeBuild(ctx: ComposeContext): BankSlot {
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
    macros: { density: 0.4, chaos: 0.15, motion: 0.3, drift: 0.5, tension: 0.7 },
    kind: 'scene',
  };
}

// HITS — angular riff of chord changes. Every voice in the band stabs
// together on shared positions, but those positions are off-grid and dense
// (4-7 hits per bar, sometimes 8-9 across 2 bars). Each hit gets its own
// chord — listener hears a flowing RIFF of harmonic motion instead of
// "four chords hit at once." Short gates make each chord stab punchy; max
// fxSend drives every voice through the FX bus for distorted character.
// Bass uses applyProgrammedSteps (no ties) so it punches each hit instead
// of sustaining between them. Flavor silent — sustained pad would smear
// the rapid chord changes.
function composeHits(ctx: ComposeContext): BankSlot {
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
    macros: { density: 0.6, chaos: 0.35, motion: 0.4, drift: 0.3, tension: 0.75 },
    kind: 'scene',
  };
}

// AMBIENT — zero rhythmic surface. No drums (or just a cymbal swell on
// scene start as a wash). Chord master with long slow progressions (slow6
// / slow8 weighted heaviest), bass + motifs silent, 1-3 flavor layers
// sustained on chord-aligned retriggers. The harmonic field IS the music
// — motion macro high so the chord context drifts. Pairs well as
// intro/outro/breakdown scenes in a song arc.
function composeAmbient(ctx: ComposeContext): BankSlot {
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
    macros: { density: 0.2, chaos: 0.1, motion: 0.7, drift: 0.6, tension: 0.4 },
    kind: 'scene',
  };
}

// HALFTIME — big heavy half-time feel. Length 32 (2-bar loop). Kick on bar
// downbeats only `[0, 16]`, snare on the half-time backbeat `[8, 24]` (= beat
// 3 of each bar, not beats 2 and 4). Crash repeating every quarter note
// across the cycle so its decay tails wash together into a wall-of-cymbals
// carpet that keeps time-keeping audible while the kick/snare feel slow.
// Hat / ride / toms / motifs silent — the BIG kick-snare + cymbal wash is
// the whole thing. Pairs as a doom/anthem section between sparse and hits.
function composeHalftime(ctx: ComposeContext): BankSlot {
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

// DANCE — 4-on-the-floor verse/chorus groove. Kick on every quarter,
// snare backbeats, hat-c carpet (8ths or 16ths), optional hat-o offbeat
// for disco lift. Bass locks to the quarter-note skeleton; chord plan
// lands on those same beats. Motif 0 active at medium density for a
// hooky melodic line over the pulse. Toms + ride silent — driving is
// pulse and propulsion, no fills.
function composeDance(ctx: ComposeContext): BankSlot {
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
    macros: { density: 0.5, chaos: 0.2, motion: 0.5, drift: 0.5, tension: 0.5 },
    kind: 'scene',
  };
}

// DRIVING — caveman 4-on-the-floor pound. 4-on-the-floor anchor but with a
// constant CRASH carpet instead of hi-hats — crash on every quarter is
// what makes it actually drive. Floortom doubles the kick on every
// quarter for thickness. No hi-hats (those are the "dance" feel),
// no motifs (caveman doesn't noodle), no ride. Just kick + snare +
// crash + tom-pound + bass-and-chord.
function composeDriving(ctx: ComposeContext): BankSlot {
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

// ----------------------------------------------------------------------------
// Dispatch
// ----------------------------------------------------------------------------

const MOVES: Record<GenMove, MoveDef> = {
  'compose-sparse': { fn: composeSparse },
  'compose-poly': { fn: composePolyrhythmic },
  'compose-melodic': { fn: composeMelodic },
  'compose-drums': { fn: composeDrumsOnly },
  'compose-build': { fn: composeBuild },
  'compose-hits': { fn: composeHits },
  'compose-ambient': { fn: composeAmbient },
  'compose-halftime': { fn: composeHalftime },
  'compose-dance': { fn: composeDance },
  'compose-driving': { fn: composeDriving },
};

function findEmptySlot(banks: (BankSlot | null)[], kind: BankKind): number | null {
  if (kind === 'transition') {
    for (let i = TRANSITION_SLOT_START; i < BANK_SLOT_COUNT; i++) {
      if (!banks[i]) return i;
    }
    return null;
  }
  for (let i = 0; i < TRANSITION_SLOT_START; i++) {
    if (!banks[i]) return i;
  }
  return null;
}

export function generateBank(move: GenMove): { slotIndex: number } | null {
  const state = useSequencerStore.getState();
  const def = MOVES[move];
  // Tag the generated bank with its recipe so the conductor can apply
  // per-recipe dwell ranges and same-recipe avoidance.
  const newSlot: BankSlot = {
    ...def.fn({
      tracks: state.tracks,
      rootNote: state.rootNote,
      scale: state.scale,
    }),
    recipe: move,
  };
  const slotIndex = findEmptySlot(state.banks, newSlot.kind);
  if (slotIndex === null) return null;
  const banks = state.banks.slice();
  banks[slotIndex] = newSlot;
  useSequencerStore.setState({ banks });
  return { slotIndex };
}

// Auto-seed pass — called once on app mount. Wipes scene banks and fills
// slots 0-9 with one of each recipe in song-arc order (ambient → sparse →
// melodic → driving → dance → halftime → poly → drums → build → hits).
// Transition slots (14-15) are left untouched. Applies the first seeded
// bank's tracks to active state so the user opens to a recipe pattern
// rather than the default-preset stub.
//
// User-saved bank state (from persist.ts localStorage) is intentionally
// clobbered here — the model the user wants is "fresh series of patterns
// on each load," not "session-persistent banks." Voices propagate via
// store.tracks (band identity is preserved across reload via persist.ts
// hydration), so each fresh seed uses the user's current voice setup via
// activeVoice() in compose moves.
export function autoSeedBanks(): void {
  const seedOrder: GenMove[] = [
    'compose-ambient',
    'compose-sparse',
    'compose-melodic',
    'compose-driving',
    'compose-dance',
    'compose-halftime',
    'compose-poly',
    'compose-drums',
    'compose-build',
    'compose-hits',
  ];

  // Wipe scene banks; preserve transition slots (14-15) since those are
  // user-authored inserts and transition-kind compose doesn't exist.
  const wipedBanks: (BankSlot | null)[] = useSequencerStore
    .getState()
    .banks.map((b, i) => (i < TRANSITION_SLOT_START ? null : b));
  useSequencerStore.setState({
    banks: wipedBanks,
    activeBank: null,
    pendingBank: null,
  });

  // Generate in order — findEmptySlot iterates 0..TRANSITION_SLOT_START-1
  // so each call lands at the next free index.
  for (const move of seedOrder) {
    generateBank(move);
  }

  // Apply the first seeded bank's tracks to active state. Without this the
  // user opens with defaultPreset's stub tracks while activeBank claims
  // they're hearing the ambient recipe — they only see the recipe content
  // after the conductor's first scene change.
  const state = useSequencerStore.getState();
  const firstSlot = state.banks[0];
  if (firstSlot) {
    useSequencerStore.setState({
      tracks: firstSlot.tracks.map(cloneTrack),
      density: firstSlot.macros.density,
      chaos: firstSlot.macros.chaos,
      motion: firstSlot.macros.motion,
      drift: firstSlot.macros.drift,
      tension: firstSlot.macros.tension,
      activeBank: 0,
      pendingBank: null,
    });
  }
}
