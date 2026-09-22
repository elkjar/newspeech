// The desktop ground — the image under the windows. A `BACKGROUNDS/` folder
// beside the set (any case; sibling of the set folder or inside it, like
// INTERSTITIALS/ and CARDS/) holds stills; every song or record load picks a
// fresh one at random (never the one showing) and the desktop crossfades to
// it. Empty or absent folder = the built-in ground (Desktop.tsx).
// Watched: re-scanned with the sibling folders whenever the set paths change.
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { siblingFolders } from './gap';
import { useBroadcast } from './setlist';

export interface GroundState {
  files: string[];
  current: string | null;
  // The one fading out under `current` (null after the fade).
  previous: string | null;
  changedAt: number; // performance.now()
}

export const GROUND_FADE_SECS = 2.2;

export const useGround = create<GroundState>(() => ({
  files: [],
  current: null,
  previous: null,
  changedAt: 0,
}));

export async function scanGround(setPaths: string[], explicitDir: string | null = null): Promise<void> {
  const files = new Set<string>();
  for (const dir of explicitDir ? [explicitDir] : siblingFolders(setPaths, 'BACKGROUNDS')) {
    try {
      for (const f of await invoke<string[]>('list_dir_files', { dir, exts: ['png', 'jpg', 'jpeg', 'webp'] })) files.add(f);
    } catch {
      // folder absent
    }
  }
  const list = [...files].sort();
  const prev = useGround.getState();
  if (list.length !== prev.files.length || list.some((f, i) => f !== prev.files[i])) {
    console.info(`[ground] ${list.length} background(s)`);
  }
  useGround.setState({ files: list });
  // Nothing showing yet (or the showing one is gone): pick now.
  const cur = useGround.getState().current;
  if (list.length && (cur === null || !list.includes(cur))) pickGround();
  if (!list.length && cur !== null) useGround.setState({ current: null, previous: null });
}

let fadeTimer: number | null = null;
// A fresh ground: random, not the one showing. The previous one stays
// underneath for the fade, then drops.
export function pickGround(): void {
  const { files, current } = useGround.getState();
  if (!files.length) return;
  const pool = files.length > 1 ? files.filter((f) => f !== current) : files;
  const next = pool[Math.floor(Math.random() * pool.length)];
  if (next === current) return;
  useGround.setState({ current: next, previous: current, changedAt: performance.now() });
  console.info(`[ground] ${next.split('/').pop()}`);
  if (fadeTimer !== null) window.clearTimeout(fadeTimer);
  fadeTimer = window.setTimeout(() => {
    fadeTimer = null;
    useGround.setState({ previous: null });
  }, GROUND_FADE_SECS * 1000 + 200);
}

// Every item load — a song swap landing, a record starting — is a new ground.
let installed: (() => void) | null = null;
export function installGround(): () => void {
  if (installed) return installed;
  let lastCurrent: number | null = useBroadcast.getState().current;
  let lastPlayed = useBroadcast.getState().played;
  const unsub = useBroadcast.subscribe((b) => {
    // `played` ticks once per item that becomes current (songs and records
    // alike); `current` alone can repeat when a set of one loops.
    if (b.played !== lastPlayed || b.current !== lastCurrent) {
      lastPlayed = b.played;
      lastCurrent = b.current;
      if (b.status === 'running' && b.played > 0) pickGround();
    }
  });
  installed = () => {
    unsub();
    installed = null;
    if (fadeTimer !== null) window.clearTimeout(fadeTimer);
    fadeTimer = null;
  };
  return installed;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    installed?.();
  });
}
