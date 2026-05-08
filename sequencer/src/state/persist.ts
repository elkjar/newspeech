import { useSequencerStore, type Track, type TrackSection } from './store';
import { ensureBothSections, hydrateTrack, hydrateLFOs } from './hydrate';
import { type LFO } from '../audio/lfo';
import type { Scale } from '../audio/scale';

interface PersistedState {
  version: number;
  bpm: number;
  rootNote: number;
  scale: Scale;
  tracks: Track[];
  lfos?: LFO[];
  midiOutDeviceId?: string | null;
  viewSection?: TrackSection;
}

const CURRENT_VERSION = 1;

export function exportProject(): string {
  const s = useSequencerStore.getState();
  const data: PersistedState = {
    version: CURRENT_VERSION,
    bpm: s.bpm,
    rootNote: s.rootNote,
    scale: s.scale,
    tracks: s.tracks,
    lfos: s.lfos,
    midiOutDeviceId: s.midiOutDeviceId,
    viewSection: s.viewSection,
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

  const tracks = ensureBothSections(
    (data.tracks as unknown as Array<Partial<Track>>)
      .filter((t): t is Partial<Track> & { id: string } => !!t && typeof t.id === 'string')
      .map(hydrateTrack)
  );
  const viewSection: TrackSection =
    data.viewSection === 'melodic' ? 'melodic' : 'drum';

  useSequencerStore.setState({
    bpm: typeof data.bpm === 'number' ? data.bpm : 120,
    rootNote: typeof data.rootNote === 'number' ? data.rootNote : 60,
    scale: data.scale ?? 'major',
    tracks,
    lfos: hydrateLFOs(data.lfos),
    midiOutDeviceId:
      typeof data.midiOutDeviceId === 'string' || data.midiOutDeviceId === null
        ? data.midiOutDeviceId
        : null,
    viewSection,
    selectingLFO: null,
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
