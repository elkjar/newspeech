// Loop/resample capture unit (P1, docs/loop-resample.md) — the JS side of
// MixerCommand::LoopCapture. The audio thread keeps a 32s post-master ring;
// this module owns the bar math (which absolute frame span to grab) and the
// UI-facing unit state. Same session-singleton shape as audio/perform.ts:
// captures are performance state, never persisted; saving a loop to the
// library (P4) is the permanence story.
//
// Capture is RETROACTIVE and bar-quantized: "capture 4 bars" grabs the four
// bars you just heard, ending at the most recent bar boundary that has
// actually been rendered. Playback is phase-locked to that boundary
// ((frame - end) % len on the audio thread), so the punch is seamless — the
// loop continues the mix in bar phase and only becomes audible as a distinct
// layer when the pattern changes underneath it.

import { engineSampleRate, framesNow } from './engineClock';
import {
  GLOBAL_TRACK_ID,
  markManualOverride,
  modulated,
  type LFODestKnobGlobal,
} from './lfo';
import { useSequencerStore } from '../state/store';
import {
  loopBounceNative,
  loopCaptureSpan,
  loopGainNative,
  loopParamsNative,
  loopStopNative,
} from './nativeEngine';

// Must match LOOP_RING_SECONDS in audio.rs.
const RING_SECONDS = 32;

// Most recent DISPATCHED bar boundary, in absolute engine frames, plus the
// bar length in frames at the tempo it was dispatched. Fed by the App
// dispatcher at every bar commit. Dispatched boundaries run up to the
// ~250ms scheduling horizon AHEAD of the ear — captureBars walks back to
// the newest boundary that has actually been rendered.
let lastBarFrame: number | null = null;
let barFrames = 0;

export function noteBarBoundary(frame: number, frames: number) {
  lastBarFrame = frame;
  barFrames = frames;
}

interface LoopState {
  // Captured length in bars; null = unit empty/stopped.
  bars: number | null;
  gain: number;
  // P2 manipulation params (Morphagene/ADDAC flavor). speedKnob is the UI
  // 0..1 position of the thru-zero vari-speed knob, quantized to the
  // octave ladder (see SPEED_LADDER — musically coherent: pitch stays in
  // octaves AND the loop stays bar-phase-related to the grid); size 1 =
  // whole-loop tape mode; scan/spray 0..1; grains = concurrent voices
  // 1..8; rateHz = grain spawn rate. STICKY across captures (recapturing
  // under a mangled setting keeps the mangle) but session-only.
  speedKnob: number;
  // PITCH knob position (same octave ladder; center = FOLLOW speed —
  // tape-chained. A fixed pitch under a slow playhead = timestretch).
  pitchKnob: number;
  // Pitch-lock for the tape layer: OLA stretcher reads at native pitch
  // from the vari-speed playhead — SPEED becomes pure time for the loop.
  loopLock: boolean;
  // Independent layer return levels (0..1.5) — the tape loop and the
  // grain cloud are two modules over the same capture, each with its own
  // output. Both up = both heard.
  loopLevel: number;
  grainLevel: number;
  size: number;
  random: number;
  grains: number;
  // Grain spawn timing: clocked (divisions of the bar, spawns anchored ON
  // the grid) vs free (continuous Hz). The toggle picks which the RATE
  // knob edits; both values persist so flipping back restores.
  rateSynced: boolean;
  rateDivIdx: number; // index into RATE_DIVISIONS
  rateHz: number;
  // Per-control deviations (ADDAC 112): each grain rolls its own value
  // within ±dev of the base. `random` is position's deviation; these
  // cover size (grain-length octaves), pitch (octaves around the ladder
  // value), and spawn-timing jitter.
  sizeDev: number;
  pitchDev: number;
  rateDev: number;
}

const state: LoopState = {
  bars: null,
  gain: 0.8,
  speedKnob: 11 / 12, // = +1x (SPEED_LADDER index 11)
  pitchKnob: 0.5, // = follow (ladder center)
  loopLock: false,
  loopLevel: 1,
  grainLevel: 0, // grains silent until you bring their level up
  size: 0.35, // ≈100ms grains

  random: 0,
  grains: 4,
  rateSynced: true,
  rateDivIdx: 4, // 1/16
  rateHz: 8,
  sizeDev: 0,
  pitchDev: 0,
  rateDev: 0,
};

// Thru-zero vari-speed ladder — octave ratios only (Chris's call): pitch
// stays musical and the loop stays bar-coherent (a 1/2x pass = exactly two
// bars). Reworked deep + slow (also his call): down to 1/16x each way —
// with LOCK on that's a 16x timestretch — capped at 2x up. Center = stop.
export const SPEED_LADDER = [
  -2, -1, -1 / 2, -1 / 4, -1 / 8, -1 / 16, 0, 1 / 16, 1 / 8, 1 / 4, 1 / 2, 1,
  2,
];

// Grain-pitch ladder keeps the wider ±4x range (speed's rework was about
// stretch depth, not grain register). Center = FOLLOW sentinel.
export const PITCH_LADDER = [-4, -2, -1, -0.5, -0.25, 0, 0.25, 0.5, 1, 2, 4];

export function speedFromKnob(knob: number): number {
  const idx = Math.round(Math.max(0, Math.min(1, knob)) * (SPEED_LADDER.length - 1));
  return SPEED_LADDER[idx];
}

export function pitchFromKnob(knob: number): number {
  const idx = Math.round(Math.max(0, Math.min(1, knob)) * (PITCH_LADDER.length - 1));
  return PITCH_LADDER[idx];
}

// Grain duration in seconds for a size-knob value (matches the Rust map —
// full range now; mix owns the tape↔grain balance).
export function grainSecsFromSize(size: number): number {
  const t = Math.max(0, Math.min(1, size));
  return 0.02 * Math.pow(90, t);
}

// Grain spawn rate: exponential 0.5..60 Hz over the knob (free mode).
export function rateHzFromKnob(knob: number): number {
  return 0.5 * Math.pow(120, Math.max(0, Math.min(1, knob)));
}

// Clocked spawn divisions — fractions of a bar (4/4: 1/4 = a beat).
export const RATE_DIVISIONS = [1, 1 / 2, 1 / 4, 1 / 8, 1 / 16, 1 / 32];
export const RATE_DIVISION_LABELS = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32'];

// RATE knob position (0..1) for the current mode — the space LFOs ride in.
function rateKnobPos(): number {
  return state.rateSynced
    ? state.rateDivIdx / (RATE_DIVISIONS.length - 1)
    : Math.log(state.rateHz / 0.5) / Math.log(120);
}

function spawnFramesFromPos(pos: number): number {
  if (state.rateSynced) {
    const bar = barFrames > 0 ? barFrames : engineSampleRate() * 2;
    const idx = Math.round(pos * (RATE_DIVISIONS.length - 1));
    return bar * RATE_DIVISIONS[idx];
  }
  return engineSampleRate() / rateHzFromKnob(pos);
}

// Effective (LFO-modulated) params. Every routed LFO rides the KNOB space
// (0..1 position), so speed/pitch stay LADDER-QUANTIZED after modulation —
// an LFO on speed steps through octaves instead of smearing (the harmonic-
// coherence rule survives modulation). `modulated()` returns the base when
// nothing is routed and honours the hand-override ramp.
function effectiveParams() {
  const lfos = useSequencerStore.getState().lfos;
  const m = (base: number, knob: LFODestKnobGlobal) =>
    Math.max(0, Math.min(1, modulated(base, lfos, GLOBAL_TRACK_ID, knob)));
  return {
    speed: speedFromKnob(m(state.speedKnob, 'loopSpeed')),
    // Ladder center (0) doubles as the FOLLOW sentinel engine-side.
    pitch: pitchFromKnob(m(state.pitchKnob, 'loopPitch')),
    loopLock: state.loopLock,
    loopLevel: m(state.loopLevel / 1.5, 'loopLevel') * 1.5,
    grainLevel: m(state.grainLevel / 1.5, 'loopGrainLevel') * 1.5,
    size: m(state.size, 'loopSize'),
    random: m(state.random, 'loopRandom'),
    grains: Math.round(state.grains),
    spawnFrames: spawnFramesFromPos(m(rateKnobPos(), 'loopRate')),
    rateSynced: state.rateSynced,
    sizeDev: state.sizeDev,
    pitchDev: state.pitchDev,
    rateDev: state.rateDev,
  };
}

let lastPushed = '';
function pushParams(force = false) {
  const p = effectiveParams();
  const key = JSON.stringify(p);
  if (!force && key === lastPushed) return;
  lastPushed = key;
  void loopParamsNative(p);
}

// LFO driver — ~30Hz effective-value push while a loop is held. modulated()
// is base-passthrough with nothing routed and the change gate skips
// no-op pushes, so the idle cost is a few comparisons.
setInterval(() => {
  if (state.bars !== null) pushParams();
}, 33);

const listeners = new Set<() => void>();
let version = 0;
function notify() {
  version++;
  for (const l of listeners) l();
}

export function subscribeLoops(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function loopsVersion(): number {
  return version;
}

export function loopBars(): number | null {
  return state.bars;
}

export function loopGainValue(): number {
  return state.gain;
}

// Capture the last `bars` bars of the mix. Returns false when the span
// isn't available yet — transport hasn't run long enough, no bar boundary
// seen, or the span outruns the ring (very slow tempo × long capture).
export function captureBars(bars: number): boolean {
  if (lastBarFrame === null || barFrames <= 0) return false;
  const now = framesNow();
  // Newest bar boundary that has actually been rendered.
  let end = lastBarFrame;
  while (end > now) end -= barFrames;
  const len = Math.round(bars * barFrames);
  const start = end - len;
  // Span must live entirely inside the ring (1s safety margin for the
  // write head).
  const oldest = now - (RING_SECONDS - 1) * engineSampleRate();
  if (start < 0 || start < oldest) return false;
  void loopCaptureSpan(Math.round(start), Math.round(end));
  // Re-sync params on every capture — Rust keeps its own sticky copy, but
  // a webview reload resets JS state while the engine remembers; capture
  // is the natural re-sync point.
  pushParams(true);
  void loopGainNative(state.gain);
  state.bars = bars;
  notify();
  return true;
}

export function stopLoop() {
  if (state.bars === null) return;
  state.bars = null;
  notify();
  void loopStopNative();
}

export function setLoopGain(gain: number) {
  const g = Math.max(0, Math.min(1.5, gain));
  if (g === state.gain) return;
  state.gain = g;
  notify();
  void loopGainNative(g);
}

export function loopParamValues(): {
  speedKnob: number;
  pitchKnob: number;
  loopLock: boolean;
  loopLevel: number;
  grainLevel: number;
  size: number;
  random: number;
  grains: number;
  rateSynced: boolean;
  rateDivIdx: number;
  rateHz: number;
  sizeDev: number;
  pitchDev: number;
  rateDev: number;
} {
  return {
    speedKnob: state.speedKnob,
    pitchKnob: state.pitchKnob,
    loopLock: state.loopLock,
    loopLevel: state.loopLevel,
    grainLevel: state.grainLevel,
    size: state.size,
    random: state.random,
    grains: state.grains,
    rateSynced: state.rateSynced,
    rateDivIdx: state.rateDivIdx,
    rateHz: state.rateHz,
    sizeDev: state.sizeDev,
    pitchDev: state.pitchDev,
    rateDev: state.rateDev,
  };
}

const PARAM_LFO_KNOB: Partial<Record<string, LFODestKnobGlobal>> = {
  speedKnob: 'loopSpeed',
  pitchKnob: 'loopPitch',
  size: 'loopSize',
  random: 'loopRandom',
};

export function setLoopParam(
  key:
    | 'speedKnob'
    | 'pitchKnob'
    | 'size'
    | 'random'
    | 'sizeDev'
    | 'pitchDev'
    | 'rateDev',
  value: number,
) {
  const v = Math.max(0, Math.min(1, value));
  if (v === state[key]) return;
  state[key] = v;
  const lfoKnob = PARAM_LFO_KNOB[key];
  if (lfoKnob) markManualOverride(GLOBAL_TRACK_ID, lfoKnob);
  notify();
  pushParams();
}

// Layer return levels get their own setter — they range 0..1.5, unlike
// the 0..1 knob params.
export function toggleLoopLock() {
  state.loopLock = !state.loopLock;
  notify();
  pushParams();
}

export function setLoopLayerLevel(layer: 'loop' | 'grain', gain: number) {
  const g = Math.max(0, Math.min(1.5, gain));
  const key = layer === 'loop' ? 'loopLevel' : 'grainLevel';
  if (g === state[key]) return;
  state[key] = g;
  markManualOverride(
    GLOBAL_TRACK_ID,
    layer === 'loop' ? 'loopLevel' : 'loopGrainLevel',
  );
  notify();
  pushParams();
}

export function setLoopGrains(count: number) {
  const c = Math.max(1, Math.min(8, Math.round(count)));
  if (c === state.grains) return;
  state.grains = c;
  notify();
  pushParams();
}

export function setLoopRateHz(hz: number) {
  const r = Math.max(0.5, Math.min(60, hz));
  if (r === state.rateHz) return;
  state.rateHz = r;
  markManualOverride(GLOBAL_TRACK_ID, 'loopRate');
  notify();
  pushParams();
}

export function setLoopRateDiv(idx: number) {
  const i = Math.max(0, Math.min(RATE_DIVISIONS.length - 1, Math.round(idx)));
  if (i === state.rateDivIdx) return;
  state.rateDivIdx = i;
  markManualOverride(GLOBAL_TRACK_ID, 'loopRate');
  notify();
  pushParams();
}

export function toggleLoopRateSynced() {
  state.rateSynced = !state.rateSynced;
  notify();
  pushParams();
}

// Loop length in frames for the current capture (for the grain-width
// overlay). null when nothing is held or the bar anchor is unknown.
export function loopLenFrames(): number | null {
  if (state.bars === null || barFrames <= 0) return null;
  return state.bars * barFrames;
}

// --- save-to-library bounce (P4) --------------------------------------
// SAVE renders what you HEAR: the unit's post-mangle output, bounced for
// exactly the loop length starting at the next bar boundary, so the WAV
// re-loops cleanly and lands in the samples library as a voice. With
// neutral knobs this equals the raw capture — one button covers both.

let saving = false;
let bounceListenerInstalled = false;

export function loopSaving(): boolean {
  return saving;
}

async function installBounceListener() {
  if (bounceListenerInstalled) return;
  bounceListenerInstalled = true;
  const { listen } = await import('@tauri-apps/api/event');
  await listen<{ label: string; path: string; duration_secs: number }>(
    'recorder:finalized',
    (ev) => {
      if (ev.payload.label !== 'loop') return;
      saving = false;
      notify();
      const path = ev.payload.path;
      const dir = path.slice(0, Math.max(0, path.lastIndexOf('/')));
      void import('../state/store').then(({ useSequencerStore }) => {
        useSequencerStore.getState().pushToast({
          kind: 'success',
          text: 'loop saved to library',
          revealPath: dir,
        });
      });
      // Rescan so the new WAV registers as a voice immediately.
      void import('../instruments/userSamplesDir').then((m) =>
        m.scanAndLoadUserSamples(),
      );
    },
  );
}

// Bounce the held loop to `<samples dir>/loops/<bpm>bpm-<bars>bar-<stamp>
// .wav`. BPM derives from the CAPTURED bar length (the material's actual
// tempo, even if the clock moved since). Resolves false when nothing is
// held or a save is already running.
export async function saveLoop(): Promise<boolean> {
  if (state.bars === null || saving || barFrames <= 0) return false;
  await installBounceListener();
  const { getConfiguredUserSamplesDir } = await import(
    '../instruments/userSamplesDir'
  );
  let dir = getConfiguredUserSamplesDir();
  if (!dir) {
    const { invoke } = await import('@tauri-apps/api/core');
    dir = await invoke<string>('get_user_samples_dir');
  }
  const bpm = Math.round((240 * engineSampleRate()) / barFrames);
  // Save one full MUSICAL PASS at the current speed (Chris's catch): a
  // 1/16x stretch of 1 bar takes 16 bars to unfold — the file is the
  // whole pass, and it re-loops cleanly at any octave-ladder speed. At
  // stop there's no pass period; fall back to the source length (a
  // frozen drone loops at any length). Filename bars = the PRINTED
  // musical length, not the source's.
  const mag = Math.abs(speedFromKnob(state.speedKnob));
  const passBars = mag > 0.001 ? state.bars / mag : state.bars;
  const barsLabel = Number.isInteger(passBars)
    ? `${passBars}`
    : passBars.toFixed(1);
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 12);
  const path = `${dir}/loops/loop-${bpm}bpm-${barsLabel}bar-${stamp}.wav`;
  saving = true;
  notify();
  try {
    await loopBounceNative(
      path,
      Math.round(passBars * barFrames),
      Math.round(barFrames),
    );
  } catch (err) {
    console.warn('[loops] bounce failed:', err);
    saving = false;
    notify();
    return false;
  }
  return true;
}

// Rust drops the loop on Panic and on a stream reopen (unit state is
// callback-local) — mirror it so the UI never shows a ghost loop.
export function loopsOnPanic() {
  if (state.bars === null) return;
  state.bars = null;
  notify();
}

// Dev: the dispatcher captures noteBarBoundary at mount — force a full
// reload on change, matching perform.ts / engine/tick.ts.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
