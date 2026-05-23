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
  try {
    const dir = await resolveRecordingsDir();
    const ts = timestamp();
    await startRecordingCombined(joinPath(dir, `combined_${ts}.wav`));
    if (useSequencerStore.getState().splits) {
      await startRecordingSplits({
        rhythmPath: joinPath(dir, `rhythm_${ts}.wav`),
        melodyPath: joinPath(dir, `melody_${ts}.wav`),
      });
    }
  } catch (err) {
    console.warn('[nativeRecorder] start failed:', err);
    // Best-effort disarm so the UI doesn't sit in a stuck "armed" state.
    useSequencerStore.getState().setArmed(false);
  }
}

async function stop(): Promise<void> {
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
  // Auto-disarm after stop, matching the web recorder's one-arm-per-take
  // convention.
  useSequencerStore.getState().setArmed(false);
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
    pendingFinalized = [];
    lastArmedAndPlaying = false;
  });
}
