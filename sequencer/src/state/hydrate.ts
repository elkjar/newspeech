import type { Track, Step, TrackSection } from './store';
import {
  defaultLFOs,
  LFO_RATES,
  type LFO,
  type LFODestKnob,
  type LFODestination,
} from '../audio/lfo';
import { getInstrument, type TrackSource } from '../instruments/library';

const VALID_KNOBS: LFODestKnob[] = ['mutation', 'morph', 'rowChance', 'rowRatchet'];

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

const INTERNAL_VOICE_IDS = new Set(['kick', 'snare', 'hat-c', 'hat-o', 'synth', 'bass', 'pad']);
const LEGACY_MIDI_TO_INTERNAL: Record<string, string> = {
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
};

function hydrateSource(saved: unknown, legacyVoice: string | undefined): TrackSource {
  if (saved && typeof saved === 'object') {
    const obj = saved as { kind?: unknown; id?: unknown };
    if (obj.kind === 'empty') return { kind: 'empty' };
    if ((obj.kind === 'voice' || obj.kind === 'instrument') && typeof obj.id === 'string') {
      if (obj.kind === 'voice' && INTERNAL_VOICE_IDS.has(obj.id)) {
        return { kind: 'voice', id: obj.id };
      }
      if (obj.kind === 'instrument' && getInstrument(obj.id)) {
        return { kind: 'instrument', id: obj.id };
      }
    }
  }
  // legacy fallback: migrate from old `voice` field
  if (typeof legacyVoice === 'string') {
    if (INTERNAL_VOICE_IDS.has(legacyVoice)) return { kind: 'voice', id: legacyVoice };
    if (getInstrument(legacyVoice)) return { kind: 'instrument', id: legacyVoice };
    if (LEGACY_MIDI_TO_INTERNAL[legacyVoice]) {
      return { kind: 'voice', id: LEGACY_MIDI_TO_INTERNAL[legacyVoice] };
    }
  }
  return { kind: 'voice', id: 'kick' };
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
    rowChance: saved.rowChance ?? 0,
    rowRatchet: saved.rowRatchet ?? 0,
    morph: saved.morph ?? 0,
    slotA: hydrateSlot(saved.slotA),
    slotB: hydrateSlot(saved.slotB),
    euclidean: saved.euclidean ?? { hits: 0, rotation: 0 },
    steps,
  };
}

const EMPTY_MELODIC_VOICES = ['bass', 'bass', 'synth', 'synth', 'pad', 'pad', 'synth', 'synth'];

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
    rowChance: 0,
    rowRatchet: 0,
    morph: 0,
    slotA: null,
    slotB: null,
    euclidean: { hits: 0, rotation: 0 },
    steps,
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
