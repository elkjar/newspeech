import {
  DEFAULT_MUTATION,
  KICK_MUTATION,
  HAT_O_MUTATION,
  BASS_MUTATION,
  PAD_MUTATION,
  voiceLabel,
  voiceMutation,
  isMelodicVoice,
  type MutationProfile,
} from '../audio/voices';
import {
  getUserInstrument,
  getUserInstrumentsForRole,
} from './userInstrumentsStore';

export type InstrumentRole = 'drum' | 'bass' | 'lead' | 'pad';

export interface Instrument {
  id: string;
  label: string;
  role: InstrumentRole;
  channel: number;
  portName: string | null;
  program: number | null;
  bankMSB: number | null;
  bankLSB: number | null;
  fixedNote: number | null;
  mutationProfile?: MutationProfile;
}

export type PresetSlot =
  | { kind: 'instrument'; id: string }
  | { kind: 'voice'; id: string }
  | { kind: 'empty' };

export type PresetTarget = 'drum' | 'melodic';

export interface Preset {
  id: string;
  label: string;
  target: PresetTarget;
  slots: PresetSlot[];
}

export const INSTRUMENTS: Instrument[] = [
  {
    id: 'noir-kick',
    label: 'noir kick',
    role: 'drum',
    channel: 9,
    portName: null,
    program: null,
    bankMSB: null,
    bankLSB: null,
    fixedNote: 36,
    mutationProfile: KICK_MUTATION,
  },
  {
    id: 'noir-snr',
    label: 'noir snr',
    role: 'drum',
    channel: 9,
    portName: null,
    program: null,
    bankMSB: null,
    bankLSB: null,
    fixedNote: 37,
  },
  {
    id: 'noir-tam',
    label: 'noir tam',
    role: 'drum',
    channel: 9,
    portName: null,
    program: null,
    bankMSB: null,
    bankLSB: null,
    fixedNote: 38,
  },
  {
    id: 'noir-ohh',
    label: 'noir ohh',
    role: 'drum',
    channel: 9,
    portName: null,
    program: null,
    bankMSB: null,
    bankLSB: null,
    fixedNote: 39,
    mutationProfile: HAT_O_MUTATION,
  },
  {
    id: 'noir-chh',
    label: 'noir chh',
    role: 'drum',
    channel: 9,
    portName: null,
    program: null,
    bankMSB: null,
    bankLSB: null,
    fixedNote: 40,
  },
  {
    id: 'noir-met',
    label: 'noir met',
    role: 'drum',
    channel: 9,
    portName: null,
    program: null,
    bankMSB: null,
    bankLSB: null,
    fixedNote: 41,
  },
  {
    id: 'noir-cym',
    label: 'noir cym',
    role: 'drum',
    channel: 9,
    portName: null,
    program: null,
    bankMSB: null,
    bankLSB: null,
    fixedNote: 42,
  },
];

export const PRESETS: Preset[] = [
  {
    id: 'internal-drum',
    label: 'internal synths',
    target: 'drum',
    slots: [
      { kind: 'voice', id: 'kick' },
      { kind: 'voice', id: 'snare' },
      { kind: 'voice', id: 'hat-c' },
      { kind: 'voice', id: 'hat-o' },
      { kind: 'voice', id: 'hydra-plaits' },
      { kind: 'voice', id: 'bass' },
      { kind: 'voice', id: 'rhodes-mk1' },
      { kind: 'voice', id: 'hydra-plaits' },
    ],
  },
  {
    id: 'internal-melodic',
    label: 'internal synths',
    target: 'melodic',
    slots: [
      { kind: 'voice', id: 'rhodes-mk1' },
      { kind: 'voice', id: 'bass' },
      { kind: 'voice', id: 'hydra-plaits' },
      { kind: 'voice', id: 'hydra-plaits' },
      { kind: 'voice', id: 'soft-piano' },
      { kind: 'voice', id: 'tape-piano' },
      { kind: 'voice', id: 'under-piano' },
      { kind: 'voice', id: 'hydra-plaits' },
    ],
  },
  {
    id: 'blk-noir',
    label: 'blk_noir',
    target: 'drum',
    slots: [
      { kind: 'instrument', id: 'noir-kick' },
      { kind: 'instrument', id: 'noir-snr' },
      { kind: 'instrument', id: 'noir-tam' },
      { kind: 'instrument', id: 'noir-ohh' },
      { kind: 'instrument', id: 'noir-chh' },
      { kind: 'instrument', id: 'noir-met' },
      { kind: 'instrument', id: 'noir-cym' },
      { kind: 'empty' },
    ],
  },
  {
    id: 'ns-kit-1',
    label: 'ns kit 1',
    target: 'drum',
    slots: [
      { kind: 'voice', id: 'ns1-kick' },
      { kind: 'voice', id: 'ns1-snare' },
      { kind: 'voice', id: 'ns1-hat-c' },
      { kind: 'voice', id: 'ns1-hat-o' },
      { kind: 'voice', id: 'ns1-cym' },
      { kind: 'voice', id: 'ns1-ride' },
      { kind: 'voice', id: 'ns1-floortom' },
      { kind: 'voice', id: 'ns1-racktom' },
    ],
  },
];

export function getInstrument(id: string): Instrument | undefined {
  const bundled = INSTRUMENTS.find((i) => i.id === id);
  if (bundled) return bundled;
  // Lazy import to avoid a cycle — userInstrumentsStore lives in the same
  // module folder and we only need a non-React getter.
  return getUserInstrument(id);
}

export function instrumentMutation(id: string): MutationProfile {
  const inst = getInstrument(id);
  if (inst?.mutationProfile) return inst.mutationProfile;
  if (!inst) return DEFAULT_MUTATION;
  switch (inst.role) {
    case 'bass':
      return BASS_MUTATION;
    case 'pad':
      return PAD_MUTATION;
    case 'lead':
    case 'drum':
    default:
      return DEFAULT_MUTATION;
  }
}

export function instrumentIsMelodic(id: string): boolean {
  const inst = getInstrument(id);
  if (!inst) return false;
  return inst.role !== 'drum';
}

export function instrumentsForRole(role: InstrumentRole): Instrument[] {
  return [
    ...INSTRUMENTS.filter((i) => i.role === role),
    ...getUserInstrumentsForRole(role),
  ];
}

export function presetsForTarget(target: PresetTarget): Preset[] {
  return PRESETS.filter((p) => p.target === target);
}

export type TrackSource =
  | { kind: 'voice'; id: string }
  | { kind: 'instrument'; id: string }
  | { kind: 'empty' };

export function sourceLabel(source: TrackSource): string {
  if (source.kind === 'voice') return voiceLabel(source.id);
  if (source.kind === 'instrument') return getInstrument(source.id)?.label ?? source.id;
  return '—';
}

export function sourceMutation(source: TrackSource): MutationProfile {
  if (source.kind === 'voice') return voiceMutation(source.id);
  if (source.kind === 'instrument') return instrumentMutation(source.id);
  return DEFAULT_MUTATION;
}

export function sourceIsMelodic(source: TrackSource): boolean {
  if (source.kind === 'voice') return isMelodicVoice(source.id);
  if (source.kind === 'instrument') return instrumentIsMelodic(source.id);
  return false;
}
