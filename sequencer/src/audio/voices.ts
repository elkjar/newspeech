export type VoiceCategory = 'drum' | 'melodic' | 'midi';

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

const PAD_MUTATION: MutationProfile = {
  flipChance: 0.05,
  velSpread: 0.2,
  pitchJumpProb: 0.3,
  pitchWeights: { octave: 0.05, fifth: 0.2, small: 0.75 },
  gateBias: 0,
  gateSpread: 0.2,
  tieFlipChance: 0,
};

const KICK_MUTATION: MutationProfile = {
  ...DEFAULT_MUTATION,
  // light pull toward quarter notes (1, 2, 3, 4 of each bar) without forbidding offbeats
  stepWeights: [1, 0.6, 0.6, 0.6, 1, 0.6, 0.6, 0.6, 1, 0.6, 0.6, 0.6, 1, 0.6, 0.6, 0.6],
};

const HAT_O_MUTATION: MutationProfile = {
  flipChance: 0.25,
  velSpread: 0.4,
  pitchJumpProb: 0,
  pitchWeights: { octave: 0, fifth: 0, small: 1 },
  gateBias: 0.4,
  gateSpread: 0.8,
  tieFlipChance: 0.2,
  // bias placement to offbeats (the "and" of each beat in 16ths) — zeros elsewhere
  // automatically prevent sequential adjacency.
  stepWeights: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
};

const BASS_MUTATION: MutationProfile = {
  flipChance: 0.15,
  velSpread: 0.35,
  pitchJumpProb: 0.5,
  pitchWeights: { octave: 0.1, fifth: 0.4, small: 0.5 },
  gateBias: 0.3,
  gateSpread: 0.6,
  tieFlipChance: 0.15,
};

export type MIDIKit = 'gm' | 'blk_noir';

export interface VoiceDef {
  id: string;
  label: string;
  category: VoiceCategory;
  kit?: MIDIKit;
  chord?: number[];
  mutationProfile?: MutationProfile;
  gmDrumNote?: number;
}

export const VOICES: VoiceDef[] = [
  { id: 'kick', label: 'kick', category: 'drum', mutationProfile: KICK_MUTATION, gmDrumNote: 36 },
  { id: 'snare', label: 'snare', category: 'drum', gmDrumNote: 40 },
  { id: 'hat-c', label: 'hat-c', category: 'drum', gmDrumNote: 42 },
  { id: 'hat-o', label: 'hat-o', category: 'drum', mutationProfile: HAT_O_MUTATION, gmDrumNote: 46 },
  { id: 'synth', label: 'synth', category: 'melodic', gmDrumNote: 50 },
  { id: 'bass', label: 'bass', category: 'melodic', mutationProfile: BASS_MUTATION, gmDrumNote: 41 },
  { id: 'pad', label: 'pad', category: 'melodic', chord: [0, 2, 4], mutationProfile: PAD_MUTATION, gmDrumNote: 51 },
  { id: 'midi-kick', label: 'midi kick', category: 'midi', kit: 'gm', mutationProfile: KICK_MUTATION, gmDrumNote: 36 },
  { id: 'midi-snare', label: 'midi snare', category: 'midi', kit: 'gm', gmDrumNote: 40 },
  { id: 'midi-rim', label: 'midi rim', category: 'midi', kit: 'gm', gmDrumNote: 37 },
  { id: 'midi-clap', label: 'midi clap', category: 'midi', kit: 'gm', gmDrumNote: 39 },
  { id: 'midi-hh-c', label: 'midi hh-c', category: 'midi', kit: 'gm', gmDrumNote: 42 },
  { id: 'midi-hh-o', label: 'midi hh-o', category: 'midi', kit: 'gm', mutationProfile: HAT_O_MUTATION, gmDrumNote: 46 },
  { id: 'midi-tom-l', label: 'midi tom-l', category: 'midi', kit: 'gm', gmDrumNote: 41 },
  { id: 'midi-tom-m', label: 'midi tom-m', category: 'midi', kit: 'gm', gmDrumNote: 47 },
  { id: 'midi-tom-h', label: 'midi tom-h', category: 'midi', kit: 'gm', gmDrumNote: 50 },
  { id: 'midi-crash', label: 'midi crash', category: 'midi', kit: 'gm', gmDrumNote: 49 },
  { id: 'midi-ride', label: 'midi ride', category: 'midi', kit: 'gm', gmDrumNote: 51 },
  { id: 'noir-kick', label: 'noir kick', category: 'midi', kit: 'blk_noir', mutationProfile: KICK_MUTATION, gmDrumNote: 36 },
  { id: 'noir-snr', label: 'noir snr', category: 'midi', kit: 'blk_noir', gmDrumNote: 37 },
  { id: 'noir-tam', label: 'noir tam', category: 'midi', kit: 'blk_noir', gmDrumNote: 38 },
  { id: 'noir-ohh', label: 'noir ohh', category: 'midi', kit: 'blk_noir', mutationProfile: HAT_O_MUTATION, gmDrumNote: 39 },
  { id: 'noir-chh', label: 'noir chh', category: 'midi', kit: 'blk_noir', gmDrumNote: 40 },
  { id: 'noir-met', label: 'noir met', category: 'midi', kit: 'blk_noir', gmDrumNote: 41 },
  { id: 'noir-cym', label: 'noir cym', category: 'midi', kit: 'blk_noir', gmDrumNote: 42 },
];

const VOICE_TO_MIDI_DRUM: Record<string, string> = {
  kick: 'midi-kick',
  snare: 'midi-snare',
  'hat-c': 'midi-hh-c',
  'hat-o': 'midi-hh-o',
  synth: 'midi-tom-l',
  bass: 'midi-tom-m',
  pad: 'midi-crash',
  // also map gm midi voices and blk_noir voices through to the gm equivalents
  'midi-kick': 'midi-kick',
  'midi-snare': 'midi-snare',
  'midi-hh-c': 'midi-hh-c',
  'midi-hh-o': 'midi-hh-o',
  'midi-tom-l': 'midi-tom-l',
  'midi-tom-m': 'midi-tom-m',
  'midi-tom-h': 'midi-tom-h',
  'midi-crash': 'midi-crash',
  'midi-ride': 'midi-ride',
  'midi-rim': 'midi-rim',
  'midi-clap': 'midi-clap',
  'noir-kick': 'midi-kick',
  'noir-snr': 'midi-snare',
  'noir-tam': 'midi-tom-l',
  'noir-ohh': 'midi-hh-o',
  'noir-chh': 'midi-hh-c',
  'noir-met': 'midi-tom-m',
  'noir-cym': 'midi-crash',
};

const VOICE_TO_BLK_NOIR: Record<string, string> = {
  kick: 'noir-kick',
  snare: 'noir-snr',
  'hat-c': 'noir-chh',
  'hat-o': 'noir-ohh',
  synth: 'noir-tam',
  bass: 'noir-met',
  pad: 'noir-cym',
  'midi-kick': 'noir-kick',
  'midi-snare': 'noir-snr',
  'midi-hh-c': 'noir-chh',
  'midi-hh-o': 'noir-ohh',
  'midi-tom-l': 'noir-tam',
  'midi-tom-m': 'noir-met',
  'midi-tom-h': 'noir-tam',
  'midi-crash': 'noir-cym',
  'midi-ride': 'noir-cym',
  'midi-rim': 'noir-snr',
  'midi-clap': 'noir-snr',
  'noir-kick': 'noir-kick',
  'noir-snr': 'noir-snr',
  'noir-tam': 'noir-tam',
  'noir-ohh': 'noir-ohh',
  'noir-chh': 'noir-chh',
  'noir-met': 'noir-met',
  'noir-cym': 'noir-cym',
};

export function gmDrumVoiceFor(voiceId: string, slotIndex: number): string {
  if (VOICE_TO_MIDI_DRUM[voiceId]) return VOICE_TO_MIDI_DRUM[voiceId];
  const fallback = ['midi-kick', 'midi-snare', 'midi-hh-c', 'midi-hh-o', 'midi-tom-l', 'midi-tom-m', 'midi-tom-h', 'midi-crash'];
  return fallback[slotIndex % fallback.length];
}

export function blkNoirVoiceFor(voiceId: string, slotIndex: number): string {
  if (VOICE_TO_BLK_NOIR[voiceId]) return VOICE_TO_BLK_NOIR[voiceId];
  const fallback = ['noir-kick', 'noir-snr', 'noir-chh', 'noir-ohh', 'noir-tam', 'noir-met', 'noir-cym'];
  return fallback[slotIndex % fallback.length];
}

const VOICE_TO_INTERNAL: Record<string, string> = {
  'midi-kick': 'kick',
  'midi-snare': 'snare',
  'midi-rim': 'snare',
  'midi-clap': 'snare',
  'midi-hh-c': 'hat-c',
  'midi-hh-o': 'hat-o',
  'midi-tom-l': 'synth',
  'midi-tom-m': 'bass',
  'midi-tom-h': 'synth',
  'midi-crash': 'pad',
  'midi-ride': 'pad',
  'noir-kick': 'kick',
  'noir-snr': 'snare',
  'noir-tam': 'synth',
  'noir-ohh': 'hat-o',
  'noir-chh': 'hat-c',
  'noir-met': 'bass',
  'noir-cym': 'pad',
};

export function internalVoiceFor(voiceId: string, slotIndex: number): string {
  if (voiceCategory(voiceId) !== 'midi') return voiceId;
  if (VOICE_TO_INTERNAL[voiceId]) return VOICE_TO_INTERNAL[voiceId];
  const fallback = ['kick', 'snare', 'hat-c', 'hat-o', 'synth', 'bass', 'pad', 'synth'];
  return fallback[slotIndex % fallback.length];
}

export interface KitPreset {
  id: string;
  label: string;
  toMidi: boolean;
  voiceFor: (currentVoice: string, slotIndex: number) => string;
}

export const KIT_PRESETS: KitPreset[] = [
  { id: 'internal', label: 'internal synths', toMidi: false, voiceFor: internalVoiceFor },
  { id: 'gm', label: 'gm drums', toMidi: true, voiceFor: gmDrumVoiceFor },
  { id: 'blk_noir', label: 'blk_noir', toMidi: true, voiceFor: blkNoirVoiceFor },
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

export function voiceGMDrumNote(voiceId: string): number {
  return VOICES.find((v) => v.id === voiceId)?.gmDrumNote ?? 36;
}
