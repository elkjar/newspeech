export type VoiceCategory = 'drum' | 'melodic';

export interface VoiceDef {
  id: string;
  label: string;
  category: VoiceCategory;
}

export const VOICES: VoiceDef[] = [
  { id: 'kick', label: 'kick', category: 'drum' },
  { id: 'snare', label: 'snare', category: 'drum' },
  { id: 'hat-c', label: 'hat-c', category: 'drum' },
  { id: 'hat-o', label: 'hat-o', category: 'drum' },
  { id: 'synth', label: 'synth', category: 'melodic' },
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
