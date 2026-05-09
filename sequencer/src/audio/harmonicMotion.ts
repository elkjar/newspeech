// Harmonic-motion sampler driven by the global `motion` macro (bipolar) and
// `drift` macro (probability gate). Bar-aligned discrete jumps to a new
// scale-degree offset; magnitude controls jump rate AND range, sign biases
// direction. Drift gates whether each opportunity actually fires.

const STEPS_PER_BAR = 32; // 4 beats × 8 stepsPerBeat

export interface HarmonicMotionState {
  offset: number;
  // The last globalStep at which we evaluated a bar boundary. Used to detect
  // bar crossings without depending on wall-clock time.
  lastBarStep: number;
  // Counts bars elapsed since the last (or zero) jump opportunity, so we can
  // honor `barsBetweenJumps` even when motion magnitude changes mid-run.
  barsSinceCheck: number;
  // Tracks whether the melody is currently sitting at root (offset=0) or
  // away. Each successful opportunity alternates between the two — a jump
  // away has to resolve to root before the next non-root jump can fire.
  atRoot: boolean;
}

export function makeHarmonicMotionState(): HarmonicMotionState {
  return { offset: 0, lastBarStep: -1, barsSinceCheck: 0, atRoot: true };
}

// Convert the unipolar [0,1] `motion` store value to its bipolar form [-1,+1].
// 0.5 = center = no motion.
export function motionBipolar(motion: number): number {
  return (motion - 0.5) * 2;
}

// Pick a non-zero scale-degree offset, weighted toward the dominant side of
// the range. Excludes 0 because the away/home alternation rule already
// reserves root for the return phase — sampling 0 here would mean two roots
// in a row, breaking the cycle.
export function sampleHarmonicJump(
  bipolar: number,
  octaveDegrees: number
): number {
  const mag = Math.abs(bipolar);
  if (mag === 0) return 0;
  const dominant = Math.max(1, Math.round(mag * octaveDegrees));
  const tail = 1;
  const sign = bipolar >= 0 ? 1 : -1;
  const lo = sign > 0 ? -tail : -dominant;
  const hi = sign > 0 ? dominant : tail;
  const dominantValue = sign > 0 ? hi : lo;
  const span = hi - lo;
  const values: number[] = [];
  const weights: number[] = [];
  let total = 0;
  for (let i = lo; i <= hi; i++) {
    if (i === 0) continue;
    const distFromDom = Math.abs(i - dominantValue);
    const w = (span - distFromDom) + 1;
    values.push(i);
    weights.push(w);
    total += w;
  }
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return values[i];
  }
  return dominantValue;
}

// Bars between jump opportunities, given the current motion magnitude.
// |bipolar|=1 → every bar; |bipolar|=0.5 → every 2 bars; |bipolar|=0.1 → every
// 10 bars; |bipolar|=0 → never (caller should skip entirely).
export function barsBetweenJumps(bipolar: number): number {
  const mag = Math.abs(bipolar);
  if (mag === 0) return Infinity;
  return Math.max(1, Math.round(1 / mag));
}

// Advance the state given the current scheduler globalStep and the macro
// values. Mutates and returns `state.offset` for the caller to use.
export function tickHarmonicMotion(
  state: HarmonicMotionState,
  globalStep: number,
  motion: number,
  drift: number,
  octaveDegrees: number
): number {
  const bipolar = motionBipolar(motion);
  const mag = Math.abs(bipolar);

  // At center, harmonic motion is fully off — snap offset to 0.
  if (mag === 0) {
    state.offset = 0;
    state.lastBarStep = globalStep;
    state.barsSinceCheck = 0;
    state.atRoot = true;
    return 0;
  }

  const isBarBoundary = globalStep % STEPS_PER_BAR === 0;
  const crossed =
    isBarBoundary && state.lastBarStep !== globalStep;
  if (!crossed) return state.offset;

  state.lastBarStep = globalStep;
  state.barsSinceCheck += 1;
  const interval = barsBetweenJumps(bipolar);
  if (state.barsSinceCheck < interval) return state.offset;

  state.barsSinceCheck = 0;
  // Probabilistic gate from drift. Default drift=1 means every opportunity
  // fires; lower drift adds bar-to-bar variability.
  if (Math.random() >= drift) return state.offset;

  // Alternate: at root → jump away, away → return to root.
  if (state.atRoot) {
    state.offset = sampleHarmonicJump(bipolar, octaveDegrees);
    state.atRoot = false;
  } else {
    state.offset = 0;
    state.atRoot = true;
  }
  return state.offset;
}
