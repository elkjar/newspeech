// NOISE unit (docs/loop-resample.md §NOISE) — the JS side of
// MixerCommand::NoiseParams/NoiseCapture. Mörser-shaped: clocked digital
// noise into both the audio path and the cutoff CV of a stereo WASP-grit
// filter, with an always-on distortion. Four input routings:
//   0 INS  — true insert: Loop A routes THROUGH the chain (wet-only; the
//            loop's SAVE bounce prints the post-noise signal),
//   1 PAR  — parallel: Loop A feeds the chain but keeps its direct out —
//            send/return instead of insert (SAVE prints loop + noise),
//   2 CAP  — its own retroactive bar-quantized capture (second bed),
//   3 OFF  — no input: the noise source alone through the filter (the
//            Mörser self-sounding trick).
// Session singleton like audio/perform.ts and audio/loops.ts; never
// persisted. Level defaults to 0 — the unit is silent until raised.

import { engineSampleRate, framesNow } from './engineClock';
import {
  GLOBAL_TRACK_ID,
  markManualOverride,
  modulated,
  type LFODestKnobGlobal,
} from './lfo';
import { useSequencerStore } from '../state/store';
import {
  noiseCaptureSpan,
  noiseParamsNative,
  noiseStopNative,
} from './nativeEngine';
import {
  RATE_DIVISIONS,
  RATE_DIVISION_LABELS,
  SPEED_LADDER,
  barAnchor,
  speedFromKnob,
} from './loops';

// Must match LOOP_RING_SECONDS in audio.rs (shared ring).
const RING_SECONDS = 32;

export { RATE_DIVISION_LABELS as NOISE_CLOCK_LABELS };

// Signal-clock crossing dividers (the Spektrum's divider switches, laddered).
export const XING_DIVS = [1, 2, 4, 8, 16, 64];
export const XING_DIV_LABELS = ['/1', '/2', '/4', '/8', '/16', '/64'];
export { SPEED_LADDER as NOISE_SPEED_LADDER };

export type NoiseSource = 0 | 1 | 2 | 3; // insert · parallel · own capture · none

interface NoiseState {
  source: NoiseSource;
  bars: number | null; // own-capture length; null = empty
  speedKnob: number; // SPEED_LADDER position (capture playback)
  drive: number; // 0..1 → 1..24x input gain into the filter
  cutoff: number; // 0..1
  res: number; // 0..1
  width: number; // 0..1 L/R resonance offset
  mode: 0 | 1; // LP · BP
  noise: number; // 0..1 noise into audio
  cv: number; // 0..1 noise into cutoff
  clockSynced: boolean;
  clockDivIdx: number;
  clockHz: number;
  // Clock mode: 0 = timer (sync/free above), 1 = SIGNAL (Spektrum) — ticks
  // from a signal's zero crossings through a divider.
  clockMode: 0 | 1;
  clockSrc: 0 | 1 | 2; // self-input · loop A · mix
  xDivIdx: number; // index into XING_DIVS
  sens: number; // 0..1 crossing hysteresis
  level: number; // 0..1.5 return
  fxSend: number;
  revSend: number;
  delSend: number;
}

const state: NoiseState = {
  source: 0,
  bars: null,
  speedKnob: 11 / 12, // +1x
  drive: 0.25,
  cutoff: 0.6,
  res: 0.4,
  width: 0,
  mode: 0,
  noise: 0.3,
  cv: 0.2,
  clockSynced: false,
  clockDivIdx: 4, // 1/16 when synced
  clockHz: 240, // digital-hash territory by default when free
  clockMode: 0,
  clockSrc: 1, // loop A — the ecosystem patch by default
  xDivIdx: 3, // /8
  sens: 0.2,
  level: 0,
  fxSend: 0,
  revSend: 0,
  delSend: 0,
};

const listeners = new Set<() => void>();
let version = 0;
function notify() {
  version++;
  for (const l of listeners) l();
}

export function subscribeNoise(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function noiseVersion(): number {
  return version;
}

export function noiseValues(): NoiseState {
  return { ...state };
}

// CLOCK knob position (0..1) for the current mode — the space LFOs ride in
// (same convention as the loop RATE knob: modulation steps the ladder the
// knob currently edits, whichever mode that is).
function clockKnobPos(): number {
  if (state.clockMode === 1) return state.xDivIdx / (XING_DIVS.length - 1);
  if (state.clockSynced)
    return state.clockDivIdx / (RATE_DIVISIONS.length - 1);
  return noiseClockKnobFromHz(state.clockHz);
}

function clockFramesFromPos(pos: number): number {
  if (state.clockSynced) {
    const a = barAnchor();
    const bar = a ? a.barFrames : engineSampleRate() * 2;
    const idx = Math.round(pos * (RATE_DIVISIONS.length - 1));
    return bar * RATE_DIVISIONS[idx];
  }
  return engineSampleRate() / noiseClockHzFromKnob(pos);
}

// Effective (LFO-modulated) params. Same rule as the loop unit: every
// routed LFO rides the KNOB space (0..1), so the speed/clock ladders stay
// quantized after modulation. `modulated()` is base-passthrough with
// nothing routed and honours the hand-override ramp.
function effectiveParams() {
  const lfos = useSequencerStore.getState().lfos;
  const m = (base: number, knob: LFODestKnobGlobal) =>
    Math.max(0, Math.min(1, modulated(base, lfos, GLOBAL_TRACK_ID, knob)));
  const clockPos = m(clockKnobPos(), 'noiseClock');
  return {
    source: state.source,
    speed: speedFromKnob(m(state.speedKnob, 'noiseSpeed')),
    drive: m(state.drive, 'noiseDrive'),
    cutoff: m(state.cutoff, 'noiseCutoff'),
    res: m(state.res, 'noiseRes'),
    width: m(state.width, 'noiseWidth'),
    mode: state.mode,
    noise: m(state.noise, 'noiseAmt'),
    cv: m(state.cv, 'noiseCv'),
    clockFrames: clockFramesFromPos(clockPos),
    clockSynced: state.clockSynced,
    clockMode: state.clockMode,
    clockSrc: state.clockSrc,
    clockDiv: XING_DIVS[Math.round(clockPos * (XING_DIVS.length - 1))],
    sens: m(state.sens, 'noiseSens'),
    level: m(state.level / 1.5, 'noiseLevel') * 1.5,
    fxSend: m(state.fxSend, 'noiseFxSend'),
    revSend: m(state.revSend, 'noiseRevSend'),
    delSend: m(state.delSend, 'noiseDelSend'),
  };
}

let lastPushed = '';
function push(force = false) {
  const p = effectiveParams();
  const key = JSON.stringify(p);
  if (!force && key === lastPushed) return;
  lastPushed = key;
  void noiseParamsNative(p);
}

// LFO driver — ~30Hz effective-value push, matching the loop unit's. Runs
// unconditionally (the unit can sound with no capture, and an LFO on LEVEL
// must be able to open a unit sitting at 0); the change gate makes the
// idle cost a stringify + compare. Also keeps a bar-synced clock honest
// across tempo changes (clockFrames re-derives from the live bar anchor).
setInterval(() => push(), 33);

export function setNoiseSource(source: NoiseSource) {
  if (source === state.source) return;
  state.source = source;
  notify();
  push();
}

export function setNoiseMode(mode: 0 | 1) {
  if (mode === state.mode) return;
  state.mode = mode;
  notify();
  push();
}

const PARAM_LFO_KNOB: Partial<Record<string, LFODestKnobGlobal>> = {
  speedKnob: 'noiseSpeed',
  drive: 'noiseDrive',
  cutoff: 'noiseCutoff',
  res: 'noiseRes',
  width: 'noiseWidth',
  noise: 'noiseAmt',
  cv: 'noiseCv',
  sens: 'noiseSens',
  fxSend: 'noiseFxSend',
  revSend: 'noiseRevSend',
  delSend: 'noiseDelSend',
};

export function setNoiseParam(
  key:
    | 'speedKnob'
    | 'drive'
    | 'cutoff'
    | 'res'
    | 'width'
    | 'noise'
    | 'cv'
    | 'sens'
    | 'fxSend'
    | 'revSend'
    | 'delSend',
  value: number,
) {
  const v = Math.max(0, Math.min(1, value));
  if (v === state[key]) return;
  state[key] = v;
  const lfoKnob = PARAM_LFO_KNOB[key];
  if (lfoKnob) markManualOverride(GLOBAL_TRACK_ID, lfoKnob);
  notify();
  push();
}

export function setNoiseLevel(gain: number) {
  const g = Math.max(0, Math.min(1.5, gain));
  if (g === state.level) return;
  state.level = g;
  markManualOverride(GLOBAL_TRACK_ID, 'noiseLevel');
  notify();
  push();
}

export function setNoiseClockDiv(idx: number) {
  const i = Math.max(0, Math.min(RATE_DIVISIONS.length - 1, Math.round(idx)));
  if (i === state.clockDivIdx) return;
  state.clockDivIdx = i;
  markManualOverride(GLOBAL_TRACK_ID, 'noiseClock');
  notify();
  push();
}

export function setNoiseClockHz(hz: number) {
  const r = Math.max(0.5, Math.min(8000, hz));
  if (r === state.clockHz) return;
  state.clockHz = r;
  markManualOverride(GLOBAL_TRACK_ID, 'noiseClock');
  notify();
  push();
}

// The clock selector is one flat five-way column (no blind cycle, no
// revealed sub-group): sync · free are the timer modes; self · loop · mix
// are the SIGNAL mode (Spektrum crossings) with its source folded in —
// every state is one press from anywhere.
export function setNoiseClockMode(mode: 'sync' | 'free') {
  const synced = mode === 'sync';
  if (state.clockMode === 0 && state.clockSynced === synced) return;
  state.clockMode = 0;
  state.clockSynced = synced;
  notify();
  push();
}

// Selecting a signal source IS selecting signal mode.
export function setNoiseClockSrc(src: 0 | 1 | 2) {
  if (state.clockMode === 1 && src === state.clockSrc) return;
  state.clockMode = 1;
  state.clockSrc = src;
  notify();
  push();
}

export function setNoiseXDiv(idx: number) {
  const i = Math.max(0, Math.min(XING_DIVS.length - 1, Math.round(idx)));
  if (i === state.xDivIdx) return;
  state.xDivIdx = i;
  markManualOverride(GLOBAL_TRACK_ID, 'noiseClock');
  notify();
  push();
}

// Free clock reaches AUDIO RATE (0.5Hz..8kHz exp) — at audio-rate clocks
// the LFSR is pitched digital hash, the Mörser noise color range.
export function noiseClockHzFromKnob(knob: number): number {
  return 0.5 * Math.pow(16000, Math.max(0, Math.min(1, knob)));
}

export function noiseClockKnobFromHz(hz: number): number {
  return Math.log(Math.max(0.5, hz) / 0.5) / Math.log(16000);
}

// Capture the last `bars` bars of the mix into the NOISE unit's own buffer
// (used by source = CAP). Same retroactive bar math as the loop unit.
export function noiseCaptureBars(bars: number): boolean {
  const a = barAnchor();
  if (!a) return false;
  const now = framesNow();
  let end = a.frame;
  while (end > now) end -= a.barFrames;
  const len = Math.round(bars * a.barFrames);
  const start = end - len;
  const oldest = now - (RING_SECONDS - 1) * engineSampleRate();
  if (start < 0 || start < oldest) return false;
  void noiseCaptureSpan(Math.round(start), Math.round(end));
  // Force a re-sync on every capture — same reasoning as the loop unit
  // (webview reload resets JS state while the engine remembers).
  push(true);
  state.bars = bars;
  notify();
  return true;
}

export function noiseStop() {
  if (state.bars === null) return;
  state.bars = null;
  notify();
  void noiseStopNative();
}

// Panic silences the unit engine-side (level → 0 there); mirror it.
export function noiseOnPanic() {
  if (state.level === 0 && state.bars === null) return;
  state.level = 0;
  state.bars = null;
  notify();
}

// Dev: engine-consumer module — force a full reload on change (matches
// perform.ts / loops.ts).
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
