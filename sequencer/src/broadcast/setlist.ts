// BROADCAST's set conductor. Owns a setlist of .seq files (any length),
// keeps the CURRENT song in one performance slot and the NEXT pick parsed
// and waiting in another, and tells Ghost which slot to swap to when a
// composition ends (ghost.ts setNextSongProvider). Ghost does the actual
// swap (fadeTextures + swapSongImmediate) exactly as it does for a set in
// Sequence — this module only decides and pre-loads.
//
// Pick modes: `random` (default — uniform over the setlist minus the last
// few played, so nothing comes back too soon and everything gets heard) or
// `sequence` (folder order, wrapping). Drop a song in twice to weight it.
import { create } from 'zustand';
import { useSequencerStore, DEFAULT_PERFORMANCE } from '../state/store';
import { setNextSongProvider, setSongLengthProvider } from '../ghost/ghost';
import { expandSetPaths, readSeqEntry, songVoiceIds, type SetEntry } from '../state/setLoader';
import type { SeqGlobalFx } from '../state/persist';
import { applyNoiseSettings } from '../audio/noise';
import { bootLog, stationBootGate } from './boot';
import { samplePlayer } from '../audio/samplePlayer';
import { togglePlayback } from '../audio/transport';

export type PickMode = 'random' | 'sequence';
export type BroadcastStatus = 'idle' | 'loading' | 'running' | 'error' | 'ended';

export interface BroadcastState {
  entries: SetEntry[];
  // Indices into `entries`.
  current: number | null;
  next: number | null;
  // Performance slot holding the pre-loaded next song.
  nextSlot: number | null;
  recent: number[];
  mode: PickMode;
  // Dev only (`--song-bars N`): force every song to N bars. null = Ghost
  // decides (composition / arrangement end, or its own roll for scene-less
  // songs). No UI for this — the runner has no human controls.
  devSongBars: number | null;
  status: BroadcastStatus;
  error: string | null;
  played: number;
  startedAt: number | null;
  // Every folder / file path the set was built from (launch args + drops);
  // CARDS/ and INTERSTITIALS/ are looked up beside these.
  setPaths: string[];
  // File-level FX (master chain, reverb, delay, tape, glitch, saturation)
  // per staged performance slot — applied when that slot becomes current.
  slotFx: Record<number, SeqGlobalFx | null>;
  // `--first <name>`: open the set with this song (name match, case-insensitive,
  // prefix ok). Only the first pick — the rest is the pick mode.
  firstPick: string | null;
  setMode: (mode: PickMode) => void;
  setDevSongBars: (bars: number | null) => void;
}

export const useBroadcast = create<BroadcastState>((set) => ({
  entries: [],
  current: null,
  next: null,
  nextSlot: null,
  recent: [],
  mode: 'random',
  devSongBars: null,
  status: 'idle',
  error: null,
  played: 0,
  startedAt: null,
  setPaths: [],
  slotFx: {},
  firstPick: null,
  setMode: (mode) => set({ mode }),
  setDevSongBars: (devSongBars) => set({ devSongBars }),
}));

// How many recently-played songs are excluded from a random pick.
function recentWindow(n: number): number {
  return Math.min(Math.floor(n / 2), 8);
}

function pickIndex(): number | null {
  const s = useBroadcast.getState();
  const n = s.entries.length;
  if (n === 0) return null;
  if (n === 1) return 0;
  if (s.mode === 'sequence') {
    return s.current === null ? 0 : (s.current + 1) % n;
  }
  const exclude = new Set<number>(s.recent.slice(-recentWindow(n)));
  if (s.current !== null) exclude.add(s.current);
  const pool: number[] = [];
  for (let i = 0; i < n; i++) if (!exclude.has(i)) pool.push(i);
  const from = pool.length ? pool : [...Array(n).keys()].filter((i) => i !== s.current);
  return from[Math.floor(Math.random() * from.length)] ?? null;
}

// Parse the next pick into a free performance slot. Unreadable files are
// dropped from the setlist (logged) and the pick re-rolls, bounded.
// Read a song for the set: null when unreadable OR when it has no sample
// voices (external-MIDI-only — silent through the runner). Caller drops it.
async function readSetSong(entry: SetEntry) {
  const read = await readSeqEntry(entry);
  if (!read) return null;
  const { song, fx } = read;
  // Song mode authored (rows exist) → engage it: the arrangement is the
  // song's length and progression in BROADCAST, whether or not song mode
  // happened to be switched on when the file was saved.
  if (song.arrangement && song.arrangement.rows.length > 0 && !song.arrangement.active) {
    song.arrangement = { ...song.arrangement, active: true };
  }
  const voices = songVoiceIds(song);
  if (voices.length === 0) {
    console.warn(`[broadcast] skipping ${entry.name}: no sample voices (midi-only)`);
    return null;
  }
  return { song, voices, fx };
}

// A .seq's file-level FX are project-global in Sequence and never part of a
// Song snapshot, so a swap leaves the engine on whatever the previous song
// (or the defaults) set. Apply the incoming file's block so each song sounds
// the way it does when opened in Sequence. Store setters only — paramPush
// mirrors them to the engine on its next tick.
function applyGlobalFx(fx: SeqGlobalFx | null | undefined): void {
  if (!fx) return;
  const s = useSequencerStore.getState();
  s.setMaster(fx.master);
  s.setReverb(fx.reverb);
  s.setDelay(fx.delay);
  s.setTape(fx.tape);
  s.setGlitch(fx.glitch);
  s.setSaturation(fx.saturation);
  // NOISE unit: knobs + level restore, so a bed saved with the unit open
  // comes back sounding — the same restore a .seq open does in Sequence.
  applyNoiseSettings(fx.noise);
}

// Preload a song's voices into the native registry ahead of its swap so its
// first hits don't drop with "sample not loaded". Serial, best-effort.
async function preloadVoices(voices: string[]): Promise<void> {
  for (const v of voices) {
    try {
      await samplePlayer.preloadNativeForVoice(v);
    } catch (err) {
      console.warn('[broadcast] preload failed for', v, err);
    }
  }
}

let preparing = false;
let preparingPromise: Promise<void> | null = null;
async function prepareNext(): Promise<void> {
  if (preparing) return;
  preparing = true;
  preparingPromise = (async () => {
    try {
      await prepareNextInner();
    } finally {
      preparing = false;
      preparingPromise = null;
    }
  })();
  await preparingPromise;
}

async function prepareNextInner(): Promise<void> {
  const seq = useSequencerStore.getState();
  for (let attempt = 0; attempt < 8; attempt++) {
    const idx = pickIndex();
    if (idx === null) {
      useBroadcast.setState({ next: null, nextSlot: null });
      return;
    }
    const entry = useBroadcast.getState().entries[idx];
    const read = await readSetSong(entry);
    if (!read) {
      console.warn('[broadcast] dropping from set:', entry.path);
      useBroadcast.setState((s) => {
        const entries = s.entries.filter((_, i) => i !== idx);
        const fix = (i: number | null) => (i === null ? null : i > idx ? i - 1 : i);
        return {
          entries,
          current: fix(s.current),
          recent: s.recent.filter((i) => i !== idx).map((i) => (i > idx ? i - 1 : i)),
        };
      });
      continue;
    }
    const slot = seq.importSong(read.song, entry.path);
    if (slot === null) {
      console.warn('[broadcast] no free performance slot for next song');
      useBroadcast.setState({ next: null, nextSlot: null });
      return;
    }
    useBroadcast.setState((s) => ({ next: idx, nextSlot: slot, slotFx: { ...s.slotFx, [slot]: read.fx } }));
    console.info(`[broadcast] staged next: ${entry.name} → slot ${slot} (${read.voices.length} voices)`);
    // Ahead of the swap — a whole song early.
    void preloadVoices(read.voices);
    return;
  }
  useBroadcast.setState({ next: null, nextSlot: null });
}

let unsubscribe: (() => void) | null = null;

// Wire the provider + the "swap landed" subscription once per session.
function installConductor(): void {
  setNextSongProvider((store) => {
    const b = useBroadcast.getState();
    if (b.status !== 'running') return null;
    if (b.nextSlot !== null && !store.performance.songs[b.nextSlot]) {
      // The staged slot was emptied under us (a set reload raced a staging
      // — 2026-09-08: ns_2306 "stuck forever", the swap into an empty slot
      // was a silent no-op). Drop it and re-stage; this bar plays on.
      console.warn(`[broadcast] staged slot ${b.nextSlot} is empty — restaging`);
      useBroadcast.setState({ next: null, nextSlot: null });
      void prepareNext();
      return null;
    }
    if (b.nextSlot === null && !preparing) {
      // Self-heal: nothing staged (a failed read, a slow disk) — stage now so
      // the next bar can take it.
      void prepareNext();
    }
    return b.nextSlot;
  });
  setSongLengthProvider(() => useBroadcast.getState().devSongBars);
  if (unsubscribe) return;
  unsubscribe = useSequencerStore.subscribe((state, prev) => {
    const cur = state.performance.activeSong;
    if (cur === prev.performance.activeSong) return;
    const b = useBroadcast.getState();
    if (b.status !== 'running' || cur === null) return;
    if (cur !== b.nextSlot) return; // a swap we didn't stage (manual) — ignore
    // The pre-loaded next just became current. Free the outgoing slot and
    // stage the following pick.
    const prevSlot = prev.performance.activeSong;
    applyGlobalFx(b.slotFx[cur]);
    const fx = b.slotFx[cur];
    console.info(
      `[broadcast] now playing: ${b.next !== null ? b.entries[b.next]?.name : '?'} (slot ${cur}, freed ${prevSlot}) at ${new Date().toISOString()} · master input ${fx?.master?.input ?? '?'} trim ${fx?.master?.trim ?? '?'}`,
    );
    useBroadcast.setState((s) => ({
      current: s.next,
      next: null,
      nextSlot: null,
      recent: s.current === null ? s.recent : [...s.recent, s.current].slice(-16),
      played: s.played + 1,
    }));
    if (prevSlot !== null && prevSlot !== cur) {
      useSequencerStore.getState().clearSong(prevSlot);
    }
    void prepareNext();
  });
}

// Load a set from dropped / launch paths and start it. Replaces any running
// set. Stops and restarts playback so the first song starts on its downbeat.
// Re-entrant: standby lets the operator re-pick the set folder / samples /
// first song, each of which reloads — a newer load wins, an older one
// parked at the boot gate quietly steps aside.
let loadGen = 0;
export async function loadAndStartSet(paths: string[]): Promise<void> {
  const gen = ++loadGen;
  useBroadcast.setState({ status: 'loading', error: null });
  // Let an in-flight staging finish before we replace the slots it's
  // writing into — otherwise it lands a song in a slot we're about to clear
  // and the conductor keeps pointing at the hole.
  if (preparingPromise) await preparingPromise;
  if (gen !== loadGen) return;
  let entries: SetEntry[];
  try {
    entries = await expandSetPaths(paths);
  } catch (err) {
    useBroadcast.setState({ status: 'error', error: `could not read set: ${String(err)}` });
    return;
  }
  if (entries.length === 0) {
    useBroadcast.setState({ status: 'error', error: 'no .seq files found' });
    return;
  }
  if (gen !== loadGen) return;
  const seq = useSequencerStore.getState();
  if (seq.playing) await togglePlayback();
  // Fresh slots — clears whatever Sequence-side set was in the store.
  seq.replacePerformance({ ...DEFAULT_PERFORMANCE, songs: [...DEFAULT_PERFORMANCE.songs], songPaths: [...DEFAULT_PERFORMANCE.songPaths] });
  useBroadcast.setState({
    entries,
    current: null,
    next: null,
    nextSlot: null,
    recent: [],
    played: 0,
    startedAt: null,
    setPaths: [...paths],
  });
  installConductor();
  // First song: pick, parse, load into the working state (stopped → applies
  // immediately), then stage the next.
  let first: number | null = null;
  let read: Awaited<ReturnType<typeof readSetSong>> = null;
  for (let attempt = 0; attempt < 16 && read === null; attempt++) {
    const want = useBroadcast.getState().firstPick;
    if (attempt === 0 && want) {
      const w = want.toLowerCase();
      const es = useBroadcast.getState().entries;
      const hit = es.findIndex((e) => e.name.toLowerCase() === w);
      first = hit >= 0 ? hit : es.findIndex((e) => e.name.toLowerCase().startsWith(w));
      if (first < 0) {
        console.warn(`[broadcast] --first "${want}" not in set; picking at random`);
        first = pickIndex();
      }
    } else {
      first = pickIndex();
    }
    if (first === null) break;
    read = await readSetSong(useBroadcast.getState().entries[first]);
    if (!read) {
      const drop = first;
      useBroadcast.setState((s) => ({ entries: s.entries.filter((_, i) => i !== drop) }));
    }
  }
  if (first === null || !read) {
    useBroadcast.setState({ status: 'error', error: 'no playable songs in set (all midi-only or unreadable)' });
    return;
  }
  if (gen !== loadGen) return;
  const firstEntry = useBroadcast.getState().entries[first];
  const slot = useSequencerStore.getState().importSong(read.song, firstEntry.path);
  if (slot === null) {
    useBroadcast.setState({ status: 'error', error: 'no free slot' });
    return;
  }
  useSequencerStore.getState().loadSong(slot);
  applyGlobalFx(read.fx);
  useBroadcast.setState((s) => ({ current: first, status: 'running', startedAt: Date.now(), slotFx: { ...s.slotFx, [slot]: read.fx } }));
  console.info(`[broadcast] set loaded: ${useBroadcast.getState().entries.length} song(s); first: ${firstEntry.name} (slot ${slot})`);
  bootLog(`set: ${useBroadcast.getState().entries.length} songs · ${paths.map((p) => p.split('/').filter(Boolean).pop()).join(', ')}`);
  bootLog(`mode: ${useBroadcast.getState().mode} · ghost: on`);
  bootLog(`loading ${read.voices.length} voices for ${firstEntry.name}`);
  await preloadVoices(read.voices);
  if (gen !== loadGen) return;
  bootLog(`first: ${firstEntry.name}`);
  // Ghost drives everything in BROADCAST. Session-level flag — applySong
  // preserves it across every swap.
  useSequencerStore.getState().setSceneGraphEnabled(true);
  await prepareNext();
  const nx = useBroadcast.getState();
  if (nx.next !== null && nx.entries[nx.next]) bootLog(`staged: ${nx.entries[nx.next].name}`);
  // Station initializing: don't start the first downbeat before the boot
  // sequence has had its moment on screen.
  await stationBootGate();
  if (gen !== loadGen) return;
  bootLog('transport: start');
  if (!useSequencerStore.getState().playing) await togglePlayback();
}

// Append entries to a running set without interrupting playback.
export async function addToSet(paths: string[]): Promise<void> {
  const b = useBroadcast.getState();
  if (b.status !== 'running') {
    await loadAndStartSet(paths);
    return;
  }
  const more = await expandSetPaths(paths);
  useBroadcast.setState((s) => ({ setPaths: [...new Set([...s.setPaths, ...paths])] }));
  const have = new Set(b.entries.map((e) => e.path));
  const fresh = more.filter((e) => !have.has(e.path));
  if (fresh.length === 0) return;
  useBroadcast.setState((s) => ({ entries: [...s.entries, ...fresh] }));
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    unsubscribe?.();
    unsubscribe = null;
    setNextSongProvider(null);
    setSongLengthProvider(null);
  });
}
