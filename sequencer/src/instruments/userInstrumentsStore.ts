// Per-rig library of user-defined MIDI instruments. The instruments folder
// (instrumentsDir.ts — one .midiinstrument file each, Dropbox-shareable) is
// the source of truth; localStorage is a synchronous cache so hydrate and
// the engine can read instruments before any async load lands. Every edit
// writes through to the folder; syncUserInstrumentsFromDisk() reloads the
// folder at boot and on window focus. `.seq` files reference instruments by
// id; a missing id keeps the track's own saved routing (hydrate.ts).

import { create } from 'zustand';
import { isTauri } from '@tauri-apps/api/core';
import type { Instrument, InstrumentRole } from './library';
import {
  readInstrumentsDir,
  removeInstrumentFile,
  resolveInstrumentsDir,
  writeInstrumentFile,
} from './instrumentsDir';

const LS_USER_INSTRUMENTS = 'newspeech.sequencer.instruments.user';
// Set once this app has handed its localStorage library to the folder.
// After that the folder alone decides — an empty folder means "no
// instruments", never "copy the old cache back in".
const LS_MIGRATED = 'newspeech.sequencer.instruments.migratedToFiles';

export interface UserInstrumentFile {
  schema: 'newspeech.midiinstrument';
  version: 1;
  instrument: Instrument;
}

export interface UserLibraryFile {
  schema: 'newspeech.midilibrary';
  version: 1;
  instruments: Instrument[];
}

interface UserInstrumentsState {
  userInstruments: Record<string, Instrument>;
  addInstrument: (i: Instrument) => void;
  updateInstrument: (id: string, patch: Partial<Instrument>) => void;
  removeInstrument: (id: string) => void;
  importInstrumentFromJson: (json: string) => { ok: boolean; error?: string };
  exportInstrument: (id: string) => { filename: string; json: string } | null;
  exportLibrary: () => { filename: string; json: string } | null;
  importLibraryOrInstrumentFromJson: (
    json: string
  ) => { ok: boolean; error?: string; imported?: number };
}

function cacheOnly(map: Record<string, Instrument>): void {
  try {
    localStorage.setItem(LS_USER_INSTRUMENTS, JSON.stringify(Object.values(map)));
  } catch {
    /* best-effort */
  }
  lastWritten = map;
}

function persist(map: Record<string, Instrument>): void {
  try {
    localStorage.setItem(LS_USER_INSTRUMENTS, JSON.stringify(Object.values(map)));
  } catch {
    /* best-effort */
  }
  writeThrough(map);
}

// --- folder write-through -------------------------------------------------
// File ops run one at a time in edit order. `localGen` bumps on every edit
// so a disk sync that started before the edit doesn't overwrite it.
let lastWritten: Record<string, Instrument> = load();
let writeQueue: Promise<void> = Promise.resolve();
let localGen = 0;

function writeThrough(next: Record<string, Instrument>): void {
  const prev = lastWritten;
  lastWritten = next;
  localGen++;
  if (!isTauri()) return;
  const changed = Object.values(next).filter(
    (i) => JSON.stringify(i) !== JSON.stringify(prev[i.id])
  );
  const removed = Object.keys(prev).filter((id) => !next[id]);
  if (changed.length === 0 && removed.length === 0) return;
  writeQueue = writeQueue.then(async () => {
    const dir = await resolveInstrumentsDir();
    if (!dir) {
      console.warn('[instruments] folder unavailable — edit kept in the app cache only');
      return;
    }
    for (const inst of changed) {
      await writeInstrumentFile(dir, inst).catch((e) =>
        console.warn(`[instruments] write ${inst.id} failed:`, e)
      );
    }
    for (const id of removed) {
      await removeInstrumentFile(dir, id).catch((e) =>
        console.warn(`[instruments] remove ${id} failed:`, e)
      );
    }
  });
}

function load(): Record<string, Instrument> {
  try {
    const raw = localStorage.getItem(LS_USER_INSTRUMENTS);
    if (!raw) return {};
    const arr = JSON.parse(raw) as Instrument[];
    if (!Array.isArray(arr)) return {};
    const out: Record<string, Instrument> = {};
    for (const i of arr) {
      if (i && typeof i.id === 'string') out[i.id] = i;
    }
    return out;
  } catch {
    return {};
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);
}

export function generateInstrumentId(
  name: string,
  existing: Record<string, Instrument>
): string {
  const base = slugify(name) || 'instrument';
  if (!existing[base]) return base;
  let i = 2;
  while (existing[`${base}-${i}`]) i++;
  return `${base}-${i}`;
}

export const useUserInstrumentsStore = create<UserInstrumentsState>((set, get) => ({
  userInstruments: load(),

  addInstrument: (instrument) => {
    set((state) => {
      const next = { ...state.userInstruments, [instrument.id]: instrument };
      persist(next);
      return { userInstruments: next };
    });
  },

  updateInstrument: (id, patch) => {
    set((state) => {
      const existing = state.userInstruments[id];
      if (!existing) return state;
      const next = { ...state.userInstruments, [id]: { ...existing, ...patch, id } };
      persist(next);
      return { userInstruments: next };
    });
  },

  removeInstrument: (id) => {
    set((state) => {
      if (!state.userInstruments[id]) return state;
      const next = { ...state.userInstruments };
      delete next[id];
      persist(next);
      return { userInstruments: next };
    });
  },

  importInstrumentFromJson: (json) => {
    try {
      const parsed = JSON.parse(json) as Partial<UserInstrumentFile>;
      if (parsed.schema !== 'newspeech.midiinstrument') {
        return { ok: false, error: 'not a newspeech instrument file' };
      }
      if (!parsed.instrument || typeof parsed.instrument.id !== 'string') {
        return { ok: false, error: 'missing instrument record' };
      }
      const existing = get().userInstruments;
      let inst = parsed.instrument as Instrument;
      if (existing[inst.id]) {
        // Avoid clobber — give it a fresh id derived from the label.
        const newId = generateInstrumentId(inst.label ?? inst.id, existing);
        inst = { ...inst, id: newId };
      }
      get().addInstrument(inst);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },

  exportInstrument: (id) => {
    const inst = get().userInstruments[id];
    if (!inst) return null;
    const payload: UserInstrumentFile = {
      schema: 'newspeech.midiinstrument',
      version: 1,
      instrument: inst,
    };
    return {
      filename: `${inst.id}.midiinstrument`,
      json: JSON.stringify(payload, null, 2),
    };
  },

  exportLibrary: () => {
    const all = Object.values(get().userInstruments);
    if (all.length === 0) return null;
    const payload: UserLibraryFile = {
      schema: 'newspeech.midilibrary',
      version: 1,
      instruments: all,
    };
    const ts = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/T/, '_')
      .slice(0, 15);
    return {
      filename: `newspeech-instruments-${ts}.midilibrary`,
      json: JSON.stringify(payload, null, 2),
    };
  },

  importLibraryOrInstrumentFromJson: (json) => {
    try {
      const parsed = JSON.parse(json) as {
        schema?: string;
        instruments?: Instrument[];
        instrument?: Instrument;
      };
      const existing = get().userInstruments;
      if (parsed.schema === 'newspeech.midilibrary') {
        const arr = Array.isArray(parsed.instruments) ? parsed.instruments : [];
        let imported = 0;
        let map = { ...existing };
        for (const raw of arr) {
          if (!raw || typeof raw.id !== 'string') continue;
          let inst = raw as Instrument;
          if (map[inst.id]) {
            const newId = generateInstrumentId(inst.label ?? inst.id, map);
            inst = { ...inst, id: newId };
          }
          map = { ...map, [inst.id]: inst };
          imported++;
        }
        persist(map);
        set({ userInstruments: map });
        return { ok: true, imported };
      }
      if (parsed.schema === 'newspeech.midiinstrument') {
        const result = get().importInstrumentFromJson(json);
        return { ...result, imported: result.ok ? 1 : 0 };
      }
      return { ok: false, error: 'unrecognized file schema' };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  },
}));

/**
 * Non-React accessors for library.ts merge logic. Called from engine /
 * dispatch paths that can't use hooks.
 */
export function getUserInstruments(): Record<string, Instrument> {
  return useUserInstrumentsStore.getState().userInstruments;
}

export function getUserInstrument(id: string): Instrument | undefined {
  return useUserInstrumentsStore.getState().userInstruments[id];
}

export function getUserInstrumentsForRole(role: InstrumentRole): Instrument[] {
  const map = useUserInstrumentsStore.getState().userInstruments;
  return Object.values(map).filter((i) => i.role === role);
}

export type InstrumentSyncResult =
  | { status: 'unavailable' }
  | { status: 'seeded'; count: number; dir: string }
  | { status: 'loaded'; count: number; dir: string; changed: boolean };

/**
 * Pull the instruments folder into the store. Boot, window focus and the
 * Settings folder picker call this. `seedIfEmpty` (folder change) writes the
 * current library into an empty folder; otherwise an empty folder is only
 * seeded the first time this app migrates off localStorage.
 */
export async function syncUserInstrumentsFromDisk(
  opts: { seedIfEmpty?: boolean } = {}
): Promise<InstrumentSyncResult> {
  const dir = await resolveInstrumentsDir();
  if (!dir) return { status: 'unavailable' };
  await writeQueue;
  const gen = localGen;
  let disk;
  try {
    disk = await readInstrumentsDir(dir);
  } catch (err) {
    console.warn('[instruments] read folder failed:', err);
    return { status: 'unavailable' };
  }
  const cache = useUserInstrumentsStore.getState().userInstruments;
  const migrated = localStorage.getItem(LS_MIGRATED) === '1';
  const folderEmpty =
    Object.keys(disk.instruments).length === 0 && disk.unreadable.length === 0;
  if (folderEmpty && (opts.seedIfEmpty || !migrated) && Object.keys(cache).length > 0) {
    const all = Object.values(cache);
    for (const inst of all) await writeInstrumentFile(dir, inst);
    localStorage.setItem(LS_MIGRATED, '1');
    console.info(`[instruments] seeded ${all.length} instrument(s) into ${dir}`);
    return { status: 'seeded', count: all.length, dir };
  }
  localStorage.setItem(LS_MIGRATED, '1');
  const next = { ...disk.instruments };
  for (const id of disk.unreadable) if (cache[id] && !next[id]) next[id] = cache[id];
  // An edit landed while we were reading — the write-through has it; the
  // next sync picks the folder up again.
  if (gen !== localGen) return { status: 'loaded', count: Object.keys(cache).length, dir, changed: false };
  const changed = JSON.stringify(next) !== JSON.stringify(cache);
  if (changed) {
    cacheOnly(next);
    useUserInstrumentsStore.setState({ userInstruments: next });
  }
  return { status: 'loaded', count: Object.keys(next).length, dir, changed };
}
