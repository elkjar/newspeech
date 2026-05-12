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
  | 'density' | 'motion' | 'drift' | 'chaos' | 'tension'
  | 'tapePosition' | 'tapeLength' | 'tapeMix' | 'tapeGrainRate' | 'tapeGrainMix'
  | 'glitchChance' | 'glitchMix'
  | 'reverbSize' | 'reverbMix'
  | 'preSaturationDrive'
  | 'masterInput' | 'masterComp' | 'masterDrive' | 'masterBias' | 'masterMix' | 'masterHiCut' | 'masterTrim' | 'masterGateThreshold';
export type LFODestKnob = LFODestKnobTrack | LFODestKnobGlobal;

// Sentinel trackId used in LFODestination when the destination is a global
// macro rather than a per-track knob. Lets the same routing list cover both.
export const GLOBAL_TRACK_ID = '__global__';

export interface LFODestination {
  trackId: string;
  knob: LFODestKnob;
}

export interface LFO {
  id: number;
  rate: number;
  depth: number;
  destinations: LFODestination[];
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
  }));
}

export function lfoOutput(lfo: LFO, time?: number): number {
  const t = time ?? getAudioContext().currentTime;
  return Math.sin(2 * Math.PI * lfo.rate * t);
}

// Freeze snapshot: when set, modulated() and useLFOValue read these stable
// bipolar outputs instead of advancing phase. Map key = lfo.id.
let frozenLFOOutputs: Map<number, number> | null = null;

export function freezeLFOs(lfos: LFO[], time?: number): void {
  const t = time ?? getAudioContext().currentTime;
  const snap = new Map<number, number>();
  for (const l of lfos) {
    snap.set(l.id, Math.sin(2 * Math.PI * l.rate * t));
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
  const frozen = frozenLFOOutputs;
  const t = time ?? getAudioContext().currentTime;
  let summed = 0;
  for (const l of routed) {
    const o = frozen
      ? frozen.get(l.id) ?? 0
      : Math.sin(2 * Math.PI * l.rate * rateMul * t);
    summed += o * l.depth;
  }
  const out = summed / totalDepth;
  return applyLFO(base, totalDepth, out);
}
