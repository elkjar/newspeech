// Native recorder bridge. Subscribes to the store's `armed && playing`
// edge and drives `audio_start_recording_combined` / `audio_stop_recording_combined`
// on transitions. Audio path lives entirely in Rust — no IPC for sample
// bytes, no WebAudio worklet, no main-thread encoding.
//
// Phase 7f-1: combined only. Splits land in 7f-2.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { useSequencerStore } from '../state/store';
import { getConfiguredRecordingsDir } from './recorderConfig';
import {
  isNativeAudioAvailable,
  startRecordingCombined,
  stopRecordingCombined,
  startRecordingSplits,
  stopRecordingSplits,
} from './nativeEngine';

let unsubscribe: (() => void) | null = null;
let unlistenFinalized: UnlistenFn | null = null;
let lastArmedAndPlaying = false;

// Batches finalize events from the workers (1 for combined-only, 3 for
// combined + splits) into a single user-visible toast. ~250ms debounce
// is plenty — workers all finalize within tens of ms of each other,
// well under the gap a human reads as "separate event."
type FinalizedEvent = {
  label: string;
  path: string;
  duration_secs: number;
};
let pendingFinalized: FinalizedEvent[] = [];
let finalizeTimer: number | null = null;

// Tail-aware stop: after the user stops, the recording keeps running (the audio
// thread keeps pushing the live post-master bus while the producer is alive) so
// reverb / delay / FX tails ring out into the file. We just delay the stop
// command until the output goes quiet — watching the `audio:level` event (the
// post-master peak Rust emits at ~30Hz) — then finalize. Mirrors the web
// recorder's silence-detected tail. Caps at TAIL_MAX_MS so a self-sustaining
// delay/feedback drone can't record forever.
const TAIL_SILENCE_PEAK = 0.001; // ~-60 dBFS (matches recorder.ts)
const TAIL_SILENCE_MS = 500; // output must stay quiet this long to finalize
const TAIL_MAX_MS = 15000; // hard cap
// Resolver that ends the in-flight tail wait early (a fresh take supersedes it);
// null when no tail is pending.
let cancelTail: (() => void) | null = null;
// Bumped on every stop/start so a tail wait that's been superseded by a newer
// take knows to bail instead of finalizing the new recording.
let stopGeneration = 0;

function formatDuration(secs: number): string {
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i > 0 ? path.slice(0, i) : path;
}

function flushFinalizedToast(): void {
  const takes = pendingFinalized;
  pendingFinalized = [];
  finalizeTimer = null;
  if (takes.length === 0) return;
  const first = takes[0];
  const duration = formatDuration(first.duration_secs);
  let text: string;
  if (takes.length === 1) {
    text = `recording saved · ${duration}`;
  } else {
    text = `saved ${takes.length} files · ${duration}`;
  }
  // Always reveal the parent dir — user prefers Finder to land on the
  // folder rather than launching the WAV (which would play in QuickLook
  // or open in the system default audio app).
  useSequencerStore.getState().pushToast({
    kind: 'success',
    text,
    revealPath: parentDir(first.path),
  });
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function resolveRecordingsDir(): Promise<string> {
  const configured = getConfiguredRecordingsDir();
  if (configured) return configured;
  // Fall back to the Rust-side default (~/Documents/newspeech-recordings)
  // — same default the web recorder's `recording_start` IPC uses.
  return await invoke<string>('get_recordings_dir');
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}

async function start(): Promise<void> {
  // If a previous take is still ringing out its tail, supersede it and finalize
  // it now — the native recorder is single-take, so the old file must close
  // before we open a new one.
  if (cancelTail) {
    stopGeneration++;
    cancelTail();
    await finalizeRecording();
  }
  try {
    const dir = await resolveRecordingsDir();
    const ts = timestamp();
    // Lead every take with the tempo (e.g. `111bpm_<ts>`) so files sort by
    // session and the bpm reads at a glance. The combined take carries no role
    // suffix; the splits keep `_rhythm` / `_melody`.
    const prefix = `${useSequencerStore.getState().bpm}bpm_${ts}`;
    await startRecordingCombined(joinPath(dir, `${prefix}.wav`));
    if (useSequencerStore.getState().splits) {
      await startRecordingSplits({
        rhythmPath: joinPath(dir, `${prefix}_rhythm.wav`),
        melodyPath: joinPath(dir, `${prefix}_melody.wav`),
      });
    }
  } catch (err) {
    console.warn('[nativeRecorder] start failed:', err);
    // Best-effort disarm so the UI doesn't sit in a stuck "armed" state.
    useSequencerStore.getState().setArmed(false);
  }
}

// Send the actual stop commands (drops the producers → workers drain + finalize).
// Idempotent on the Rust side, so a double-call (e.g. a superseded tail racing a
// fresh take) is harmless.
async function finalizeRecording(): Promise<void> {
  try {
    await stopRecordingCombined();
  } catch (err) {
    console.warn('[nativeRecorder] stop combined failed:', err);
  }
  try {
    await stopRecordingSplits();
  } catch (err) {
    console.warn('[nativeRecorder] stop splits failed:', err);
  }
}

// Resolve once the post-master output has stayed below the silence floor for
// TAIL_SILENCE_MS, or TAIL_MAX_MS elapses, or a fresh take cancels it.
function waitForTail(): Promise<void> {
  return new Promise((resolve) => {
    let silenceStart: number | null = null;
    let unlisten: UnlistenFn | null = null;
    let capTimer: number | null = null;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (cancelTail === finish) cancelTail = null;
      if (unlisten) unlisten();
      if (capTimer !== null) window.clearTimeout(capTimer);
      resolve();
    };
    cancelTail = finish; // let a new take cut the wait short
    capTimer = window.setTimeout(finish, TAIL_MAX_MS);
    void listen<number>('audio:level', (ev) => {
      const now = performance.now();
      if (ev.payload < TAIL_SILENCE_PEAK) {
        if (silenceStart === null) silenceStart = now;
        else if (now - silenceStart >= TAIL_SILENCE_MS) finish();
      } else {
        silenceStart = null;
      }
    }).then((fn) => {
      if (finished) fn(); // already done before the listener attached
      else unlisten = fn;
    });
  });
}

async function stop(): Promise<void> {
  // Disarm immediately so the UI reflects "not recording" (one-arm-per-take);
  // the file keeps capturing the tail in the background until it goes quiet.
  useSequencerStore.getState().setArmed(false);
  const gen = ++stopGeneration;
  await waitForTail();
  // A newer take superseded this stop while we waited — it owns finalize now.
  if (gen !== stopGeneration) return;
  await finalizeRecording();
}

export function subscribeNativeRecorder(): void {
  if (!isNativeAudioAvailable() || unsubscribe) return;
  // Seed last-state from current store so a hot-mount (HMR) doesn't
  // trigger a phantom start/stop.
  const s = useSequencerStore.getState();
  lastArmedAndPlaying = s.armed && s.playing;
  unsubscribe = useSequencerStore.subscribe((state) => {
    const armedAndPlaying = state.armed && state.playing;
    if (armedAndPlaying === lastArmedAndPlaying) return;
    lastArmedAndPlaying = armedAndPlaying;
    if (armedAndPlaying) void start();
    else void stop();
  });
  // Listen for finalize events from the worker threads; batch nearby
  // events (combined + rhythm + melody all finalize within tens of ms
  // of each other) into a single success toast.
  void listen<FinalizedEvent>('recorder:finalized', (ev) => {
    pendingFinalized.push(ev.payload);
    if (finalizeTimer !== null) window.clearTimeout(finalizeTimer);
    finalizeTimer = window.setTimeout(flushFinalizedToast, 250);
  }).then((fn) => {
    unlistenFinalized = fn;
  });
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (unlistenFinalized) {
      unlistenFinalized();
      unlistenFinalized = null;
    }
    if (finalizeTimer !== null) {
      window.clearTimeout(finalizeTimer);
      finalizeTimer = null;
    }
    if (cancelTail) cancelTail();
    pendingFinalized = [];
    lastArmedAndPlaying = false;
  });
}
