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
}

export const DEFAULT_MUTATION: MutationProfile = {
  flipChance: 0.25,
  velSpread: 0.4,
  pitchJumpProb: 0.7,
  pitchWeights: { octave: 0.3, fifth: 0.3, small: 0.4 },
  gateBias: 0.4,
  gateSpread: 0.8,
  tieFlipChance: 0.2,
};

// Drums never pitch-jump via mutation. The internal-synth fallback ignores
// midiNote, but sample voices use playbackRate to pitch-shift — without a
// drum-specific profile here, mutation would dramatically retune kicks/snares.
export const DRUM_MUTATION: MutationProfile = {
  ...DEFAULT_MUTATION,
  pitchJumpProb: 0,
  pitchWeights: { octave: 0, fifth: 0, small: 0 },
};

export const PAD_MUTATION: MutationProfile = {
  flipChance: 0.05,
  velSpread: 0.2,
  pitchJumpProb: 0.3,
  pitchWeights: { octave: 0.05, fifth: 0.2, small: 0.75 },
  gateBias: 0,
  gateSpread: 0.2,
  tieFlipChance: 0,
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
};

export interface VoiceDef {
  id: string;
  label: string;
  category: VoiceCategory;
  chord?: number[];
  mutationProfile?: MutationProfile;
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
  { id: 'bass', label: 'bass', category: 'melodic', mutationProfile: BASS_MUTATION },
  { id: 'pad', label: 'pad', category: 'melodic', chord: [0, 2, 4], mutationProfile: PAD_MUTATION },
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

export function voiceChord(voiceId: string): number[] {
  return VOICES.find((v) => v.id === voiceId)?.chord ?? [0];
}

export function voiceMutation(voiceId: string): MutationProfile {
  return VOICES.find((v) => v.id === voiceId)?.mutationProfile ?? DEFAULT_MUTATION;
}
