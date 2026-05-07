import type { Step } from '../state/store';

export function stepSeed(trackId: string, stepIndex: number): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < trackId.length; i++) {
    h ^= trackId.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  h ^= stepIndex;
  h = Math.imul(h, 16777619) >>> 0;
  return (h % 100000) / 100000;
}

export function morphStep(a: Step, b: Step, m: number, seed: number): Step {
  const lerp = (x: number, y: number) => x + (y - x) * m;
  return {
    on: a.on === b.on ? a.on : seed < m ? b.on : a.on,
    velocity: lerp(a.velocity, b.velocity),
    pitch: Math.round(lerp(a.pitch, b.pitch)),
    probability: lerp(a.probability, b.probability),
    ratchet: Math.round(lerp(a.ratchet, b.ratchet)),
    microTiming: lerp(a.microTiming, b.microTiming),
    gate: lerp(a.gate, b.gate),
    tieToNext: a.tieToNext,
  };
}
