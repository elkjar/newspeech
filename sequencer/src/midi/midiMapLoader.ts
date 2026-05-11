// Boot-time loader: reads user maps from localStorage and installs
// them into the mapping store. All maps are user-created — there are
// no bundled defaults; users build their own mappings via learn mode.

import { parseMidiMapFile, type MidiMapFile } from './midiMapFile';
import { useMidiMapStore } from './midiMapStore';

const LS_USER_MAPS = 'newspeech.sequencer.midiMaps.user';
const LS_ACTIVE = 'newspeech.sequencer.activeMidiMap';

function loadUserMaps(): MidiMapFile[] {
  try {
    const raw = localStorage.getItem(LS_USER_MAPS);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: MidiMapFile[] = [];
    for (const m of parsed) {
      const file = parseMidiMapFile(JSON.stringify(m), 'user');
      if (file) out.push(file);
    }
    return out;
  } catch {
    return [];
  }
}

function readStoredActiveId(): string | null {
  try {
    return localStorage.getItem(LS_ACTIVE);
  } catch {
    return null;
  }
}

export async function loadMidiMapLibrary(): Promise<void> {
  const user = loadUserMaps();
  const merged: Record<string, MidiMapFile> = {};
  for (const m of user) merged[m.id] = m;

  const storedActive = readStoredActiveId();
  const activeId = storedActive && merged[storedActive] ? storedActive : null;

  useMidiMapStore.getState().setLibrary(merged, activeId);
}
