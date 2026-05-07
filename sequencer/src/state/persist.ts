import { useSequencerStore, type Track, type Step } from './store';
import type { Scale } from '../audio/scale';

interface PersistedState {
  version: number;
  bpm: number;
  rootNote: number;
  scale: Scale;
  tracks: Track[];
}

const CURRENT_VERSION = 1;

function hydrateStep(saved: Partial<Step>): Step {
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

function hydrateSlot(slot: Step[] | null | undefined): Step[] | null {
  if (!Array.isArray(slot)) return null;
  return Array.from({ length: 64 }, (_, i) => hydrateStep(slot[i] ?? {}));
}

function hydrateTrack(saved: Partial<Track> & { id: string }): Track {
  const length = saved.length ?? 16;
  const stepsRaw = Array.isArray(saved.steps) ? saved.steps : [];
  const steps = Array.from({ length: 64 }, (_, i) => hydrateStep(stepsRaw[i] ?? {}));
  return {
    id: saved.id,
    voice: saved.voice ?? 'kick',
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

export function exportProject(): string {
  const s = useSequencerStore.getState();
  const data: PersistedState = {
    version: CURRENT_VERSION,
    bpm: s.bpm,
    rootNote: s.rootNote,
    scale: s.scale,
    tracks: s.tracks,
  };
  return JSON.stringify(data, null, 2);
}

export function importProject(json: string): boolean {
  let data: PersistedState;
  try {
    data = JSON.parse(json);
  } catch {
    return false;
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.tracks)) return false;

  useSequencerStore.setState({
    bpm: typeof data.bpm === 'number' ? data.bpm : 120,
    rootNote: typeof data.rootNote === 'number' ? data.rootNote : 60,
    scale: data.scale ?? 'major',
    tracks: (data.tracks as unknown as Array<Partial<Track>>)
      .filter((t): t is Partial<Track> & { id: string } => !!t && typeof t.id === 'string')
      .map(hydrateTrack),
    globalStep: 0,
    selectedStep: null,
    tieAnchor: null,
  });
  return true;
}

export function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
