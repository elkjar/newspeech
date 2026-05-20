import {
  type Step,
  type StepRate,
  type Track,
  DEFAULT_TRACK_MIDI,
} from '../../state/store';
import { euclidean } from '../../audio/euclidean';
import {
  CHORD_MASTER_DEFAULT,
  DEFAULT_CHORD_VOICING,
  type ChordDegree,
  type ChordVoicing,
} from '../../audio/chords';
import { voiceTrackDefaults } from '../../audio/voices';

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

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

export function emptyStep(): Step {
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

export function emptyStepsArr(): Step[] {
  return Array.from({ length: 64 }, emptyStep);
}

export function applyEuclideanPattern(
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
export function applyProgrammedSteps(
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
export function applyHitsCharacter(t: Track, fxSend = 0.95, gate = 0.45): Track {
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
export function applyVoiceDefaults(t: Track, voiceId: string): Track {
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
export function silenceTrack(t: Track): Track {
  return { ...t, mutation: 0, rowRatchet: 0 };
}

// Strip a track to a known-default per-track state, preserving only identity
// (id, section). Used both for tracks that compose decides to leave empty
// and as the base for tracks compose is about to populate. Distinct from
// hydrate.ts `blankTrack` which also resets `section` — we keep section
// because it's structural to the track's slot identity.
export function emptyTrackForCompose(t: Track): Track {
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

export function populateChordMaster(t: Track, voiceId: string): Track {
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

export function populateBass(t: Track, voiceId: string): Track {
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

export function populateMotif(t: Track, voiceId: string): Track {
  return applyVoiceDefaults({
    ...emptyTrackForCompose(t),
    source: { kind: 'voice', id: voiceId },
    pitchInterp: 'chord-tone',
    octave: 0,
    mutation: ROLE_DEFAULTS.motif.mutation,
    fxSend: ROLE_DEFAULTS.motif.fxSend,
  }, voiceId);
}

export function populateDrum(t: Track, voiceId: string): Track {
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
export function populateFlavor(t: Track, voiceId: string): Track {
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

export function chordStep(degree: ChordDegree, velocity = 1): Step {
  const voicing: ChordVoicing = { ...CHORD_MASTER_DEFAULT, degree };
  return { ...emptyStep(), on: true, velocity, chordVoicing: voicing };
}

export function noteStep(pitch: number, velocity = 0.9): Step {
  return { ...emptyStep(), on: true, velocity, pitch };
}
