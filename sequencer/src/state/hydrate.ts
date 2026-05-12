import type {
  Track,
  Step,
  TrackSection,
  StepRate,
  TrackMidi,
  BankSlot,
  BankMacros,
  PitchInterp,
} from './store';
import {
  STEP_RATES,
  DEFAULT_TRACK_MIDI,
  BANK_SLOT_COUNT,
  PITCH_INTERPS,
  snapshotInstrumentMidi,
} from './store';
import {
  defaultLFOs,
  LFO_RATES,
  type LFO,
  type LFODestKnob,
  type LFODestination,
} from '../audio/lfo';
import { getInstrument, type TrackSource } from '../instruments/library';
import {
  DEFAULT_CHORD_VOICING,
  CHORD_MASTER_DEFAULT,
  parseChordVoicing,
} from '../audio/chords';

const VALID_KNOBS: LFODestKnob[] = [
  'mutation',
  'rowRatchet',
  'fxSend',
  'pan',
  'gain',
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
  const chord = parseChordVoicing((saved as { chordVoicing?: unknown }).chordVoicing);
  return {
    on: saved.on ?? false,
    velocity: saved.velocity ?? 1,
    pitch: saved.pitch ?? 0,
    probability: saved.probability ?? 100,
    ratchet: saved.ratchet ?? 1,
    microTiming: saved.microTiming ?? 0,
    gate: saved.gate ?? 1,
    tieToNext: saved.tieToNext ?? false,
    ...(chord ? { chordVoicing: chord } : {}),
  };
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
  'rhodes-mk1',
  'root-grain',
  'soft-piano',
  'tape-piano',
  'under-piano',
]);
// migrate renamed voice ids when hydrating older `.seq` files. `pad` was
// retired 2026-05-11 when the chord-master role became positional (row 1)
// rather than voice-locked — any saved track that used `pad` now plays via
// rhodes-mk1, which has proper multi-sampled pitch zones.
const VOICE_ID_RENAMES: Record<string, string> = {
  synth: 'hydra-plaits',
  pad: 'rhodes-mk1',
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
  'midi-crash': 'rhodes-mk1',
  'midi-ride': 'rhodes-mk1',
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

// Stage 4 introduced `defaultChordVoicing` on Track. Older `.seq` files don't
// have the field — `parseChordVoicing` returns null. We hand back null here so
// the post-hydration step (`applyPositionalRoleDefaults`) can decide whether
// to fill in `{maj}` for row 1 or `{none}` elsewhere based on track ordering.
function hydrateDefaultChordVoicing(saved: unknown) {
  return parseChordVoicing(saved);
}

function hydratePitchInterp(saved: unknown): PitchInterp | null {
  return typeof saved === 'string' && (PITCH_INTERPS as readonly string[]).includes(saved)
    ? (saved as PitchInterp)
    : null;
}

function hydrateOctave(saved: unknown): number | null {
  if (typeof saved !== 'number' || !Number.isFinite(saved)) return null;
  return Math.max(-4, Math.min(4, Math.round(saved)));
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
    rate: hydrateRate((saved as { rate?: unknown }).rate),
    lockTiming: typeof saved.lockTiming === 'boolean' ? saved.lockTiming : false,
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
    pan:
      typeof saved.pan === 'number' && Number.isFinite(saved.pan)
        ? Math.max(0, Math.min(1, saved.pan))
        : 0.5,
    defaultChordVoicing:
      hydrateDefaultChordVoicing(
        (saved as { defaultChordVoicing?: unknown }).defaultChordVoicing
      ) ?? { ...DEFAULT_CHORD_VOICING },
    pitchInterp:
      hydratePitchInterp((saved as { pitchInterp?: unknown }).pitchInterp) ?? 'semitones',
    octave: hydrateOctave((saved as { octave?: unknown }).octave) ?? 0,
  };
}

// Walk hydrated tracks in array order, filling in position-based role
// defaults for any fields the raw save didn't carry. Three fields, one pass:
//   - `defaultChordVoicing`: first melodic track (slot 0) → `{maj}`, others
//     stay `{none}`. Row 1 = chord master regardless of voice.
//   - `pitchInterp`: slot 0 → 'semitones' (chord-master, field ignored);
//     slot 1 → 'chord-tone' (bass; step.pitch becomes a chord-tone index for
//     bass walks). slots 2+ → 'chord-tone' (motif).
//   - `octave`: slot 1 → -2 (drops bass two octaves below the chord master's
//     range). slots 0 and 2+ stay at 0.
// We compare against the raw saved data so explicit user choices survive a
// re-load — the position default only fires when the field was absent.
export function applyPositionalRoleDefaults(
  hydrated: Track[],
  rawSaved: Array<Partial<Track> & {
    defaultChordVoicing?: unknown;
    pitchInterp?: unknown;
    octave?: unknown;
  }>
): Track[] {
  let melodicSlot = -1;
  return hydrated.map((track, i) => {
    if (track.section !== 'melodic') return track;
    melodicSlot++;
    const raw = rawSaved[i];
    const rawHadChord = !!raw && raw.defaultChordVoicing !== undefined;
    const rawHadInterp = !!raw && raw.pitchInterp !== undefined;
    const rawHadOctave = !!raw && raw.octave !== undefined;
    let next = track;
    if (melodicSlot === 0 && !rawHadChord) {
      next = { ...next, defaultChordVoicing: { ...CHORD_MASTER_DEFAULT } };
    }
    if (!rawHadInterp) {
      const interp: PitchInterp = melodicSlot === 0 ? 'semitones' : 'chord-tone';
      next = { ...next, pitchInterp: interp };
    }
    if (!rawHadOctave) {
      next = { ...next, octave: melodicSlot === 1 ? -2 : 0 };
    }
    return next;
  });
}

// Slot 0 lands the chord-master role (per `applyPositionalChordDefaults`),
// so the first melodic voice should be one that handles chord assembly
// cleanly. rhodes-mk1 is the current best-sampled lead.
const EMPTY_MELODIC_VOICES = [
  'rhodes-mk1',
  'bass',
  'hydra-plaits',
  'hydra-plaits',
  'soft-piano',
  'tape-piano',
  'under-piano',
  'hydra-plaits',
];

export function emptyMelodicTrack(id: string, slot: number): Track {
  const steps = Array.from({ length: 64 }, () => hydrateStep({}));
  // Position-based role defaults. Slot 0 is the chord master (audible
  // I-triad default voicing, `semitones` interp since the field is ignored
  // for chord-master). Slot 1 is the bass — chord-tone interp with octave
  // -2 so it plays chord tones in bass range; user authors walks via
  // step.pitch (0=root, 1=3rd, 2=5th, -1=octave-up-5th-down, etc.).
  // Slots 2+ are motifs in chord-tone mode at the chord-master's octave.
  const defaultChordVoicing = slot === 0 ? { ...CHORD_MASTER_DEFAULT } : { ...DEFAULT_CHORD_VOICING };
  const pitchInterp: PitchInterp = slot === 0 ? 'semitones' : 'chord-tone';
  const octave = slot === 1 ? -2 : 0;
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
    rate: '1/16',
    lockTiming: false,
    euclidean: { hits: 0, rotation: 0 },
    steps,
    midi: { ...DEFAULT_TRACK_MIDI },
    gain: 1,
    fxSend: 0,
    pan: 0.5,
    defaultChordVoicing,
    pitchInterp,
    octave,
  };
}

function clamp01(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.max(0, Math.min(1, v))
    : fallback;
}

function hydrateBankMacros(saved: unknown, fallback: BankMacros): BankMacros {
  const m = (saved && typeof saved === 'object' ? saved : {}) as Partial<BankMacros>;
  return {
    density: clamp01(m.density, fallback.density),
    chaos: clamp01(m.chaos, fallback.chaos),
    motion: clamp01(m.motion, fallback.motion),
    drift: clamp01(m.drift, fallback.drift),
    tension: clamp01(m.tension, fallback.tension),
  };
}

function hydrateBankSlot(
  saved: unknown,
  fallbackMacros: BankMacros
): BankSlot | null {
  if (!saved || typeof saved !== 'object') return null;
  const obj = saved as { tracks?: unknown; macros?: unknown };
  if (!Array.isArray(obj.tracks)) return null;
  const tracks = (obj.tracks as Array<Partial<Track>>)
    .filter((t): t is Partial<Track> & { id: string } => !!t && typeof t.id === 'string')
    .map(hydrateTrack);
  if (tracks.length === 0) return null;
  return {
    tracks,
    macros: hydrateBankMacros(obj.macros, fallbackMacros),
  };
}

// Old .seq files have no banks field. Seed slot 0 from the loaded project
// (via `seedFromProject`) so the boot rule — slot 0 is always filled/active —
// also holds after loading legacy saves.
export function hydrateBanks(
  saved: unknown,
  seedFromProject: () => { tracks: Track[]; macros: BankMacros }
): (BankSlot | null)[] {
  const result: (BankSlot | null)[] = Array(BANK_SLOT_COUNT).fill(null);
  if (!Array.isArray(saved)) {
    const seed = seedFromProject();
    result[0] = { tracks: seed.tracks, macros: seed.macros };
    return result;
  }
  const fallbackMacros = seedFromProject().macros;
  for (let i = 0; i < BANK_SLOT_COUNT; i++) {
    result[i] = hydrateBankSlot(saved[i], fallbackMacros);
  }
  return result;
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
