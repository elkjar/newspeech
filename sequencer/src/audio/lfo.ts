import { getAudioContext } from './audioContext';

export type LFODestKnobTrack =
  | 'mutation'
  | 'rowRatchet'
  | 'fxSend'
  | 'pan'
  | 'gain'
  | 'filterCutoff'
  | 'filterResonance';
export type LFODestKnobGlobal =
  | 'density' | 'motion' | 'drift' | 'chaos' | 'tension' | 'voicing'
  | 'tapePosition' | 'tapeLength' | 'tapeMix' | 'tapeGrainRate' | 'tapeGrainMix'
  | 'glitchChance' | 'glitchMix'
  | 'reverbSize' | 'reverbMix' | 'reverbDiffusion' | 'reverbDamping'
  | 'preSaturationDrive'
  | 'masterInput' | 'masterComp' | 'masterDrive' | 'masterBias' | 'masterMix' | 'masterHiCut' | 'masterTrim' | 'masterGateThreshold';
// Per-instrument editor knobs the global LFO can reach (keyed by the focused
// track's id at bind time). Distinct from LFODestKnobTrack because these live on
// the voice (voiceEdits), not on TrackData — so they're applied at trigger time
// in the sample chokepoint rather than read off the track record.
// Per-instrument editor knobs the global LFO can reach (keyed by the focused
// track's id at bind time). These live on the voice (voiceEdits), not on
// TrackData, so TrackKnob doesn't render them. grain* drift is applied JS-side
// at trigger (samplePlayer); the sends are pushed to Rust per-track from the
// track's active voice and modulated continuously there (trackReverbSend /
// trackDelaySend), exactly like fxSend.
export type LFODestKnobInstrument =
  | 'grainLength'
  | 'grainPosition'
  | 'reverbSend'
  | 'delaySend'
  // Continuous pitch drift around the static tune/finetune. Modulated in Rust
  // per-track (trackTune / trackFineTune) and applied to the voice rate, so it
  // sweeps through held notes — distinct from the automation page's per-voice
  // pitch LFO.
  | 'tune'
  | 'finetune';
export type LFODestKnob =
  | LFODestKnobTrack
  | LFODestKnobGlobal
  | LFODestKnobInstrument;

// Sentinel trackId used in LFODestination when the destination is a global
// macro rather than a per-track knob. Lets the same routing list cover both.
export const GLOBAL_TRACK_ID = '__global__';

export interface LFODestination {
  trackId: string;
  knob: LFODestKnob;
}

export type LFOShape = 'sine' | 'triangle' | 'saw' | 'square';
export const LFO_SHAPES: LFOShape[] = ['sine', 'triangle', 'saw', 'square'];

export interface LFO {
  id: number;
  rate: number;
  depth: number;
  destinations: LFODestination[];
  shape: LFOShape;
}

// Bipolar [-1,1] value for a shape at `cycles` (= rate * time, unwrapped).
// Triangle/square are phase-aligned to sine (peak at quarter-cycle); saw ramps
// −1→1 across the cycle.
export function lfoShapeValue(shape: LFOShape, cycles: number): number {
  const p = cycles - Math.floor(cycles); // [0,1)
  switch (shape) {
    case 'triangle':
      return (2 / Math.PI) * Math.asin(Math.sin(2 * Math.PI * p));
    case 'saw':
      return 2 * p - 1;
    case 'square':
      return p < 0.5 ? 1 : -1;
    case 'sine':
    default:
      return Math.sin(2 * Math.PI * p);
  }
}

// 8 OCHD-style detuned slow rates (Hz). Slowest ~120s/cycle, fastest ~7s/cycle.
// Each ~1.5× the previous so adjacent channels drift in and out of phase.
export const LFO_RATES: number[] = [
  0.0083, 0.0125, 0.0188, 0.0278, 0.0417, 0.0625, 0.0938, 0.143,
];

export const LFO_COUNT = LFO_RATES.length;

export function defaultLFOs(): LFO[] {
  return LFO_RATES.map((rate, id) => ({
    id,
    rate,
    depth: 0,
    destinations: [],
    shape: 'sine' as LFOShape,
  }));
}

export function lfoOutput(lfo: LFO, time?: number): number {
  const t = time ?? getAudioContext().currentTime;
  return lfoShapeValue(lfo.shape, lfo.rate * t);
}

// Freeze snapshot: when set, modulated() and useLFOValue read these stable
// bipolar outputs instead of advancing phase. Map key = lfo.id.
let frozenLFOOutputs: Map<number, number> | null = null;

export function freezeLFOs(lfos: LFO[], time?: number): void {
  const t = time ?? getAudioContext().currentTime;
  const snap = new Map<number, number>();
  for (const l of lfos) {
    snap.set(l.id, lfoShapeValue(l.shape, l.rate * t));
  }
  frozenLFOOutputs = snap;
}

export function unfreezeLFOs(): void {
  frozenLFOOutputs = null;
}

export function isLFOFrozen(): boolean {
  return frozenLFOOutputs !== null;
}

export function getFrozenLFOOutput(lfoId: number): number {
  return frozenLFOOutputs?.get(lfoId) ?? 0;
}

// Apply a bipolar LFO output (-1..1) at the given depth on top of base, keeping
// the swing window inside [0, 1]. When base sits near 0 or 1 the window slides
// inward so the dial keeps moving continuously instead of pinning at the edge.
export function applyLFO(base: number, depth: number, out: number): number {
  if (depth === 0) return base;
  let lo = base - depth;
  let hi = base + depth;
  if (lo < 0) {
    hi -= lo;
    lo = 0;
  }
  if (hi > 1) {
    lo -= hi - 1;
    hi = 1;
  }
  lo = Math.max(0, lo);
  hi = Math.min(1, hi);
  const center = (lo + hi) / 2;
  const half = (hi - lo) / 2;
  return center + out * half;
}

export function findRouted(
  lfos: LFO[],
  trackId: string,
  knob: LFODestKnob
): LFO[] {
  return lfos.filter((l) =>
    l.destinations.some((d) => d.trackId === trackId && d.knob === knob)
  );
}

// Manual override (2026-05-29): when a hand touches a control that's bound to
// an LFO — via the XL3, the on-screen knobs, or MIDI (all route through the
// individual store setters, which call markManualOverride) — the LFO YIELDS so
// the hand has direct control. The control then holds for OVERRIDE_HOLD_S after
// the last touch, after which the LFO depth ramps back in over OVERRIDE_RAMP_S
// so it resumes without snapping. Keyed by trackId:knob. This is what lets the
// XL3 "always do whatever it wants" with an LFO-bound control.
const OVERRIDE_HOLD_S = 2;
const OVERRIDE_RAMP_S = 1.5;
const manualOverrides = new Map<string, number>(); // "trackId:knob" -> ctx time the hold ends

function overrideKey(trackId: string, knob: LFODestKnob): string {
  return `${trackId}:${knob}`;
}

/** Call when a hand moves a control — re-arms the LFO override hold. */
export function markManualOverride(trackId: string, knob: LFODestKnob): void {
  manualOverrides.set(
    overrideKey(trackId, knob),
    getAudioContext().currentTime + OVERRIDE_HOLD_S
  );
}

export function modulated(
  base: number,
  lfos: LFO[],
  trackId: string,
  knob: LFODestKnob,
  time?: number,
  rateMul: number = 1
): number {
  const routed = findRouted(lfos, trackId, knob);
  if (routed.length === 0) return base;
  const totalDepth = routed.reduce((s, l) => s + l.depth, 0);
  if (totalDepth === 0) return base;
  const t = time ?? getAudioContext().currentTime;
  // Manual override: hand wins. Full base (LFO off) during the hold, then the
  // LFO depth ramps back from 0 over OVERRIDE_RAMP_S so it doesn't snap.
  const holdUntil = manualOverrides.get(overrideKey(trackId, knob));
  let depthScale = 1;
  if (holdUntil !== undefined) {
    if (t < holdUntil) return base;
    const since = t - holdUntil;
    if (since < OVERRIDE_RAMP_S) depthScale = since / OVERRIDE_RAMP_S;
    else manualOverrides.delete(overrideKey(trackId, knob));
  }
  const frozen = frozenLFOOutputs;
  let summed = 0;
  for (const l of routed) {
    const o = frozen
      ? frozen.get(l.id) ?? 0
      : lfoShapeValue(l.shape, l.rate * rateMul * t);
    summed += o * l.depth;
  }
  const out = summed / totalDepth;
  return applyLFO(base, totalDepth * depthScale, out);
}
