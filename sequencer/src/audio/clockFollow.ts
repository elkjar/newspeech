// External MIDI-clock follower (native Sequence app). When syncSource ===
// 'external', the chosen clock-in port's clock drives a tempo-tracking PLL: the
// 24-PPQN stream is smoothed into a BPM that feeds the existing lookahead
// scheduler (via the store), and transport (start/stop) is driven by the master.
// We never advance per-pulse — the scheduler keeps its own sample-accurate clock
// and we slave its *rate* (and later its phase).
//
// Tempo comes from the native `clock-tick` message (see src-tauri/src/midi.rs):
// Rust counts every 0xF8 and emits a throttled tick carrying the cumulative
// pulse COUNT + the hardware timestamp. Deriving BPM from (Δcount / Δmicros)
// is immune to dropped ticks — the count accounts for every elapsed pulse even
// if the IPC channel sheds some — and the hardware timestamp avoids WebView
// receipt jitter. This is native-only by design; the web build is not a target.

import { useSequencerStore } from '../state/store';
import { scheduler } from './scheduler';
import { engineNow } from './engineClock';
import { prepareForPlay, stopPlaybackLocal } from './transport';
import { clockEngineStop, clockTransportStart } from './midiClock';
import type { MidiMessage } from '../midi/midiIn';

// 24 PPQN: a quarter note = 24 clock pulses.
const PPQN = 24;
// EMA on the per-tick BPM estimate. Each tick already measures across several
// pulses, so a modest factor tracks tempo ramps within a beat while trimming
// jitter.
const ALPHA_BPM = 0.2;
// A tick gap longer than this (in microseconds of hardware time) means the
// master stopped between ticks — re-seed rather than read the silence as a slow
// tempo. 500 ms is well past the ~122 ms throttled tick spacing at 120 BPM.
const GAP_US = 500_000;
// Sanity window for a derived BPM before it's trusted — anything outside is
// garbage (counter glitch, first tick after a gap) and is dropped.
const BPM_MIN = 20;
const BPM_MAX = 400;
// Hysteresis deadband (BPM) around the last published integer. The display
// won't flip to an adjacent integer until the raw tracked tempo crosses this
// far past the current value — kills ±1 boundary flicker when the estimate sits
// near a .5 boundary, while real tempo moves (≥~1 BPM) still track.
const BPM_HYSTERESIS = 0.75;

let lastCount: number | null = null;
let lastMicros = 0;
let emaBpm: number | null = null;
let locked = false;
let lastPublishedBpm: number | null = null;
// Phase reference within the beat (0..PPQN-1), from the cumulative count.
// Zeroed on Start. Used by the phase-nudge step.
let pulseCounter = 0;
// Diagnostic: derived pulse rate (pulses/sec) from the last tick delta, so the
// UI can confirm the full ~49/s at 123 BPM is being counted even when ticks
// themselves arrive throttled at ~8/s. lastDCount/lastDMicros expose the raw
// last tick delta for debugging unit/drop issues.
let lastPulseRate = 0;
let lastDCount = 0;
let lastDMicros = 0;

const lockListeners = new Set<(locked: boolean) => void>();

export function onClockLockChange(cb: (locked: boolean) => void): () => void {
  lockListeners.add(cb);
  return () => {
    lockListeners.delete(cb);
  };
}

function setLocked(next: boolean): void {
  if (next === locked) return;
  locked = next;
  // Mirror to the store so the UI indicator is reactive + HMR-proof.
  useSequencerStore.getState().setClockFollowLocked(next);
  for (const cb of lockListeners) cb(locked);
}

export function isClockLocked(): boolean {
  return locked;
}

export function getFollowedBpm(): number | null {
  return locked ? lastPublishedBpm : null;
}

// Current pulse position within the beat (0..PPQN-1). No caller yet — this is
// the deliberate stub for the deferred phase-nudge step (align the scheduler
// grid to the master's beat); it also keeps the pulseCounter tracking live.
export function getClockPhase(): number {
  return pulseCounter;
}

// Derived pulse rate in pulses/sec (~49 at 123 BPM). Distinguishes a counting
// problem (rate wrong) from a tempo-math problem.
export function getClockPulseRate(): number {
  return Math.round(lastPulseRate);
}

// Raw last-tick delta, for diagnosing counter/timestamp issues.
export function getClockDebug(): { dCount: number; dMicros: number } {
  return { dCount: lastDCount, dMicros: lastDMicros };
}

export function resetTracker(): void {
  lastCount = null;
  lastMicros = 0;
  emaBpm = null;
  pulseCounter = 0;
  lastPublishedBpm = null;
  lastPulseRate = 0;
  setLocked(false);
}

function publishBpm(): void {
  if (emaBpm === null) return;
  // Deadband on the RAW estimate vs the last published integer (NOT on the
  // rounded value — rounding first lets a ±1 flip slip through every check).
  if (lastPublishedBpm !== null && Math.abs(emaBpm - lastPublishedBpm) < BPM_HYSTERESIS) {
    return;
  }
  const bpm = Math.round(emaBpm);
  if (bpm === lastPublishedBpm) return;
  lastPublishedBpm = bpm;
  // Route through the store so the existing bpm useEffect fans it out to the
  // scheduler and the BpmInput display stays live. The store clamps 40–240.
  useSequencerStore.getState().setBpm(bpm);
}

// Native clock tick: cumulative pulse count + hardware timestamp (microseconds).
export function feedClockTick(count: number, micros: number): void {
  if (lastCount === null) {
    lastCount = count;
    lastMicros = micros;
    return;
  }
  const dCount = count - lastCount;
  const dMicros = micros - lastMicros;
  // Counter restart / wrap, non-monotonic time, or a long silence → re-seed.
  if (dCount <= 0 || dMicros <= 0 || dMicros > GAP_US) {
    lastCount = count;
    lastMicros = micros;
    emaBpm = null;
    setLocked(false);
    return;
  }
  lastCount = count;
  lastMicros = micros;
  lastDCount = dCount;
  lastDMicros = dMicros;
  pulseCounter = count % PPQN;
  lastPulseRate = (dCount * 1_000_000) / dMicros;

  // pulses/µs = dCount/dMicros → quarter = PPQN pulses → bpm below.
  const bpm = (60_000_000 * dCount) / (PPQN * dMicros);
  if (bpm < BPM_MIN || bpm > BPM_MAX) return;
  emaBpm = emaBpm === null ? bpm : emaBpm + ALPHA_BPM * (bpm - emaBpm);
  if (!locked) setLocked(true);
  publishBpm();
}

// Anchor the downbeat just ahead of now (no count-in — the master defines the
// downbeat). The phase nudge (later step) trims ongoing alignment.
const START_LOOKAHEAD_S = 0.015;

async function startFollowPlayback(): Promise<void> {
  await prepareForPlay();
  scheduler.start(engineNow() + START_LOOKAHEAD_S);
  pulseCounter = 0;
  useSequencerStore.getState().setPlaying(true);
  // Relay: spin up the pulse thread (clockTransportStart ensures it) and
  // re-broadcast clock + Start to the rig (Mutant Brain, Bluebox, …) at the
  // tracked tempo so the whole rig follows the external master through us.
  // clockDestPorts() excludes the clock-in port, so this never echoes back to
  // the master. setClockBpm (App.tsx bpm effect) keeps the relay tempo
  // tracking. Unlike the internal master, the relay stream is bracketed by the
  // master's transport (torn down on Stop) — the master itself stops sending
  // clock when it stops.
  clockTransportStart();
}

// 0xFA Start: launch from the top on the master's downbeat. Redundant Starts
// while already playing are ignored (some masters re-emit Start periodically),
// so they don't stutter the sequence.
export function feedTransportStart(): void {
  pulseCounter = 0;
  if (useSequencerStore.getState().playing) return;
  void startFollowPlayback();
}

export function feedTransportContinue(): void {
  // v1: treat Continue as Start-from-top (no Song Position chase).
  feedTransportStart();
}

// 0xFC Stop: halt playback and tear down the relay (final Stop to the rig).
export function feedTransportStop(): void {
  if (!useSequencerStore.getState().playing) return;
  stopPlaybackLocal();
  clockEngineStop(true);
}

function followGate(port: string): boolean {
  const s = useSequencerStore.getState();
  if (s.syncSource !== 'external') return false;
  if (!s.midiClockInPort) return false; // no port chosen → nothing drives sync
  if (port !== s.midiClockInPort) return false;
  return true;
}

// Native tempo path: throttled, counter-tagged clock ticks from Rust.
export function handleClockTick(msg: Extract<MidiMessage, { msg: 'clock-tick' }>): void {
  if (!followGate(msg.port)) return;
  feedClockTick(msg.count, msg.micros);
}

// Transport path: start/stop/continue arrive as raw realtime bytes on the
// message channel (rare, never throttled). 0xF8 is intercepted in Rust and
// never reaches here.
export function handleClockRealtime(msg: Extract<MidiMessage, { msg: 'realtime' }>): void {
  if (!followGate(msg.port)) return;
  switch (msg.status) {
    case 0xfa:
      feedTransportStart();
      break;
    case 0xfb:
      feedTransportContinue();
      break;
    case 0xfc:
      feedTransportStop();
      break;
  }
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    lockListeners.clear();
    resetTracker();
  });
}
