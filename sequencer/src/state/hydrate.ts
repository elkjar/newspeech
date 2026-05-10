import type { Track, Step, TrackSection, StepRate, TrackMidi } from './store';
import { STEP_RATES, DEFAULT_TRACK_MIDI, snapshotInstrumentMidi } from './store';
import {
  defaultLFOs,
  LFO_RATES,
  type LFO,
  type LFODestKnob,
  type LFODestination,
} from '../audio/lfo';
import { getInstrument, type TrackSource } from '../instruments/library';

const VALID_KNOBS: LFODestKnob[] = [
  'mutation',
  'morph',
  'rowRatchet',
  'fxSend',
  'density',
  'motion',
  'drift',
  'chaos',
  'tension',
];

function validDest(d: unknown): LFODestination | null {
  if (!d || typeof d !== 'object') return null;
  const obj = d as { trackId?: unknown; knob?: unknown };
  if (typeof obj.trackId !== 'string') return null;
  if (typeof obj.knob !== 'string' || !VALID_KNOBS.includes(obj.knob as LFODestKnob)) {
    return null;
  }
  return { trackId: obj.trackId, knob: obj.knob as LFODestKnob };
}

export function hydrateStep(saved: Partial<Step>): Step {
  return {
    on: saved.on ?? false,
    velocity: saved.velocity ?? 1,
    pitch: saved.pitch ?? 0,
    probability: saved.probability ?? 100,
    ratchet: saved.ratchet ?? 1,
    microTiming: saved.microTiming ?? 0,
    gate: saved.gate ?? 1,
    tieToNext: saved.tieToNext ?? false,
  };
}

export function hydrateSlot(slot: Step[] | null | undefined): Step[] | null {
  if (!Array.isArray(slot)) return null;
  return Array.from({ length: 64 }, (_, i) => hydrateStep(slot[i] ?? {}));
}

export function hydrateLFOs(saved: LFO[] | undefined): LFO[] {
  const defaults = defaultLFOs();
  if (!Array.isArray(saved)) return defaults;
  return defaults.map((d, i) => {
    const s = saved[i] as Partial<LFO> & { destination?: unknown } | undefined;
    if (!s) return d;
    let destinations: LFODestination[] = [];
    if (Array.isArray(s.destinations)) {
      destinations = s.destinations
        .map(validDest)
        .filter((x): x is LFODestination => x !== null);
    } else if (s.destination) {
      const v = validDest(s.destination);
      if (v) destinations = [v];
    }
    return {
      id: i,
      rate: LFO_RATES[i] ?? d.rate,
      depth: typeof s.depth === 'number' ? Math.max(0, Math.min(1, s.depth)) : 0,
      destinations,
    };
  });
}

const INTERNAL_VOICE_IDS = new Set([
  'kick',
  'snare',
  'hat-c',
  'hat-o',
  'blk',
  'cym',
  'tamb',
  'hydra-plaits',
  'bass',
  'pad',
  'rhodes-mk1',
  'root-grain',
  'soft-piano',
  'tape-piano',
  'under-piano',
]);
// migrate renamed voice ids when hydrating older `.seq` files
const VOICE_ID_RENAMES: Record<string, string> = {
  synth: 'hydra-plaits',
};
const LEGACY_MIDI_TO_INTERNAL: Record<string, string> = {
  'midi-kick': 'kick',
  'midi-snare': 'snare',
  'midi-rim': 'snare',
  'midi-clap': 'snare',
  'midi-hh-c': 'hat-c',
  'midi-hh-o': 'hat-o',
  'midi-tom-l': 'hydra-plaits',
  'midi-tom-m': 'bass',
  'midi-tom-h': 'hydra-plaits',
  'midi-crash': 'pad',
  'midi-ride': 'pad',
};

function hydrateSource(saved: unknown, legacyVoice: string | undefined): TrackSource {
  if (saved && typeof saved === 'object') {
    const obj = saved as { kind?: unknown; id?: unknown };
    if (obj.kind === 'empty') return { kind: 'empty' };
    if ((obj.kind === 'voice' || obj.kind === 'instrument') && typeof obj.id === 'string') {
      const renamed = VOICE_ID_RENAMES[obj.id] ?? obj.id;
      if (obj.kind === 'voice' && INTERNAL_VOICE_IDS.has(renamed)) {
        return { kind: 'voice', id: renamed };
      }
      if (obj.kind === 'instrument' && getInstrument(obj.id)) {
        return { kind: 'instrument', id: obj.id };
      }
    }
  }
  // legacy fallback: migrate from old `voice` field
  if (typeof legacyVoice === 'string') {
    const renamed = VOICE_ID_RENAMES[legacyVoice] ?? legacyVoice;
    if (INTERNAL_VOICE_IDS.has(renamed)) return { kind: 'voice', id: renamed };
    if (getInstrument(renamed)) return { kind: 'instrument', id: renamed };
    if (LEGACY_MIDI_TO_INTERNAL[renamed]) {
      return { kind: 'voice', id: LEGACY_MIDI_TO_INTERNAL[renamed] };
    }
  }
  return { kind: 'voice', id: 'kick' };
}

function hydrateRate(saved: unknown): StepRate {
  return typeof saved === 'string' && (STEP_RATES as readonly string[]).includes(saved)
    ? (saved as StepRate)
    : '1/16';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function nullableInt(v: unknown, lo: number, hi: number): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return clamp(Math.floor(v), lo, hi);
}

function hydrateMidi(saved: unknown, source: TrackSource): TrackMidi {
  // seed from instrument factory defaults if source is an instrument
  const seed: TrackMidi =
    source.kind === 'instrument' ? snapshotInstrumentMidi(source.id) : { ...DEFAULT_TRACK_MIDI };
  if (!saved || typeof saved !== 'object') return seed;
  const m = saved as Partial<TrackMidi>;
  return {
    channel:
      typeof m.channel === 'number' && Number.isFinite(m.channel)
        ? clamp(Math.floor(m.channel), 0, 15)
        : seed.channel,
    portName:
      typeof m.portName === 'string' ? m.portName : m.portName === null ? null : seed.portName,
    program: m.program === undefined ? seed.program : nullableInt(m.program, 0, 127),
    bankMSB: m.bankMSB === undefined ? seed.bankMSB : nullableInt(m.bankMSB, 0, 127),
    bankLSB: m.bankLSB === undefined ? seed.bankLSB : nullableInt(m.bankLSB, 0, 127),
    note: m.note === undefined ? seed.note : nullableInt(m.note, 0, 127),
  };
}

export function hydrateTrack(saved: Partial<Track> & { id: string }): Track {
  const length = saved.length ?? 16;
  const stepsRaw = Array.isArray(saved.steps) ? saved.steps : [];
  const steps = Array.from({ length: 64 }, (_, i) => hydrateStep(stepsRaw[i] ?? {}));
  const section: TrackSection = saved.section === 'melodic' ? 'melodic' : 'drum';
  const legacyVoice = (saved as { voice?: unknown }).voice;
  const source = hydrateSource(
    (saved as { source?: unknown }).source,
    typeof legacyVoice === 'string' ? legacyVoice : undefined
  );
  return {
    id: saved.id,
    source,
    section,
    mute: saved.mute ?? false,
    solo: saved.solo ?? false,
    length,
    lastPitch: saved.lastPitch ?? 0,
    viewPage: saved.viewPage ?? 0,
    mutation: saved.mutation ?? 0,
    rowRatchet: saved.rowRatchet ?? 0,
    morph: saved.morph ?? 0,
    rate: hydrateRate((saved as { rate?: unknown }).rate),
    lockTiming: typeof saved.lockTiming === 'boolean' ? saved.lockTiming : false,
    slotA: hydrateSlot(saved.slotA),
    slotB: hydrateSlot(saved.slotB),
    euclidean: saved.euclidean ?? { hits: 0, rotation: 0 },
    steps,
    midi: hydrateMidi((saved as { midi?: unknown }).midi, source),
    gain:
      typeof saved.gain === 'number' && Number.isFinite(saved.gain)
        ? Math.max(0, Math.min(2, saved.gain))
        : 1,
    fxSend:
      typeof saved.fxSend === 'number' && Number.isFinite(saved.fxSend)
        ? Math.max(0, Math.min(1, saved.fxSend))
        : 0,
  };
}

const EMPTY_MELODIC_VOICES = [
  'bass',
  'bass',
  'hydra-plaits',
  'hydra-plaits',
  'pad',
  'pad',
  'hydra-plaits',
  'hydra-plaits',
];

export function emptyMelodicTrack(id: string, slot: number): Track {
  const steps = Array.from({ length: 64 }, () => hydrateStep({}));
  return {
    id,
    source: { kind: 'voice', id: EMPTY_MELODIC_VOICES[slot % EMPTY_MELODIC_VOICES.length] },
    section: 'melodic',
    mute: false,
    solo: false,
    length: 16,
    lastPitch: 0,
    viewPage: 0,
    mutation: 0,
    rowRatchet: 0,
    morph: 0,
    rate: '1/16',
    lockTiming: false,
    slotA: null,
    slotB: null,
    euclidean: { hits: 0, rotation: 0 },
    steps,
    midi: { ...DEFAULT_TRACK_MIDI },
    gain: 1,
    fxSend: 0,
  };
}

export function ensureBothSections(tracks: Track[]): Track[] {
  const hasMelodic = tracks.some((t) => t.section === 'melodic');
  if (hasMelodic) return tracks;
  const usedIds = new Set(tracks.map((t) => t.id));
  let counter = tracks.length + 1;
  const filler: Track[] = [];
  while (filler.length < 8) {
    let id = `t${counter}`;
    while (usedIds.has(id)) {
      counter++;
      id = `t${counter}`;
    }
    usedIds.add(id);
    filler.push(emptyMelodicTrack(id, filler.length));
    counter++;
  }
  return [...tracks, ...filler];
}
