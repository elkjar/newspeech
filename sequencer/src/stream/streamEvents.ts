import { emit, listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';

// Cross-window event channel for the stream view. Main window emits;
// stream window subscribes. Tauri events go through the Rust backend and
// fan out to every webview, so this works around the fact that each window
// has its own zustand store (separate JS context per WKWebView).
//
// Events are batched per scheduler tick to keep IPC traffic at scheduler
// rate (~16Hz at 120bpm), not per-trigger rate (~50Hz with multiple voices
// firing per tick).

// Mirror of state/store SceneShape — kept inline to avoid a circular
// store↔streamEvents import (store.ts imports emitStreamEvent from here).
export type StreamShape = 'sustain' | 'build' | 'arc' | 'wave' | 'decay';

export interface BankSummary {
  kind: 'normal' | 'transition';
  entropy: number;
}

export interface EntropyBreakdown {
  total: number;
  channels: number;
  voiceType: number;
  stepDensity: number;
  mutation: number;
  polyphony: number;
}

// Ghost-pick entry kinds — mirrors GhostPickLogEntry in store.ts so Pool
// can react to specifically pattern swaps without pattern-matching label
// strings.
export type GhostKind =
  | 'auto'
  | 'manual'
  | 'shape'
  | 'ghost'
  | 'transport'
  | 'system'
  | 'step'
  | 'scene';

export type StreamEvent =
  // Step trigger — fired per sample-trigger event in the dispatcher.
  // Visualizer uses these to spawn flares on every audible hit. Datafeed
  // intentionally ignores them (audience reads steps off the visualizer,
  // not the log).
  | { kind: 'step'; voice: string; velocity: number }
  // Performer interactions — knob turns, pattern toggles, ghost decisions.
  | { kind: 'ghost'; label: string; subkind: GhostKind }
  | { kind: 'param'; label: string }
  | { kind: 'mutate'; label: string }
  | { kind: 'lfo'; label: string }
  // Visualizer-driven events — pool advance, source-mode change, etc.
  | { kind: 'visual'; label: string }
  // Periodic state snapshot (10Hz). Carries macros + the full ghost
  // surface needed by the Datafeed overlays (entropy histogram, shape
  // preview, phase + target metrics) and the Visualizer (procedural
  // params). One payload so consumers can re-render coherently.
  | {
      kind: 'state';
      // macros
      density: number;
      chaos: number;
      motion: number;
      drift: number;
      tension: number;
      // ghost — top-level
      activeBank: number | null;
      pendingBank: number | null;
      shape: StreamShape;
      phaseLength: number;
      phase: number;
      targetEntropy: number;
      ghostEnabled: boolean;
      bankOrderMode: 'sequence' | 'entropy';
      elapsedBars: number;
      minE: number;
      maxE: number;
      // ghost — 16-slot summary (entropy per filled slot, null = empty)
      bankSummary: Array<BankSummary | null>;
      // ghost — breakdown of the active bank (null if none active)
      activeBreakdown: EntropyBreakdown | null;
    }
  | { kind: 'divider'; label: string };

interface StreamBatch {
  events: StreamEvent[];
}

const CHANNEL = 'stream:batch';
const PRESENCE_CHANNEL = 'stream:presence';
const PRESENCE_PING_CHANNEL = 'stream:presence-ping';

// Presence gate. The audio dispatcher fires emitStreamEvents on every
// scheduler step, and a 10Hz interval fires state snapshots — both end up
// inside the audio scheduling hot path. When no stream window is mounted,
// each emit() still does payload-serialize + Rust IPC, adding jitter to
// the MIDI→sample dispatch ordering. Gate emits on a flag flipped by
// presence pings from the stream window.
let listenerActive = false;
let presenceSubscribed = false;

export function isStreamListenerActive(): boolean {
  return listenerActive;
}

// Main-window setup: listen for ready/bye from the stream window and
// request presence so a stream window that mounted before us re-announces.
// Idempotent — safe to call from any boot path.
export async function initStreamPresenceMain(): Promise<() => void> {
  if (!isTauri() || presenceSubscribed) return () => {};
  presenceSubscribed = true;
  const unlisten = await listen<'ready' | 'bye'>(PRESENCE_CHANNEL, (e) => {
    listenerActive = e.payload === 'ready';
  });
  // Ask any already-mounted stream window to re-announce. Race: if the
  // stream window mounted before we attached our listener, we missed its
  // initial 'ready'. The window listens for ping and re-emits ready.
  void emit(PRESENCE_PING_CHANNEL, null);
  return () => {
    presenceSubscribed = false;
    listenerActive = false;
    unlisten();
  };
}

// Stream-window setup: announce presence + respond to pings + emit bye on
// teardown. Mirrors initStreamPresenceMain — idempotent under HMR.
export async function announceStreamPresence(): Promise<() => void> {
  if (!isTauri()) return () => {};
  void emit(PRESENCE_CHANNEL, 'ready');
  const unlistenPing = await listen<null>(PRESENCE_PING_CHANNEL, () => {
    void emit(PRESENCE_CHANNEL, 'ready');
  });
  const onUnload = () => {
    void emit(PRESENCE_CHANNEL, 'bye');
  };
  window.addEventListener('beforeunload', onUnload);
  return () => {
    onUnload();
    window.removeEventListener('beforeunload', onUnload);
    unlistenPing();
  };
}

export function emitStreamEvents(events: StreamEvent[]): void {
  if (!isTauri() || events.length === 0 || !listenerActive) return;
  // Fire-and-forget — awaiting would block the audio dispatcher.
  void emit(CHANNEL, { events });
}

export function emitStreamEvent(event: StreamEvent): void {
  emitStreamEvents([event]);
}

export async function subscribeStreamEvents(
  cb: (events: StreamEvent[]) => void
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const unlisten = await listen<StreamBatch>(CHANNEL, (e) => {
    cb(e.payload.events);
  });
  return unlisten;
}
