// Macro math shared between dispatch (audio) and chance-mode rendering (visual).
// Density is bipolar around 0.5:
//   - density < 0.5 → metric thinning of authored-ON steps (offbeats drop first;
//     downbeat always fires regardless).
//   - density = 0.5 → pattern as authored (no thinning, no filling).
//   - density > 0.5 → fill-in: authored-OFF steps start firing, weighted by
//     INVERSE metric (offbeats fill fastest; downbeat never fills).

export const DENSITY_FLOOR = 0;

// Weight a step's metric strength in [0, 1] using binary subdivision depth.
// Step 0 is always 1 (pattern start). For other indices, count trailing binary
// zeros — `i = 8` (binary 1000) has depth 3 and is the strongest non-start
// position in a 16-step pattern; odd indices have depth 0 and are weakest.
// Normalizes by `log2(length)` so longer patterns get proportionally deeper
// hierarchy and the curve degrades gracefully on non-power-of-2 lengths.
//
// CAVEAT — polyrhythmic patterns: this weights each track independently against
// its own length's binary tree, so tracks of differing lengths get their own
// "downbeat" at index 0 and independent metric hierarchies. A 7-step or 12-step
// row's metric weights won't align with a 16-step row's, and density's thinning
// + fill behaviors act per-track on those independent grids. That can produce
// unexpected cross-rhythm shaping vs. a polymetric-aware weighting that knows
// about a global bar. Worth revisiting if it feels off in odd-meter writing.
export function metricWeight(stepIndex: number, length: number): number {
  if (length <= 1 || stepIndex === 0) return 1;
  let depth = 0;
  let n = stepIndex;
  while ((n & 1) === 0 && n > 0) {
    depth++;
    n >>= 1;
  }
  const maxDepth = Math.log2(length);
  if (maxDepth <= 0) return 1;
  return Math.min(1, depth / maxDepth);
}

// Multiplier in [0, 1] applied to an authored-ON step's probability. At density
// >= 0.5 the multiplier is 1 (pattern fires as authored). Below 0.5 the
// multiplier lerps from the metric-weighted floor (at density 0) to 1 (at
// density 0.5), so the downbeat (weight 1) always fires, mid (weight 0.75)
// drops to 75%, beats 2/4 (weight 0.5) to 50%, 8th offbeats (weight 0.25) to
// 25%, and 16th offbeats (weight 0) fall silent at density 0.
export function computeThinMul(
  modDensity: number,
  stepIndex: number,
  length: number
): number {
  if (modDensity >= 0.5) return 1;
  const weight = metricWeight(stepIndex, length);
  const floor = DENSITY_FLOOR + (1 - DENSITY_FLOOR) * weight;
  const t = modDensity * 2; // map [0, 0.5] → [0, 1]
  return floor + t * (1 - floor);
}

// Fill-in firing probability in [0, 1] for an authored-OFF step. At density
// <= 0.5 the result is 0 (pattern as authored, no fill). Above 0.5 the result
// lerps from 0 to `(1 - metricWeight) × MAX_FILL_PROB` — offbeats fill fastest,
// beats 2/4 fill slower, mid slowest, downbeat never fills. MAX_FILL_PROB
// caps the strongest fill at 60% chance so density=1 doesn't fully saturate
// the offbeats; keeps "high density" feeling busy without becoming chaotic.
export const MAX_FILL_PROB = 0.6;

export function computeFillProb(
  modDensity: number,
  stepIndex: number,
  length: number
): number {
  if (modDensity <= 0.5) return 0;
  const weight = metricWeight(stepIndex, length);
  const t = (modDensity - 0.5) * 2; // map [0.5, 1] → [0, 1]
  return (1 - weight) * t * MAX_FILL_PROB;
}
