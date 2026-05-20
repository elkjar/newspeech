// Ghost shape functions — pure mapping from (shape, phase) to a target
// entropy value in the palette's range. Used by the entropy-aware picker
// to bias bank choice toward the curve's current value.
//
// Phase ∈ [0,1] with per-shape semantics:
//   sustain: phase ignored — picker uses zig-zag in ghost.ts, not this module
//   build:   phase = elapsed/phaseLength, clamped to [0,1] (holds at 1)
//   arc:     phase = elapsed/phaseLength, clamped to [0,1] (holds at 1, target curls back to 0)
//   wave:    phase = (elapsed % phaseLength) / phaseLength (loops indefinitely)
//   decay:   phase = elapsed/phaseLength, clamped to [0,1] (holds at 1)
//
// Target ∈ [paletteMin, paletteMax] — bounds are derived from the actual
// populated palette so a session full of mid-entropy banks still gets a
// shaped arc within whatever range the author created.

import type { SceneShape } from '../state/store';

const STEPS_PER_BAR = 32;

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Compute phase ∈ [0,1] from scene-relative elapsed bars. For wave, phase
 * loops; for the directional shapes (build/arc/decay), phase clamps to 1.0
 * once the phaseLength is reached and stays there (the picker keeps holding
 * at the end-of-curve target until the scene transitions or shape changes).
 * Sustain returns 0 — the picker ignores this value via the sustain branch.
 */
export function phaseAt(
  globalStep: number,
  sceneStartStep: number,
  phaseLength: number,
  shape: SceneShape
): number {
  if (shape === 'sustain') return 0;
  const elapsedBars = Math.max(0, (globalStep - sceneStartStep) / STEPS_PER_BAR);
  const len = Math.max(1, phaseLength);
  if (shape === 'wave') {
    const mod = elapsedBars % len;
    return mod / len;
  }
  return Math.min(1, elapsedBars / len);
}

/**
 * Target entropy at the given phase, mapped into the palette range.
 *   sustain → returns the midpoint of palette; sustain branch in the picker
 *             doesn't actually call this (it uses zig-zag), but a sane value
 *             is returned for callers that don't branch.
 *   build   → lerp(min, max, phase)            — climbs, holds high
 *   arc     → sin(π · phase) curve             — climbs to max at phase=0.5, returns to min at phase=1
 *   wave    → 0.5 + 0.5·sin(2π · phase)        — full oscillation across one phaseLength
 *   decay   → lerp(max, min, phase)            — descends, holds low
 */
export function targetEntropy(
  shape: SceneShape,
  phase: number,
  paletteMin: number,
  paletteMax: number
): number {
  if (paletteMax <= paletteMin) return paletteMin;
  const p = Math.max(0, Math.min(1, phase));
  switch (shape) {
    case 'sustain':
      return lerp(paletteMin, paletteMax, 0.5);
    case 'build':
      return lerp(paletteMin, paletteMax, p);
    case 'arc':
      return lerp(paletteMin, paletteMax, Math.sin(Math.PI * p));
    case 'wave':
      return lerp(paletteMin, paletteMax, 0.5 + 0.5 * Math.sin(2 * Math.PI * p));
    case 'decay':
      return lerp(paletteMin, paletteMax, 1 - p);
  }
}

/**
 * Sample the shape curve at N evenly-spaced phase values. Used by GhostDebug
 * to render a curve overlay; pure helper so the visualizer doesn't have to
 * know the curve formulas.
 */
export function sampleShape(
  shape: SceneShape,
  paletteMin: number,
  paletteMax: number,
  samples: number
): number[] {
  const out: number[] = [];
  if (samples <= 1) return [targetEntropy(shape, 0, paletteMin, paletteMax)];
  for (let i = 0; i < samples; i++) {
    out.push(targetEntropy(shape, i / (samples - 1), paletteMin, paletteMax));
  }
  return out;
}
