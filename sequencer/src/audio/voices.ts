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

export interface VoiceDef {
  id: string;
  label: string;
  category: VoiceCategory;
  mutationProfile?: MutationProfile;
  envelope?: VoiceEnvelope;  // opt-in ADSR shaping in samplePlayer; absent = play sample as-is
  loop?: VoiceLoop;          // opt-in looping; absent = source plays to end naturally
  // Per-voice default gain trim, applied at trigger time to velocity. For
  // sample voices this stacks on top of the manifest's `gain` field; for
  // synth voices this is the only intrinsic gain control. Used to dial in
  // perceived loudness parity across voices so chord assembly and master
  // bus aren't pushed into limiting by a hot voice. Absent = 1.0.
  gain?: number;
}

export const VOICES: VoiceDef[] = [
  { id: 'kick', label: 'kick', category: 'drum', mutationProfile: KICK_MUTATION },
  { id: 'snare', label: 'snare', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'hat-c', label: 'hat-c', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'hat-o', label: 'hat-o', category: 'drum', mutationProfile: HAT_O_MUTATION },
  { id: 'blk', label: 'blk', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'cym', label: 'cym', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'tamb', label: 'tamb', category: 'drum', mutationProfile: DRUM_MUTATION },
  { id: 'hydra-plaits', label: 'hydra-plaits', category: 'melodic' },
  { id: 'bass', label: 'bass', category: 'melodic', mutationProfile: BASS_MUTATION, gain: 0.67 },
  {
    id: 'rhodes-mk1',
    label: 'rhodes mk1',
    category: 'melodic',
    envelope: { attack: 0.005, sustain: 1.0, release: 0.35 },
  },
  { id: 'root-grain', label: 'root grain', category: 'melodic' },
  { id: 'soft-piano', label: 'soft piano', category: 'melodic' },
  { id: 'tape-piano', label: 'tape piano', category: 'melodic' },
  { id: 'under-piano', label: 'under piano', category: 'melodic' },
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
