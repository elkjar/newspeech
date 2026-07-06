// Document binding — ties the working state to a .seq file on disk so save
// can silently overwrite instead of re-asking for a path every time.
//
// The store holds docPath/docDirty/songTitle (see store.ts); this module owns
// the last-saved serialized bytes (module scope — a few hundred KB of JSON
// has no business living in the store) and the dirty tracker. Dirty is
// computed by re-running exportProject() and comparing against those bytes:
// export normalizes all runtime churn (active bank/scene reset to slot 1,
// arrangement cursor zeroed, live state folded back into its slot), so ghost
// bank swaps, scene walks, and song-mode playback all compare equal until the
// user actually edits something.

import { useSequencerStore, type SequencerState } from './store';
import { exportProject } from './persist';

let savedCode: string | null = null;

// Bind (or unbind) the working state to a file. `code` is the exact bytes on
// disk — pass the string that was just written (save) or a fresh
// exportProject() after import (load; the raw file text won't round-trip
// byte-identical through hydration, so comparing against it would stick dirty).
export function setDocument(path: string | null, code: string | null): void {
  savedCode = path ? code : null;
  useSequencerStore.setState({ docPath: path, docDirty: false });
}

// Adopt a just-imported .seq: derive a title when the file carried none
// (older files have no `name` field), then bind. `sourceName` covers the
// no-path cases (web drop) where only the dropped file's name is known.
export function adoptLoadedFile(path: string | null, sourceName?: string): void {
  const s = useSequencerStore.getState();
  if (!s.songTitle) {
    const base = (path ? path.split('/').pop() : sourceName) ?? '';
    const title = base.replace(/\.(seq|seqcomp|json)$/i, '').trim();
    if (title) s.setSongTitle(title);
  }
  setDocument(path, path ? exportProject() : null);
}

// Store keys whose reference change can mean the exported .seq changed.
// Everything exportProject reads except globalStep-ish runtime cursors —
// a ref change here only *schedules* the (accurate) compare, so being a
// little over-broad costs a debounced stringify, not a false "edited".
const WATCHED: (keyof SequencerState)[] = [
  'songTitle',
  'bpm',
  'rootNote',
  'scale',
  'tracks',
  'lfos',
  'midiOutDeviceId',
  'midiRecInputPort',
  'viewSection',
  'density',
  'chaos',
  'motion',
  'drift',
  'tension',
  'voicing',
  'tape',
  'glitch',
  'reverb',
  'delay',
  'saturation',
  'master',
  'banks',
  'activeBank',
  'sceneGraph',
  'composition',
  'arrangement',
];

let unsubscribe: (() => void) | null = null;
let pending: ReturnType<typeof setTimeout> | null = null;

export function installDocumentTracking(): void {
  if (unsubscribe) return;
  unsubscribe = useSequencerStore.subscribe((state, prev) => {
    // Nothing bound, or already dirty (only save/load clears it — there's
    // no undo to walk back to the saved state) — skip the compare.
    if (state.docPath === null || state.docDirty || savedCode === null) return;
    if (!WATCHED.some((k) => state[k] !== prev[k])) return;
    if (pending !== null) clearTimeout(pending);
    pending = setTimeout(() => {
      pending = null;
      const s = useSequencerStore.getState();
      if (s.docPath === null || savedCode === null) return;
      if (exportProject() !== savedCode) {
        useSequencerStore.setState({ docDirty: true });
      }
    }, 400);
  });
}

// Module-scope subscriber — clean up under HMR or it stacks per hot reload.
// savedCode rides through hot.data so a reload doesn't silently disable
// dirty tracking for the rest of the session (docPath survives in the store).
if (import.meta.hot) {
  savedCode = (import.meta.hot.data.savedCode as string | null) ?? savedCode;
  import.meta.hot.dispose((data) => {
    data.savedCode = savedCode;
    unsubscribe?.();
    unsubscribe = null;
    if (pending !== null) clearTimeout(pending);
    pending = null;
  });
}
