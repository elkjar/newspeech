export type VoiceCategory = 'drum' | 'melodic';

export interface MutationProfile {
  flipChance: number;
  velSpread: number;
  pitchJumpProb: number;
  pitchWeights: { octave: number; fifth: number; small: number };
  gateBias: number;
  gateSpread: number;
  tieFlipChance: number;
  stepWeights?: number[];
  // Stage 7: probability the chord master applies a chord-aware mutation
  // (dropChordTone / borrowChord / shuffleInversion / shiftSpread) on a
  // given chord step. Only consulted when the track is the melodic-slot-0
  // chord master AND the step's voicing.degree > 0; ignored elsewhere.
  chordMutationChance: number;
}

export const DEFAULT_MUTATION: MutationProfile = {
  flipChance: 0.25,
  velSpread: 0.4,
  pitchJumpProb: 0.7,
  pitchWeights: { octave: 0.3, fifth: 0.3, small: 0.4 },
  gateBias: 0.4,
  gateSpread: 0.8,
  tieFlipChance: 0.2,
  chordMutationChance: 0.35,
};

// Drums never pitch-jump via mutation. The internal-synth fallback ignores
// midiNote, but sample voices use playbackRate to pitch-shift — without a
// drum-specific profile here, mutation would dramatically retune kicks/snares.
export const DRUM_MUTATION: MutationProfile = {
  ...DEFAULT_MUTATION,
  pitchJumpProb: 0,
  pitchWeights: { octave: 0, fifth: 0, small: 0 },
  chordMutationChance: 0,
};

export const KICK_MUTATION: MutationProfile = {
  ...DRUM_MUTATION,
  // light pull toward quarter notes (1, 2, 3, 4 of each bar) without forbidding offbeats
  stepWeights: [1, 0.6, 0.6, 0.6, 1, 0.6, 0.6, 0.6, 1, 0.6, 0.6, 0.6, 1, 0.6, 0.6, 0.6],
};

export const HAT_O_MUTATION: MutationProfile = {
  ...DRUM_MUTATION,
  // bias placement to offbeats (the "and" of each beat in 16ths) — zeros elsewhere
  // automatically prevent sequential adjacency.
  stepWeights: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
};

export const BASS_MUTATION: MutationProfile = {
  flipChance: 0.15,
  velSpread: 0.35,
  pitchJumpProb: 0.5,
  pitchWeights: { octave: 0.1, fifth: 0.4, small: 0.5 },
  gateBias: 0.3,
  gateSpread: 0.6,
  tieFlipChance: 0.15,
  chordMutationChance: 0,
};

// Pads sustain rather than flip rhythmically, never jump pitch (harmony comes
// from the published chord context, not mutation rolls), bias toward longer
// gates (more overlap → voicing-crossfade-via-long-release), and love chord-
// aware mutations (drop / borrow / shuffle / shift). Consulted only when the
// pad-type voice is on the chord-master row; non-master rows just see the
// rhythmic-mutation fields.
export const PAD_MUTATION: MutationProfile = {
  flipChance: 0.1,
  velSpread: 0.25,
  pitchJumpProb: 0,
  pitchWeights: { octave: 0, fifth: 0, small: 0 },
  gateBias: 0.7,
  gateSpread: 0.3,
  tieFlipChance: 0.05,
  chordMutationChance: 0.55,
};

export interface VoiceEnvelope {
  attack: number;            // seconds; min 0.001 enforced at trigger time
  decay?: number;            // seconds; omitted = no decay phase, sustain stays at peak
  sustain?: number;          // 0..1, fraction of peak; default 1
  release: number;           // seconds; min 0.001 enforced at trigger time
}

export interface VoiceLoop {
  start: number;             // seconds into the buffer
  end: number;               // seconds into the buffer
}

// Open union — pad is the first category. Tagging a voice with `type: 'pad'`
// opts it into pad-type dispatch (custom mutations + built-in per-tone pan
// motion). All pad behaviour is keyed off this tag via `isPadVoice(id)`.
export type VoiceType = 'pad';

export interface PadConfig {
  // Auto-shuffle inversion or spread every N chord-master triggers (independent
  // of mutation knob rolls). 0 disables.
  voicingDriftEveryNTriggers: number;
  // Probability a drift event fires when the trigger-count cadence hits; below
  // 1 smooths the timing so it doesn't feel strictly metronomic.
  voicingDriftChance: number;
  voicingDriftAxis: 'inversion' | 'spread' | 'either';

  // Per-trigger chance a non-bass chord tone is dropped at dispatch (audible
  // only — followers still see the full chord via the published context).
  dropoutChance: number;
  // Weighting toward upper tones; 0 uniform, 1 always-top, soft-power between.
  dropoutUpperBias: number;

  // Each tone's gate is multiplied by random in [min, max]. Slight skew toward
  // >1 lets chord tones bloom rather than truncate.
  gateStagger: { min: number; max: number };

  // Independent slow LFO per tone. Rates and phase offsets indexed by tone
  // position mod length — prime-spaced so the field never re-aligns.
  panLfoRatesHz: number[];
  panLfoPhaseOffsetsRad: number[];
  // Max sweep from each tone's base (positional spread) pan position.
  panLfoDepth: number;
}

// Per-track audio-mix defaults applied when this voice is assigned to a
// track. Separate from VoiceDef.gain (which is a per-TRIGGER velocity trim
// stacking on manifest gain) — these write into track.filterCutoff / .fxSend
// / .gain / etc. Applied by the compose populate functions on initial
// assignment AND by setTrackSource when a user manually picks the voice.
// Only specified fields override; unspecified fields keep role / empty
// defaults so each voice contributes only the knobs it has opinions about.
export interface VoiceTrackDefaults {
  filterCutoff?: number;
  filterResonance?: number;
  fxSend?: number;
  gain?: number;
  pan?: number;
}

export interface VoiceDef {
  id: string;
  label: string;
  category: VoiceCategory;
  // Optional category tag; 'pad' opts the voice into pad dispatch in
  // samplePlayer and the chord-master voicing-drift hook in App.tsx.
  type?: VoiceType;
  mutationProfile?: MutationProfile;
  envelope?: VoiceEnvelope;  // opt-in ADSR shaping in samplePlayer; absent = play sample as-is
  loop?: VoiceLoop;          // opt-in looping; absent = source plays to end naturally
  // Per-voice default gain trim, applied at trigger time to velocity. For
  // sample voices this stacks on top of the manifest's `gain` field; for
  // synth voices this is the only intrinsic gain control. Used to dial in
  // perceived loudness parity across voices so chord assembly and master
  // bus aren't pushed into limiting by a hot voice. Absent = 1.0.
  gain?: number;
  // Per-voice natural-register shift, applied to the requested midiNote at
  // trigger time (integer octaves, semitones internally = octaveOffset * 12).
  // Composes additively with per-track `octave`. Used to anchor pad voices
  // in their intended low register without forcing per-track octave authoring.
  octaveOffset?: number;
  // Pad-specific tuning; required-in-spirit when type === 'pad'.
  padConfig?: PadConfig;
  // Per-track mix defaults applied on voice assignment (compose + manual).
  trackDefaults?: VoiceTrackDefaults;
}

// Defaults aimed at "obviously moving, obviously pad" per visible-defaults
// rule. The user tunes per-voice once they listen; centralized so first pad
// voice has a sensible starting point.
export const DEFAULT_PAD_CONFIG: PadConfig = {
  voicingDriftEveryNTriggers: 4,
  voicingDriftChance: 0.8,
  voicingDriftAxis: 'either',
  dropoutChance: 0.45,
  dropoutUpperBias: 0.7,
  gateStagger: { min: 0.85, max: 1.15 },
  panLfoRatesHz: [0.07, 0.11, 0.13, 0.17, 0.19, 0.23],
  panLfoPhaseOffsetsRad: [0, 1.7, 3.1, 4.6, 5.9, 2.3],
  panLfoDepth: 0.45,
};

export const VOICES: VoiceDef[] = [
  { id: 'kick', label: 'kick', category: 'drum', mutationProfile: KICK_MUTATION },
  { id: 'snare', label: 'snare', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'hat-c', label: 'hat-c', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'hat-o', label: 'hat-o', category: 'drum', mutationProfile: HAT_O_MUTATION },
  { id: 'blk', label: 'blk', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'cym', label: 'cym', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'tamb', label: 'tamb', category: 'drum', mutationProfile: DRUM_MUTATION },
  // ns-kit-1 voices — distinct sample bank. Namespaced with `ns1-` so they
  // coexist with blck_noir's voices rather than overwriting them in the
  // sample-player map. All available in the drum source-picker; conductor
  // only auto-picks bare-named voices by default, so these stay as
  // user-driven alternatives (until a kit-aware palette lands).
  { id: 'ns1-kick', label: 'ns1 kick', category: 'drum', mutationProfile: KICK_MUTATION },
  { id: 'ns1-snare', label: 'ns1 snare', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'ns1-hat-c', label: 'ns1 hat-c', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'ns1-hat-o', label: 'ns1 hat-o', category: 'drum', mutationProfile: HAT_O_MUTATION },
  { id: 'ns1-cym', label: 'ns1 cym', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'ns1-ride', label: 'ns1 ride', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'ns1-floortom', label: 'ns1 floortom', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'ns1-racktom', label: 'ns1 racktom', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'ns1-rimshot', label: 'ns1 rimshot', category: 'drum', mutationProfile: DRUM_MUTATION },
  {
    id: 'hydra-plaits',
    label: 'hydra-plaits',
    category: 'melodic',
    trackDefaults: { filterCutoff: 0.74, fxSend: 1.0, gain: 0.52 },
  },
  {
    id: 'bass',
    label: 'bass',
    category: 'melodic',
    mutationProfile: BASS_MUTATION,
    gain: 0.67,
    trackDefaults: { gain: 0.52 },
  },
  {
    id: 'rhodes-mk1',
    label: 'rhodes mk1',
    category: 'melodic',
    envelope: { attack: 0.005, sustain: 1.0, release: 0.35 },
    trackDefaults: { filterCutoff: 0.52, fxSend: 1.0, gain: 0.76 },
  },
  { id: 'root-grain', label: 'root grain', category: 'melodic' },
  { id: 'soft-piano', label: 'soft piano', category: 'melodic' },
  { id: 'tape-piano', label: 'tape piano', category: 'melodic' },
  { id: 'under-piano', label: 'under piano', category: 'melodic' },
  { id: 'broken', label: 'broken', category: 'melodic' },
  { id: 'dark-omen', label: 'dark omen', category: 'melodic' },
  { id: 'dreams', label: 'dreams', category: 'melodic' },
  { id: 'grind', label: 'grind', category: 'melodic' },
  { id: 'haunted', label: 'haunted', category: 'melodic' },
  { id: 'invasion', label: 'invasion', category: 'melodic' },
  { id: 'sample-and-hold', label: 'sample and hold', category: 'melodic' },
  {
    id: 'mini-moog',
    label: 'mini moog',
    category: 'melodic',
    trackDefaults: { gain: 0.44 },
  },
  {
    id: 'sinewaves-scope',
    label: 'sinewaves',
    category: 'melodic',
    type: 'pad',
    mutationProfile: PAD_MUTATION,
    envelope: { attack: 0.4, sustain: 1.0, release: 2.2 },
    octaveOffset: -2,
    padConfig: DEFAULT_PAD_CONFIG,
  },
  {
    id: 'encounter',
    label: 'encounter',
    category: 'melodic',
    type: 'pad',
    mutationProfile: PAD_MUTATION,
    envelope: { attack: 0.4, sustain: 1.0, release: 2.2 },
    octaveOffset: -2,
    padConfig: DEFAULT_PAD_CONFIG,
  },
  {
    id: 'pulsed',
    label: 'pulsed',
    category: 'melodic',
    type: 'pad',
    mutationProfile: PAD_MUTATION,
    envelope: { attack: 0.4, sustain: 1.0, release: 2.2 },
    octaveOffset: -2,
    padConfig: DEFAULT_PAD_CONFIG,
  },
];

export function voiceCategory(voiceId: string): VoiceCategory {
  return VOICES.find((v) => v.id === voiceId)?.category ?? 'melodic';
}

export function isMelodicVoice(voiceId: string): boolean {
  return voiceCategory(voiceId) === 'melodic';
}

export function voiceLabel(voiceId: string): string {
  return VOICES.find((v) => v.id === voiceId)?.label ?? voiceId;
}

export function voiceMutation(voiceId: string): MutationProfile {
  return VOICES.find((v) => v.id === voiceId)?.mutationProfile ?? DEFAULT_MUTATION;
}

export function voiceEnvelope(voiceId: string): VoiceEnvelope | undefined {
  return VOICES.find((v) => v.id === voiceId)?.envelope;
}

export function voiceLoop(voiceId: string): VoiceLoop | undefined {
  return VOICES.find((v) => v.id === voiceId)?.loop;
}

export function voiceGain(voiceId: string): number {
  return VOICES.find((v) => v.id === voiceId)?.gain ?? 1;
}

export function voiceOctaveOffset(voiceId: string): number {
  return VOICES.find((v) => v.id === voiceId)?.octaveOffset ?? 0;
}

export function voiceType(voiceId: string): VoiceType | undefined {
  return VOICES.find((v) => v.id === voiceId)?.type;
}

export function voicePadConfig(voiceId: string): PadConfig | undefined {
  return VOICES.find((v) => v.id === voiceId)?.padConfig;
}

export function voiceTrackDefaults(voiceId: string): VoiceTrackDefaults | undefined {
  return VOICES.find((v) => v.id === voiceId)?.trackDefaults;
}

export function isPadVoice(voiceId: string): boolean {
  return voiceType(voiceId) === 'pad';
}
