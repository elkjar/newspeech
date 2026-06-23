// Mapping library state: bundled + user maps, active selection, learn
// mode. Kept in a separate zustand slice from the main sequencer store
// so the audible-engine code stays decoupled from controller plumbing.

import { create } from 'zustand';
import type { MidiBinding, MidiTarget } from './midiMap';
import { setActiveBindings, getActiveBindings, setLearnHook } from './midiMap';
import type { MidiMapFile } from './midiMapFile';
import { parseMidiMapFile, serializeMidiMapFile } from './midiMapFile';

const LS_USER_MAPS = 'newspeech.sequencer.midiMaps.user';
const LS_ACTIVE = 'newspeech.sequencer.activeMidiMap';
// Loader (midiMapLoader.ts) owns the localStorage reads on boot. This
// module only writes.

interface MidiMapStoreState {
  midiMaps: Record<string, MidiMapFile>;
  activeMidiMapId: string | null;
  learnMode: boolean;
  learnTarget: MidiTarget | null;

  setLibrary: (maps: Record<string, MidiMapFile>, activeId: string | null) => void;
  setActiveMap: (id: string | null) => void;
  setLearnMode: (on: boolean) => void;
  setLearnTarget: (t: MidiTarget | null) => void;
  bindLearnTarget: (msg: { ch: number; msg: 'cc' | 'note'; num: number }) => void;
  createUserMap: (name: string, bindings?: MidiBinding[]) => string;
  deleteUserMap: (id: string) => void;
  renameUserMap: (id: string, name: string) => void;
  importMapFromJson: (json: string) => { ok: boolean; error?: string };
  exportActiveMap: () => { filename: string; json: string } | null;
}

function saveUserMaps(maps: Record<string, MidiMapFile>): void {
  try {
    const user = Object.values(maps).filter((m) => m.source === 'user');
    localStorage.setItem(LS_USER_MAPS, JSON.stringify(user));
  } catch {
    // localStorage full / unavailable — best-effort only
  }
}

function saveActiveId(id: string | null): void {
  try {
    if (id) localStorage.setItem(LS_ACTIVE, id);
    else localStorage.removeItem(LS_ACTIVE);
  } catch {
    // ignore
  }
}

function applyActiveBindings(
  maps: Record<string, MidiMapFile>,
  activeId: string | null
): void {
  const map = activeId ? maps[activeId] : null;
  setActiveBindings(map ? map.bindings : []);
}

export const useMidiMapStore = create<MidiMapStoreState>((set, get) => ({
  midiMaps: {},
  activeMidiMapId: null,
  learnMode: false,
  learnTarget: null,

  setLibrary: (maps, activeId) => {
    applyActiveBindings(maps, activeId);
    saveActiveId(activeId);
    set({ midiMaps: maps, activeMidiMapId: activeId });
  },

  setActiveMap: (id) => {
    const { midiMaps } = get();
    if (id && !midiMaps[id]) return;
    applyActiveBindings(midiMaps, id);
    saveActiveId(id);
    set({ activeMidiMapId: id, learnTarget: null });
  },

  setLearnMode: (on) => {
    set({ learnMode: on, learnTarget: on ? get().learnTarget : null });
  },

  setLearnTarget: (t) => {
    set({ learnTarget: t });
  },

  bindLearnTarget: (msg) => {
    const state = get();
    const target = state.learnTarget;
    if (!target) return;
    const activeId = state.activeMidiMapId;
    let maps = state.midiMaps;
    let nextActiveId = activeId;

    // No active mapping yet — bind into a freshly-created user map.
    if (!activeId) {
      const fresh: MidiMapFile = {
        version: 1,
        id: `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: 'Untitled',
        source: 'user',
        bindings: [],
        createdAt: new Date().toISOString(),
      };
      maps = { ...maps, [fresh.id]: fresh };
      nextActiveId = fresh.id;
    }

    const targetMap = maps[nextActiveId!];
    // Remove any existing binding for this (ch, msg, num) AND any
    // existing binding for the same target — each physical CC and each
    // target should be bound to exactly one of the other.
    const filtered = targetMap.bindings.filter(
      (b) =>
        !(b.ch === msg.ch && b.msg === msg.msg && b.num === msg.num) &&
        b.target !== target
    );
    const updated: MidiMapFile = {
      ...targetMap,
      bindings: [
        ...filtered,
        { ch: msg.ch, msg: msg.msg, num: msg.num, target },
      ],
    };
    maps = { ...maps, [nextActiveId!]: updated };
    saveUserMaps(maps);
    applyActiveBindings(maps, nextActiveId);
    saveActiveId(nextActiveId);
    set({
      midiMaps: maps,
      activeMidiMapId: nextActiveId,
      learnTarget: null, // ready for next target click
    });
  },

  createUserMap: (name, bindings = []) => {
    const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const fresh: MidiMapFile = {
      version: 1,
      id,
      name,
      source: 'user',
      bindings: bindings.map((b) => ({ ...b })),
      createdAt: new Date().toISOString(),
    };
    const maps = { ...get().midiMaps, [id]: fresh };
    saveUserMaps(maps);
    applyActiveBindings(maps, id);
    saveActiveId(id);
    set({ midiMaps: maps, activeMidiMapId: id });
    return id;
  },

  deleteUserMap: (id) => {
    const state = get();
    if (!state.midiMaps[id] || state.midiMaps[id].source !== 'user') return;
    const maps = { ...state.midiMaps };
    delete maps[id];
    const nextActive = state.activeMidiMapId === id ? null : state.activeMidiMapId;
    saveUserMaps(maps);
    applyActiveBindings(maps, nextActive);
    saveActiveId(nextActive);
    set({ midiMaps: maps, activeMidiMapId: nextActive });
  },

  renameUserMap: (id, name) => {
    const state = get();
    const map = state.midiMaps[id];
    if (!map || map.source !== 'user' || !name) return;
    const maps = { ...state.midiMaps, [id]: { ...map, name } };
    saveUserMaps(maps);
    set({ midiMaps: maps });
  },

  importMapFromJson: (json) => {
    const parsed = parseMidiMapFile(json, 'user');
    if (!parsed) return { ok: false, error: 'invalid .midimap file' };
    // Always assign a fresh user id so imports never clobber bundled
    // or existing user maps with the same id.
    const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const imported: MidiMapFile = { ...parsed, id, source: 'user' };
    const maps = { ...get().midiMaps, [id]: imported };
    saveUserMaps(maps);
    applyActiveBindings(maps, id);
    saveActiveId(id);
    set({ midiMaps: maps, activeMidiMapId: id });
    return { ok: true };
  },

  exportActiveMap: () => {
    const state = get();
    if (!state.activeMidiMapId) return null;
    const map = state.midiMaps[state.activeMidiMapId];
    if (!map) return null;
    return {
      filename: `${map.id}.midimap`,
      json: serializeMidiMapFile(map),
    };
  },
}));

export { getActiveBindings };

// Install learn hook: when learnMode is on AND learnTarget is pinned,
// consume the next incoming MIDI message as a binding rather than a
// value change. Returns true if consumed.
setLearnHook((msg) => {
  const state = useMidiMapStore.getState();
  if (!state.learnMode || !state.learnTarget) return false;
  // Note-off is never a binding target — let it fall through to the recorder.
  if (msg.msg === 'noteoff') return false;
  // Clock messages are handled upstream and never reach here, but they carry no
  // ch/num to bind — exclude so the binding target stays note/cc only.
  if (msg.msg === 'realtime' || msg.msg === 'clock-tick') return false;
  state.bindLearnTarget(msg);
  return true;
});
