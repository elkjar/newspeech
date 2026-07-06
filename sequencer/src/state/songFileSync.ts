// Performance-layer song ↔ file sync (2026-07-06). A `.seqset` stores
// references to `.seq` files on disk, so the runtime has to keep three
// things in step: the working document binding (docPath), the slot the
// working state came from, and the file that slot references.
//
//   - switchToSong: what UI/hardware call instead of the raw store
//     `loadSong` — flushes the outgoing song's unsaved edits to its bound
//     .seq first, so the file on disk always matches what you last heard
//     (the disk-level extension of the in-memory auto-snap in loadSong).
//   - installSongDocBinding: rebinds the document to the incoming slot's
//     .seq whenever the active song changes (manual load, tail-out commit,
//     ghost set-advance), so Cmd+S mid-set overwrites the right file.
//   - ensureWorkingSongSaved: the save-first gate for snapping a slot —
//     every slot in a set must be file-backed.

import { invoke, isTauri } from '@tauri-apps/api/core';
import { useSequencerStore } from './store';
import { exportProject } from './persist';
import { computeDocDirtyNow, setDocument } from './document';

const NATIVE = isTauri();

// Flush the outgoing working state to its bound .seq before a song swap.
// The bytes are captured synchronously (the swap mutates the store right
// after this returns); the disk write itself is fire-and-forget — the
// in-memory slot snap in loadSong already preserves the state, so a failed
// write costs freshness, not data.
function saveOutgoingSongFile(): void {
  if (!NATIVE) return;
  const s = useSequencerStore.getState();
  const path = s.docPath;
  if (!path || !computeDocDirtyNow()) return;
  const code = exportProject();
  invoke('save_text_file', { path, contents: code }).catch((err) => {
    console.error('[songFileSync] outgoing song save failed:', err);
    useSequencerStore.getState().pushToast({
      kind: 'error',
      text: `song save failed · ${path.split('/').pop() ?? path}`,
    });
  });
}

// Action-helper for song switching — all UI/hardware call sites route here
// so the outgoing-save behavior is uniform. The ghost's autonomous
// swapSongImmediate intentionally does NOT: it skips the in-memory snap so
// a performance doesn't bake runtime drift into the songs, and the same
// rationale applies to the files.
export function switchToSong(i: number): void {
  const s = useSequencerStore.getState();
  const song = s.performance.songs[i];
  if (!song) return;
  if (i === s.performance.activeSong && s.performance.pendingSong === null) return;
  saveOutgoingSongFile();
  s.loadSong(i);
}

// Save-first gate: returns the working song's bound path, saving through
// the canonical Transport save flow when unbound or dirty. Null when the
// user cancels the dialog (or the instrument-edits gate diverts — the
// caller's gesture just doesn't complete and can be retried).
export async function ensureWorkingSongSaved(): Promise<string | null> {
  if (!NATIVE) return null;
  const before = useSequencerStore.getState();
  if (before.docPath && !computeDocDirtyNow()) return before.docPath;
  // Dynamic import: state → components is the wrong direction statically,
  // but saveProject is the single source of truth for the save flow
  // (instrument gate, title-from-filename, binding) and duplicating it
  // here is the greater evil.
  const { saveProject } = await import('../components/Transport');
  await saveProject();
  return useSequencerStore.getState().docPath;
}

let unsubscribe: (() => void) | null = null;

// Rebind the working document when the active song changes. applySong
// unbinds (docPath null) as it swaps; this subscriber immediately rebinds
// to the incoming slot's referenced .seq. Baseline is a fresh export —
// dirty starts false at the swap and tracks edits made from there. A
// slot with no file reference (legacy set not yet re-saved) stays
// unbound: Cmd+S runs save-as, and the dialog's set-save extracts it.
export function installSongDocBinding(): void {
  if (unsubscribe) return;
  unsubscribe = useSequencerStore.subscribe((state, prev) => {
    if (state.performance.activeSong === prev.performance.activeSong) return;
    const i = state.performance.activeSong;
    // null isn't a swap — it's clearSong on the active slot or a reset that
    // manages its own binding (initProject). The working state is still
    // the same song; leave its document alone.
    if (i === null) return;
    const path = state.performance.songPaths[i] ?? null;
    setDocument(path, path ? exportProject() : null);
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribe?.();
    unsubscribe = null;
  });
}
