// Per-rig library of user-defined MIDI instruments. Same persistence model
// as the .midimap library: localStorage-backed, rig-bound (the hardware
// stays constant across projects). `.seq` files reference instruments by
// id; missing ids fall back to a silent track source on load — same
// fallback behavior the existing dispatch code already has.

import { create } from 'zustand';
import type { Instrument, InstrumentRole } from './library';

const LS_USER_INSTRUMENTS = 'newspeech.sequencer.instruments.user';

export interface UserInstrumentFile {
  schema: 'newspeech.midiinstrument';
  version: 1;
  instrument: Instrument;
}

interface UserInstrumentsState {
  userInstruments: Record<string, Instrument>;
  addInstrument: (i: Instrument) => void;
  updateInstrument: (id: string, patch: Partial<Instrument>) => void;
  removeInstrument: (id: string) => void;
  importInstrumentFromJson: (json: string) => { ok: boolean; error?: string };
  exportInstrument: (id: string) => { filename: string; json: string } | null;
}

function persist(map: Record<string, Instrument>): void {
  try {
    localStorage.setItem(LS_USER_INSTRUMENTS, JSON.stringify(Object.values(map)));
  } catch {
    /* best-effort */
  }
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
