// Interstitials — the gap between two songs as a moment. Occasionally
// (a station clock, not every swap) the conductor takes a song's end away
// from Ghost: the transport stops, one random WAV from INTERSTITIALS/ plays
// as a one-shot through the engine, the desktop falls apart into static
// and shows only the next-song decision, and when the WAV ends the staged
// song loads and the transport restarts on its downbeat — the picture
// reboots window by window over the first bars.
//
// Folder: `INTERSTITIALS/` (any case) beside the set folder, or inside it.
// Watched — drop WAVs in while running. Empty folder = no interstitials,
// ordinary swaps only.
//
// Phases (read by signal.ts + Desktop.tsx):
//   none → hold (WAV playing; progress 0..1) → reboot (transport running
//   again; progress 0..1 over REBOOT_SECS) → none.
import { create } from 'zustand';
import { invoke } from '@tauri-apps/api/core';
import { useSequencerStore } from '../state/store';
import { setSongEndInterceptor } from '../ghost/ghost';
import { loadSample, triggerSample } from '../audio/nativeEngine';
import { togglePlayback } from '../audio/transport';
import { useBroadcast } from './setlist';
import { dirOf } from '../state/persist';

// `boot` = station initializing at launch (boot.ts) — same collapse as a
// hold, then the same reboot when the first song's transport starts.
export type GapPhase = 'none' | 'hold' | 'reboot' | 'boot';

export interface GapState {
  phase: GapPhase;
  progress: number; // 0..1 within the phase
  startedAt: number; // performance.now()
  duration: number; // ms
  wav: string | null;
  nextIdx: number | null;
  files: string[];
  count: number; // interstitials played this session
  lastAt: number | null; // Date.now()
  nextDueAt: number | null; // Date.now() — the station clock
  // Dev only (`--gap-every N`): an interstitial every N songs instead of the
  // clock. No UI.
  devEvery: number | null;
}

export const REBOOT_SECS = 28;
// Station clock: first interstitial this long after boot, then this range
// between them (Chris: occasionally, not between every song).
const FIRST_MIN = [14, 22];
const EVERY_MIN = [18, 30];
const jitter = ([a, b]: number[]) => (a + Math.random() * (b - a)) * 60_000;

export const useGap = create<GapState>(() => ({
  phase: 'none',
  progress: 0,
  startedAt: 0,
  duration: 0,
  wav: null,
  nextIdx: null,
  files: [],
  count: 0,
  lastAt: null,
  nextDueAt: null,
  devEvery: null,
}));

// Candidate folders beside / inside the set paths. macOS is case-insensitive
// so `INTERSTITIALS` finds `interstitials` too; other platforms get both.
export function siblingFolders(setPaths: string[], name: string): string[] {
  const out = new Set<string>();
  for (const p of setPaths) {
    const base = /\.(seq|seqset)$/i.test(p) ? dirOf(p) : p.replace(/\/+$/, '');
    for (const n of [name, name.toLowerCase()]) {
      out.add(`${base}/${n}`);
      out.add(`${dirOf(base)}/${n}`);
    }
  }
  return [...out];
}

export async function scanInterstitials(setPaths: string[]): Promise<void> {
  const files = new Set<string>();
  for (const dir of siblingFolders(setPaths, 'INTERSTITIALS')) {
    try {
      for (const f of await invoke<string[]>('list_dir_files', { dir, exts: ['wav', 'aif', 'aiff', 'flac'] })) files.add(f);
    } catch {
      // folder absent
    }
  }
  const list = [...files].sort();
  const prev = useGap.getState().files;
  if (list.length !== prev.length || list.some((f, i) => f !== prev[i])) {
    console.info(`[gap] ${list.length} interstitial(s)`);
  }
  useGap.setState({ files: list });
}

function armClock(first: boolean): void {
  useGap.setState({ nextDueAt: Date.now() + jitter(first ? FIRST_MIN : EVERY_MIN) });
}

// Should this song end become an interstitial?
function shouldGap(): boolean {
  const g = useGap.getState();
  if (g.phase !== 'none' || g.files.length === 0) return false;
  const b = useBroadcast.getState();
  if (b.status !== 'running' || b.nextSlot === null) return false;
  if (g.devEvery !== null) return g.devEvery > 0 && (b.played + 1) % g.devEvery === 0;
  if (g.nextDueAt === null) {
    armClock(true);
    return false;
  }
  return Date.now() >= g.nextDueAt;
}

let lastWav: string | null = null;
function pickWav(): string {
  const files = useGap.getState().files;
  const pool = files.length > 1 ? files.filter((f) => f !== lastWav) : files;
  const f = pool[Math.floor(Math.random() * pool.length)];
  lastWav = f;
  return f;
}

let ticker: number | null = null;
function tick(): void {
  const g = useGap.getState();
  if (g.phase === 'none') return;
  const p = Math.min(1, (performance.now() - g.startedAt) / g.duration);
  useGap.setState({ progress: p });
  if (g.phase === 'boot') return;
  if (g.phase === 'reboot' && p >= 1) {
    useGap.setState({ phase: 'none', progress: 0 });
    if (ticker !== null) {
      window.clearInterval(ticker);
      ticker = null;
    }
  }
}
function startTicker(): void {
  if (ticker === null) ticker = window.setInterval(tick, 50);
}

// The interstitial itself. Called from the interceptor; the transport stop
// is deferred (scheduler.stop() must not run inside its own tick).
async function runGap(nextSlot: number): Promise<void> {
  const wav = pickWav();
  const b = useBroadcast.getState();
  // Claim the phase synchronously — the interceptor is asked again every
  // tick until the transport actually stops.
  useGap.setState({
    phase: 'hold',
    progress: 0,
    startedAt: performance.now(),
    duration: 30_000,
    wav,
    nextIdx: b.next,
    count: useGap.getState().count + 1,
    lastAt: Date.now(),
  });
  startTicker();
  // Stop the transport (fades textures) — deferred out of the tick.
  await Promise.resolve();
  const seq = useSequencerStore.getState();
  if (seq.clickIn) useSequencerStore.setState({ clickIn: false });
  if (seq.playing) await togglePlayback();
  // The WAV's length IS the gap.
  let secs = 30;
  try {
    const info = await loadSample(wav);
    secs = Math.max(4, info.durationSecs);
  } catch (err) {
    console.warn('[gap] could not load interstitial, using 30 s of silence:', wav, err);
  }
  useGap.setState({ startedAt: performance.now(), duration: secs * 1000 });
  console.info(`[gap] interstitial ${wav.split('/').pop()} (${secs.toFixed(1)} s) → then slot ${nextSlot}`);
  try {
    await triggerSample(wav, { gain: 1 });
  } catch (err) {
    console.warn('[gap] interstitial trigger failed:', err);
  }
  // Swap + restart when the WAV ends. loadSong while stopped applies at
  // once (same path loadAndStartSet uses for the first song).
  const lead = 120;
  window.setTimeout(async () => {
    const st = useSequencerStore.getState();
    if (useBroadcast.getState().status !== 'running') {
      useGap.setState({ phase: 'none', progress: 0 });
      return;
    }
    if (st.performance.songs[nextSlot]) st.loadSong(nextSlot);
    else console.warn('[gap] staged slot emptied during the gap; restarting current');
    if (!useSequencerStore.getState().playing) await togglePlayback();
    useGap.setState({ phase: 'reboot', progress: 0, startedAt: performance.now(), duration: REBOOT_SECS * 1000 });
    armClock(false);
    console.info('[gap] reboot');
  }, Math.max(0, secs * 1000 - lead));
}

let installed = false;
export function installGapConductor(): () => void {
  if (installed) return () => {};
  installed = true;
  setSongEndInterceptor((_store, nextSlot) => {
    // While a gap is running (the tick or two before the transport stops,
    // and the reboot) the end stays ours — Ghost must not swap under us.
    if (useGap.getState().phase === 'hold') return true;
    if (!shouldGap()) return false;
    void runGap(nextSlot);
    return true;
  });
  return () => {
    installed = false;
    setSongEndInterceptor(null);
    if (ticker !== null) window.clearInterval(ticker);
    ticker = null;
  };
}

// Enter a phase now (boot.ts uses this for boot → reboot).
export function startGapPhase(phase: GapPhase, secs: number): void {
  useGap.setState({ phase, progress: 0, startedAt: performance.now(), duration: secs * 1000 });
  if (phase !== 'none') startTicker();
}

// Demo / screenshots: fake a phase without the engine.
export function demoGap(phase: GapPhase, secs = 60): void {
  useGap.setState({
    wav: '/demo/INTERSTITIALS/glitch-test.wav',
    nextIdx: 11,
    files: ['/demo/INTERSTITIALS/glitch-test.wav'],
  });
  startGapPhase(phase, secs);
}

// Dev: force an interstitial at the next song end.
export function forceGapNext(): void {
  useGap.setState({ nextDueAt: 0 });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    installed = false;
    setSongEndInterceptor(null);
    if (ticker !== null) window.clearInterval(ticker);
    ticker = null;
  });
}
