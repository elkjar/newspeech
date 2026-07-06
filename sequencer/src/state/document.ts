// Document binding — ties the working state to a .seq file on disk so save
// can silently overwrite instead of re-asking for a path every time.
//
// The store holds docPath/docDirty/songTitle (see store.ts); this module owns
// the last-saved serialized bytes (module scope — a few hundred KB of JSON
// has no business living in the store) and the dirty tracker. Dirty is
// computed by re-running exportProject() and comparing against those bytes:
// export normalizes most runtime churn (active bank/scene reset to slot 1,
// arrangement cursor zeroed, live state folded back into its slot) and
// normalizeForDirty below scrubs the rest (ghost-driven macros), so ghost
// bank swaps, scene walks, and song-mode playback all compare equal until the
// user actually edits something.

import { useSequencerStore, type SequencerState } from './store';
import { exportProject } from './persist';

let savedCode: string | null = null;
let savedNormalized: string | null = null;

// The ghost writes macros continuously during autonomous playback (per-bar
// lerps + the per-frame density smoother), and export folds the live macros
// into the active bank/scene/song slots — so a byte compare of exports goes
// permanently "edited" the moment transport runs with ghost on. Strip those
// volatile fields from BOTH sides of the dirty compare: the six top-level
// macro fields, every nested `macros` snapshot, and per-track `mutation`
// (folded snapshots included). Saves still capture the live values — this
// only normalizes the comparison.
const VOLATILE_MACROS = ['density', 'chaos', 'motion', 'drift', 'tension', 'voicing'] as const;

function scrubVolatile(node: unknown): void {
  if (Array.isArray(node)) {
    for (const item of node) scrubVolatile(item);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if (o.macros && typeof o.macros === 'object' && !Array.isArray(o.macros)) {
    const m = o.macros as Record<string, unknown>;
    for (const k of VOLATILE_MACROS) if (k in m) m[k] = 0;
  }
  if (typeof o.mutation === 'number' && Array.isArray(o.steps)) o.mutation = 0;
  for (const v of Object.values(o)) scrubVolatile(v);
}

export function normalizeForDirty(exported: string): string {
  try {
    const data = JSON.parse(exported) as Record<string, unknown>;
    for (const k of VOLATILE_MACROS) if (k in data) data[k] = 0;
    scrubVolatile(data);
    return JSON.stringify(data);
  } catch {
    return exported;
  }
}

// Bind (or unbind) the working state to a file. `code` is the exact bytes on
// disk — pass the string that was just written (save) or a fresh
// exportProject() after import (load; the raw file text won't round-trip
// byte-identical through hydration, so comparing against it would stick dirty).
// Dirty is re-derived from a fresh export rather than assumed false — an edit
// landing while the save's write was in flight must survive as "edited".
export function setDocument(path: string | null, code: string | null): void {
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
  savedCode = path ? code : null;
  savedNormalized = savedCode === null ? null : normalizeForDirty(savedCode);
  const docDirty =
    path !== null && savedNormalized !== null
      ? normalizeForDirty(exportProject()) !== savedNormalized
      : false;
  useSequencerStore.setState({ docPath: path, docDirty });
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
      runDirtyCompare();
    }, 400);
  });
}

function runDirtyCompare(): boolean {
  const s = useSequencerStore.getState();
  if (s.docPath === null || savedNormalized === null) return s.docDirty;
  if (s.docDirty) return true;
  if (normalizeForDirty(exportProject()) !== savedNormalized) {
    useSequencerStore.setState({ docDirty: true });
    return true;
  }
  return false;
}

// Synchronous flush of the debounced dirty compare — for the close/quit
// paths, which read dirty state in the same tick the user hits Cmd+W: an
// edit inside the 400ms window must not slip past the unsaved-changes gate.
export function computeDocDirtyNow(): boolean {
  if (pending !== null) {
    clearTimeout(pending);
    pending = null;
  }
  return runDirtyCompare();
}

// Module-scope subscriber — clean up under HMR or it stacks per hot reload.
// savedCode rides through hot.data so a reload doesn't silently disable
// dirty tracking for the rest of the session (docPath survives in the store).
if (import.meta.hot) {
  savedCode = (import.meta.hot.data.savedCode as string | null) ?? savedCode;
  savedNormalized = savedCode === null ? null : normalizeForDirty(savedCode);
  import.meta.hot.dispose((data) => {
    data.savedCode = savedCode;
    unsubscribe?.();
    unsubscribe = null;
    if (pending !== null) clearTimeout(pending);
    pending = null;
  });
}
