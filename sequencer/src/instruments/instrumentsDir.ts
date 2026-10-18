// MIDI instrument library folder — one `<id>.midiinstrument` file per
// instrument (the same UserInstrumentFile JSON the export button writes).
// Default `~/Documents/Sequence/instruments`; Chris points it at Dropbox so
// the installed app, the dev app and other machines share one library.
// Same override pattern as the user samples dir: localStorage key set from
// Settings, cleared by "reset". Pure file layer — the store owns the sync
// policy (userInstrumentsStore.syncUserInstrumentsFromDisk).

import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Instrument } from './library';
import type { UserInstrumentFile } from './userInstrumentsStore';

const LS_INSTRUMENTS_DIR = 'newspeech.sequencer.instrumentsDir';
const EXT = 'midiinstrument';

export function getConfiguredInstrumentsDir(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const v = localStorage.getItem(LS_INSTRUMENTS_DIR);
  return v && v.trim() ? v : null;
}

export function setConfiguredInstrumentsDir(dir: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (dir && dir.trim()) localStorage.setItem(LS_INSTRUMENTS_DIR, dir);
  else localStorage.removeItem(LS_INSTRUMENTS_DIR);
}

// Active folder, or null when it can't be used right now (web build, or a
// chosen folder that doesn't exist — e.g. Dropbox not mounted). Callers
// treat null as "leave the cached library alone".
export async function resolveInstrumentsDir(): Promise<string | null> {
  if (!isTauri()) return null;
  const configured = getConfiguredInstrumentsDir();
  try {
    if (configured) {
      return (await invoke<boolean>('path_is_dir', { path: configured })) ? configured : null;
    }
    return await invoke<string>('get_instruments_dir');
  } catch (err) {
    console.warn('[instrumentsDir] resolve failed:', err);
    return null;
  }
}

function fileFor(dir: string, id: string): string {
  return `${dir.replace(/\/+$/, '')}/${id}.${EXT}`;
}

export interface DiskLibrary {
  instruments: Record<string, Instrument>;
  // ids whose file exists but couldn't be read/parsed — the store keeps its
  // cached copy for these instead of dropping them
  unreadable: string[];
}

export async function readInstrumentsDir(dir: string): Promise<DiskLibrary> {
  const paths = await invoke<string[]>('list_dir_files', { dir, exts: [EXT] });
  const out: DiskLibrary = { instruments: {}, unreadable: [] };
  for (const path of paths) {
    const base = path.split('/').pop()!.replace(new RegExp(`\\.${EXT}$`, 'i'), '');
    try {
      const parsed = JSON.parse(
        await invoke<string>('read_text_file', { path })
      ) as Partial<UserInstrumentFile>;
      const inst = parsed.instrument;
      if (parsed.schema !== 'newspeech.midiinstrument' || !inst || typeof inst.id !== 'string') {
        throw new Error('not a newspeech instrument file');
      }
      out.instruments[inst.id] = inst;
    } catch (err) {
      console.warn(`[instrumentsDir] skipping ${path}:`, err);
      out.unreadable.push(base);
    }
  }
  return out;
}

export async function writeInstrumentFile(dir: string, inst: Instrument): Promise<void> {
  const payload: UserInstrumentFile = {
    schema: 'newspeech.midiinstrument',
    version: 1,
    instrument: inst,
  };
  await invoke('save_text_file', {
    path: fileFor(dir, inst.id),
    contents: JSON.stringify(payload, null, 2) + '\n',
  });
}

export async function removeInstrumentFile(dir: string, id: string): Promise<void> {
  await invoke('remove_instrument_file', { path: fileFor(dir, id) });
}
