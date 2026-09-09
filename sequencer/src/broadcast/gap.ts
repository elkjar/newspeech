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
// `off` = signed off (end of transmission): transport stopped, static
// settling, the sign-off panel up. Terminal.
// 'swap' = the short gap between every two songs (Chris 2026-09-08: "the
// swap between songs could use some space … fading into static with a short
// interstitial wav with a loading indicator"): the transport stops on the
// bar, the outgoing tails ring under rising static, a random interstitial
// plays for SWAP_GAP_SECS (faded out if longer), the staged song starts on
// its own downbeat with its own master — no more +13 dB step of the incoming
// master landing on the outgoing tails (measured 2026-09-08). 'hold' is the
// full interstitial on the station clock, picker at its end.
export type GapPhase = 'none' | 'hold' | 'swap' | 'reboot' | 'boot' | 'off';

export interface GapState {
  phase: GapPhase;
  progress: number; // 0..1 within the phase
  startedAt: number; // performance.now()
  duration: number; // ms
  wav: string | null;
  nextIdx: number | null;
  files: string[];
  // The running/last gap was a short swap gap (its reboot is short too and
  // shows no boot log).
  short: boolean;
  count: number; // interstitials played this session
  lastAt: number | null; // Date.now()
  nextDueAt: number | null; // Date.now() — the station clock
  // Dev only (`--gap-every N`): an interstitial every N songs instead of the
  // clock. No UI.
  devEvery: number | null;
  // `--songs N`: sign off after N songs have played (null = forever).
  songLimit: number | null;
  signedOffAt: number | null; // Date.now()
}

export const REBOOT_SECS = 28;
export const SWAP_GAP_SECS = 8;
const SWAP_FADE_IN_SECS = 1.2;
const SWAP_FADE_SECS = 1.5;
export const SWAP_REBOOT_SECS = 8;
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
  short: false,
  count: 0,
  lastAt: null,
  nextDueAt: null,
  devEvery: null,
  songLimit: null,
  signedOffAt: null,
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

export async function scanInterstitials(setPaths: string[], explicitDir: string | null = null): Promise<void> {
  const files = new Set<string>();
  for (const dir of explicitDir ? [explicitDir] : siblingFolders(setPaths, 'INTERSTITIALS')) {
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

// A random interstitial (not the last one), or null when the folder is empty.
// The boot sequence uses this too (boot.ts) — the static under the log.
export function pickInterstitial(): string | null {
  return useGap.getState().files.length ? pickWav() : null;
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
  if (g.phase === 'boot' || g.phase === 'off') return;
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

// The gap between songs. Called from the interceptor; the transport stop is
// deferred (scheduler.stop() must not run inside its own tick). `short` is
// the swap gap between every two songs; otherwise the full interstitial,
// whose WAV's length IS the gap.
async function runGap(nextSlot: number, short: boolean): Promise<void> {
  const files = useGap.getState().files;
  const wav = files.length ? pickWav() : null;
  const b = useBroadcast.getState();
  // Claim the phase synchronously — the interceptor is asked again every
  // tick until the transport actually stops.
  useGap.setState({
    phase: short ? 'swap' : 'hold',
    progress: 0,
    startedAt: performance.now(),
    duration: short ? SWAP_GAP_SECS * 1000 : 30_000,
    wav,
    nextIdx: b.next,
    short,
    ...(short ? {} : { count: useGap.getState().count + 1, lastAt: Date.now() }),
  });
  startTicker();
  // Stop the transport (fades textures) — deferred out of the tick.
  await Promise.resolve();
  const seq = useSequencerStore.getState();
  if (seq.clickIn) useSequencerStore.setState({ clickIn: false });
  if (seq.playing) await togglePlayback();
  let secs = short ? SWAP_GAP_SECS : 30;
  if (wav) {
    try {
      const info = await loadSample(wav);
      if (!short) secs = Math.max(4, info.durationSecs);
    } catch (err) {
      console.warn('[gap] could not load interstitial, using silence:', wav, err);
    }
  }
  useGap.setState({ startedAt: performance.now(), duration: secs * 1000 });
  console.info(`[gap] ${short ? 'swap gap' : 'interstitial'} ${wav ? wav.split('/').pop() : '(silence)'} (${secs.toFixed(1)} s) → then slot ${nextSlot}`);
  if (wav) {
    try {
      // The short gap's WAV fades in and out on its own envelope — static
      // rising under the outgoing tails, gone under the downbeat — and is a
      // texture voice so a transport stop rings it down rather than cutting.
      await triggerSample(
        wav,
        short
          ? {
              gain: 1,
              isTexture: true,
              envelopeAttack: SWAP_FADE_IN_SECS,
              envelopeHold: Math.max(0.5, secs - SWAP_FADE_SECS),
              envelopeRelease: SWAP_FADE_SECS,
            }
          : { gain: 1 },
      );
    } catch (err) {
      console.warn('[gap] interstitial trigger failed:', err);
    }
  }
  // Swap + restart when the gap ends. loadSong while stopped applies at
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
    const rebootSecs = short ? SWAP_REBOOT_SECS : REBOOT_SECS;
    useGap.setState({ phase: 'reboot', progress: 0, startedAt: performance.now(), duration: rebootSecs * 1000 });
    if (!short) armClock(false);
    console.info(`[gap] reboot (${rebootSecs} s)`);
  }, Math.max(0, secs * 1000 - lead));
}

// End of transmission: the Nth song has ended. Same collapse as a hold, one
// interstitial under it, then the transport stays stopped and the static
// settles — the station signs off rather than cutting to nothing.
async function runSignOff(): Promise<void> {
  const files = useGap.getState().files;
  const wav = files.length ? pickWav() : null;
  useGap.setState({ phase: 'off', progress: 0, startedAt: performance.now(), duration: 60_000, wav, signedOffAt: Date.now() });
  startTicker();
  console.info(`[gap] signing off after ${useBroadcast.getState().played + 1} songs${wav ? ` · ${wav.split('/').pop()}` : ''}`);
  await Promise.resolve();
  const seq = useSequencerStore.getState();
  if (seq.playing) await togglePlayback();
  if (wav) {
    try {
      const info = await loadSample(wav);
      useGap.setState({ duration: Math.max(4, info.durationSecs) * 1000 });
      await triggerSample(wav, { gain: 1 });
    } catch (err) {
      console.warn('[gap] sign-off interstitial failed:', err);
    }
  }
  useBroadcast.setState({ status: 'ended' });
}

function shouldSignOff(): boolean {
  const g = useGap.getState();
  if (g.songLimit === null || g.phase !== 'none') return false;
  const b = useBroadcast.getState();
  return b.status === 'running' && b.played + 1 >= g.songLimit;
}

let installed = false;
export function installGapConductor(): () => void {
  if (installed) return () => {};
  installed = true;
  setSongEndInterceptor((_store, nextSlot) => {
    // While a gap is running (the tick or two before the transport stops,
    // and the reboot) the end stays ours — Ghost must not swap under us.
    const phase = useGap.getState().phase;
    if (phase === 'hold' || phase === 'swap' || phase === 'off') return true;
    if (shouldSignOff()) {
      void runSignOff();
      return true;
    }
    // Every song end is a gap: the full interstitial when the station clock
    // says so, the short swap gap otherwise.
    void runGap(nextSlot, !shouldGap());
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
  useGap.setState({ phase, progress: 0, startedAt: performance.now(), duration: secs * 1000, short: phase === 'swap' });
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
