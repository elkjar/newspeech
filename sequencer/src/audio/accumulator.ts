// Per-step accumulator — a deterministic per-(track,step) pitch ladder. Each
// time a step FIRES it reads its current rung, then advances its own counter,
// so successive sounds climb by `step` scale-degrees up to `range` rungs, then
// turn/reset per `shape`. Independent per step (the "intersecting unsynced
// systems" lever) and ephemeral (playback state) — same module-level-Map shape
// as treeState / mutationOverlay. Phase 1 of the accumulator feature; the
// track-level version under the mutate knob is Phase 2.

export type AccumulatorShape = 'wrap' | 'bounce' | 'hold';

export interface AccumulatorCfg {
  step: number; // signed scale degrees added per rung (−7..+7)
  range: number; // rungs before it turns/resets (1..8)
  shape: AccumulatorShape;
}

// The rung (ladder position) for a given fire-count.
//   wrap   — sawtooth: 0,1,…,range-1,0,…  (snap home)
//   bounce — triangle, period 2*(range-1): climbs then descends
//   hold   — climb once to range-1 and stay (only a reset clears it)
// range <= 1 → always home (0).
export function accRung(count: number, range: number, shape: AccumulatorShape): number {
  if (range <= 1) return 0;
  if (shape === 'hold') return Math.min(count, range - 1);
  if (shape === 'bounce') {
    const period = 2 * (range - 1);
    const p = ((count % period) + period) % period;
    return p < range ? p : period - p;
  }
  return ((count % range) + range) % range; // wrap
}

// Ephemeral per-(track,step) fire counters. Not persisted.
const counters = new Map<string, Map<number, number>>();

function read(trackId: string, index: number): number {
  return counters.get(trackId)?.get(index) ?? 0;
}

function bump(trackId: string, index: number): void {
  let m = counters.get(trackId);
  if (!m) {
    m = new Map();
    counters.set(trackId, m);
  }
  m.set(index, (m.get(index) ?? 0) + 1);
}

// Read-and-maybe-advance, mirroring treeState.consumeBranchLeaf: returns the
// rung for this fire, then advances the counter when `advance` is true (engine
// passes advance = the step actually fired this tick and we're not frozen), so
// the first sounding reads rung 0 (home) and each subsequent fire climbs.
export function consumeStepAccRung(
  trackId: string,
  index: number,
  cfg: AccumulatorCfg,
  advance: boolean,
): number {
  const rung = accRung(read(trackId, index), cfg.range, cfg.shape);
  if (advance) bump(trackId, index);
  return rung;
}

// ---------------------------------------------------------------------------
// mutate-driven AUTO accumulator (Phase 2). The mutate knob (+ ghost) applies
// the accumulator mechanic automatically on lead tracks — no per-step
// authoring. Each placement gets a deterministic varied loop length and a
// climb CAPPED at +2 scale degrees (subtle development, not octave leaps).
// Coverage scales with `amount`: a placement is eligible when its stable hash
// falls under `amount`, so turning mutate up spreads ladders to as many
// placements as possible. Reuses the per-step fire counters above.
const AUTO_CAP = 2;

// FNV-1a hash of (trackId, salt) → uint32, for stable per-placement variation.
function fnv(trackId: string, salt: number): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < trackId.length; i++) {
    h ^= trackId.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= salt & 0xff;
  h = Math.imul(h, 16777619);
  h ^= (salt >>> 8) & 0xff;
  h = Math.imul(h, 16777619);
  return h >>> 0;
}

// Returns the degree offset (0..AUTO_CAP) for this placement's auto-climb, and
// advances its counter when `advance` (the step fired, not frozen). Returns 0
// when the placement isn't covered at the current amount.
export function consumeAutoMutationRung(
  trackId: string,
  index: number,
  amount: number,
  advance: boolean,
): number {
  const eligible = fnv(trackId, index) / 4294967296 < amount;
  if (!eligible) return 0;
  const range = 2 + (fnv(trackId, index * 131 + 17) % 7); // varied loop length 2..8
  const rung = ((read(trackId, index) % range) + range) % range; // sawtooth wrap
  const off = Math.min(rung, AUTO_CAP); // climb to +2, hold, reset on wrap
  if (advance) bump(trackId, index);
  return off;
}

// Read-only rung for the current counter (no advance) — for UI readouts.
export function peekStepAccRung(trackId: string, index: number, cfg: AccumulatorCfg): number {
  return accRung(read(trackId, index), cfg.range, cfg.shape);
}

// Reset alongside resetBranchWalk on transport/bank/scene/song/init swaps so
// ladders restart from home and don't carry across pattern changes.
export function resetStepAccumulators(): void {
  counters.clear();
}

// Validate a persisted/authored config. Returns null when absent/invalid.
export function parseAccumulator(raw: unknown): AccumulatorCfg | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const shape = o.shape;
  if (shape !== 'wrap' && shape !== 'bounce' && shape !== 'hold') return null;
  const step = typeof o.step === 'number' ? Math.max(-7, Math.min(7, Math.round(o.step))) : 0;
  const range = typeof o.range === 'number' ? Math.max(1, Math.min(8, Math.round(o.range))) : 1;
  if (step === 0) return null; // a zero-step ladder is a no-op — treat as absent
  return { step, range, shape };
}
