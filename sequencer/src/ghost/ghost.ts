import {
  useSequencerStore,
  type BankSlot,
  type BankMacros,
  type SceneShape,
} from '../state/store';
import { RECIPE_DWELL } from './generator';
import { targetEntropy, phaseAt } from './shape';

// Ghost v1.5 — autonomous walker across populated banks, color-macro lerp
// on transitions, and ±10% in-scene density drift.
//
// Density is treated differently from the four "color" macros (chaos / motion
// / drift / tension): it's a pattern-tuning lens whose meaningful value is
// tightly coupled to the authored ON/OFF distribution of each bank. Lerping
// it across a swap means applying one pattern's density tuning to another
// pattern's structure, which produces the "out of control" feeling when banks
// have very different authored densities. So density SNAPS with the bank at
// the swap (atomic, same as the rest of bank state), and the ghost
// modulates it ±10% around the bank's saved value during the scene as a
// subtle performance variation.
//
// Color macros still lerp from previous bank's effective values to new
// bank's saved values over `transitionBars` bars at scene entry.
//
// Per-bank weighted edges + per-bank durations are still the next pass.

// Bar resolution lives in the scheduler — 32 globalSteps per 4/4 bar at 32nd
// granularity. Kept local to the ghost rather than imported to avoid a
// cycle through the scheduler module.
const STEPS_PER_BAR = 32;

// Density drift constants. ±10% absolute range around the bank's saved
// density, re-rolled every 4 bars; the RAF-driven smoother below pulls
// store.density toward `state.densityTarget` continuously, so the per-bar
// drift cadence just sets the target — no per-bar lerp math needed here.
const DRIFT_RANGE = 0.1;
const DRIFT_PERIOD_BARS = 4;

// Mid-scene fill — short density gesture fired probabilistically during
// the scene. Each spike is 1 bar at +MID_FILL_BOOST, then resolves back
// to drift. The density knob is sensitive (+10% reads as "fill not
// loop"), so the arc envelope is expressed via FREQUENCY of these
// gestures rather than a sustained baseline shift.
//
// Probability per bar = BASE + shape_intensity * SHAPE_BONUS. BASE > 0
// because Chris's hand-played patterns get fills CONSTANTLY across all
// scene phases — that's the lifeblood, not a climax-only thing.
// At sustain / arc bottom: BASE = 0.2 → ~5 bars between fills
// At arc midpoint: 0.35 → ~3 bars
// At arc peak: 0.5 → ~2 bars
const MID_FILL_BARS = 1;
const MID_FILL_BOOST = 0.3;
const BASE_FILL_PROB_PER_BAR = 0.2;
const SHAPE_FILL_PROB_BONUS = 0.3;

// Per-frame smoothing factor for the RAF density smoother. At 60fps a value
// of 0.06 reaches ~85% of the target in ~30 frames (~0.5s) — feels like a
// hand turning a knob, not a step jump. Adjust if drift/fill changes feel
// too sluggish or too tight.
const DENSITY_SMOOTH_PER_FRAME = 0.06;

// Pre-transition fill constants. In the last FILL_BARS of a scene's dwell,
// the ghost replaces normal density drift with a build curve that cranks
// density + chaos toward higher values — producer-natural "fill" gesture
// signaling change is coming. Boosts are additive on top of current values
// (clamped to 1.0), peak at the transition bar, then snap with the bank swap
// (density) or descend via macro lerp (chaos) into the new scene.
const FILL_BARS = 2;
const FILL_DENSITY_BOOST = 0.5;
const FILL_CHAOS_BOOST = 0.25;

interface GhostRuntime {
  sceneStartStep: number;
  dwellTargetBars: number;
  lastActiveBank: number | null;
  // Color-macro lerp (chaos/motion/drift/tension only — density excluded) —
  // populated on scene change when a source snapshot exists, advanced each
  // bar, cleared when elapsed >= total. Both null = no lerp active and the
  // bank swap's atomic write stands for those macros.
  lerpSource: BankMacros | null;
  lerpTarget: BankMacros | null;
  lerpBarsTotal: number;
  lerpBarsElapsed: number;
  // Density drift state — independent of the color-macro lerp.
  //   bankSavedDensity — baseline captured at scene entry
  //   densityDriftJitter — signed ±DRIFT_RANGE offset, re-rolled every
  //                        DRIFT_PERIOD_BARS, composed on top of baseline
  //   densityTarget — the actual destination the RAF smoother chases
  //   midFillBarsLeft — >0 while a mid-scene fill is in progress; the
  //                     per-bar tick decrements; pre-transition fill
  //                     cancels any active mid-fill on entry
  bankSavedDensity: number;
  densityDriftJitter: number;
  densityNextDriftStep: number;
  densityTarget: number;
  midFillBarsLeft: number;
  // Sustain-mode zig-zag state: sign of the last entropy delta, so the next
  // pick prefers the opposite direction. Updated whenever a bank swap lands.
  // +1 = last move went up (so next prefers down); -1 = last move went down.
  lastEntropySign: number;
}

const state: GhostRuntime = {
  sceneStartStep: 0,
  dwellTargetBars: 0,
  lastActiveBank: null,
  lerpSource: null,
  lerpTarget: null,
  lerpBarsTotal: 0,
  lerpBarsElapsed: 0,
  bankSavedDensity: 0.5,
  densityDriftJitter: 0,
  densityNextDriftStep: 0,
  densityTarget: 0.5,
  midFillBarsLeft: 0,
  lastEntropySign: 1,
};

let lastEnabled = false;
let lastPlaying = false;
let lastShape: SceneShape = 'arc';
let subscribed = false;

function rollDwellBars(minBars: number, maxBars: number): number {
  const lo = Math.max(1, Math.floor(minBars));
  const hi = Math.max(lo, Math.floor(maxBars));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// Transition-kind banks are 1–2 bar inserts. When the ghost lands on one
// (typically because the user manually queued it), dwell is forced into this
// tight range regardless of the global min/max so the bank exits fast.
const TRANSITION_DWELL_MIN = 1;
const TRANSITION_DWELL_MAX = 2;

// Epsilon in the weight denominator — without it, a candidate whose entropy
// exactly matches target would weight to Infinity, swamping the draw. With a
// small floor, a perfect-match still weights ~50× more than a candidate
// 0.1 away, which is the right falloff shape (peaked but not absolute).
const PICK_WEIGHT_EPSILON = 0.02;

// Sustain zig-zag step magnitude as a fraction of palette range. 0.3 means
// the picker aims one-third of the way across the palette in the opposite
// direction from the last move — produces a perceptible step without
// hopping to the extremes every time.
const SUSTAIN_STEP_FRACTION = 0.3;

// Slot-distance preference — Chris authors banks ordered chill → not-chill,
// so adjacent slots are nearer in intent than distant slots even when
// entropy values happen to match. Adds a second weight factor that falls
// off with |slot - currentSlot|. Combined with entropy weight: adjacent
// "okay" matches beat distant "perfect" matches by ~2×, but a clear
// entropy demand can still pull a longer jump when the shape calls for
// it. EPSILON keeps distance-1 weight from dominating absolutely; POWER
// tunes how steeply remote slots drop off (1.5 = perceptible bias, 2.0+ =
// near-mandatory sequential walk).
const SLOT_DISTANCE_EPSILON = 0.5;
const SLOT_DISTANCE_POWER = 1.5;

function bankEntropy(slot: BankSlot | null | undefined): number {
  if (!slot) return 0.5;
  return typeof slot.entropy === 'number' ? slot.entropy : 0.5;
}

function pickNextBank(
  banks: (BankSlot | null)[],
  currentBank: number | null,
  shape: SceneShape,
  phaseLength: number,
  globalStep: number,
  compositionStartStep: number,
  lastEntropySign: number
): number | null {
  // Transitions are user-triggered in v0 — autonomous walks only target
  // scene banks. Filter them out of the candidate pool here.
  const populated: number[] = [];
  for (let i = 0; i < banks.length; i++) {
    const slot = banks[i];
    if (slot && slot.kind !== 'transition' && i !== currentBank) {
      populated.push(i);
    }
  }
  if (populated.length === 0) return null;

  // Same-recipe avoidance: prefer banks whose recipe differs from the
  // current one — keeps "build" or "hits" from cycling into themselves
  // repeatedly. Falls back to the full populated pool only when every
  // candidate shares the current recipe.
  const currentRecipe =
    currentBank !== null ? banks[currentBank]?.recipe : undefined;
  let candidates = populated;
  if (currentRecipe) {
    const differentRecipe = populated.filter(
      (i) => banks[i]?.recipe !== currentRecipe
    );
    if (differentRecipe.length > 0) candidates = differentRecipe;
  }

  // Palette-derived bounds. Using only the candidate pool (not all banks)
  // so same-recipe-excluded outliers don't skew the curve range. With one
  // candidate, both bounds collapse to its entropy and any shape resolves
  // to that single value.
  const entropies = candidates.map((i) => bankEntropy(banks[i]));
  const paletteMin = Math.min(...entropies);
  const paletteMax = Math.max(...entropies);

  let target: number;
  if (shape === 'sustain') {
    // Zig-zag: aim opposite the last move's direction by SUSTAIN_STEP_FRACTION
    // of palette range. Clamp into [paletteMin, paletteMax] so the target
    // stays achievable by some candidate.
    const currentEntropy = bankEntropy(currentBank !== null ? banks[currentBank] : null);
    const step = (paletteMax - paletteMin) * SUSTAIN_STEP_FRACTION;
    const sign = lastEntropySign >= 0 ? 1 : -1;
    target = Math.max(paletteMin, Math.min(paletteMax, currentEntropy - sign * step));
  } else {
    const phase = phaseAt(globalStep, compositionStartStep, phaseLength, shape);
    target = targetEntropy(shape, phase, paletteMin, paletteMax);
  }

  // Weighted pick combining two preferences:
  //   1. Entropy match: 1/(ε+|delta|) — peaks at the target entropy curve.
  //   2. Slot proximity: 1/(ε+distance)^POWER — favors adjacent slots,
  //      respecting Chris's authored chill→not-chill ordering.
  // Their product means "stay sequential by default, jump when entropy
  // really demands it." Skipped on first pick after enable (no current
  // slot to measure distance from).
  const weights = candidates.map((i) => {
    const e = bankEntropy(banks[i]);
    const entropyWeight = 1 / (PICK_WEIGHT_EPSILON + Math.abs(e - target));
    if (currentBank === null) return entropyWeight;
    const slotDist = Math.abs(i - currentBank);
    const slotWeight =
      1 / Math.pow(SLOT_DISTANCE_EPSILON + slotDist, SLOT_DISTANCE_POWER);
    return entropyWeight * slotWeight;
  });
  const totalWeight = weights.reduce((s, w) => s + w, 0);
  let winner: number;
  if (totalWeight <= 0) {
    winner = candidates[Math.floor(Math.random() * candidates.length)];
  } else {
    let roll = Math.random() * totalWeight;
    winner = candidates[candidates.length - 1];
    for (let i = 0; i < candidates.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        winner = candidates[i];
        break;
      }
    }
  }

  // Push pick-rationale entry for the datafeed log. Phase recomputed for
  // sustain (where the picker uses zig-zag not the shape curve) so the log
  // shows the actual time position, not a misleading 0.
  const winnerEntropy = bankEntropy(banks[winner]);
  const recordedPhase =
    shape === 'sustain' ? 0 : phaseAt(globalStep, compositionStartStep, phaseLength, shape);
  useSequencerStore.getState().pushGhostPickEvent({
    kind: 'auto',
    globalStep,
    slot: winner,
    shape,
    phase: recordedPhase,
    target,
    pickedEntropy: winnerEntropy,
    deltaFromTarget: Math.abs(winnerEntropy - target),
    candidateCount: candidates.length,
  });
  return winner;
}

function snapshotMacros(s: ReturnType<typeof useSequencerStore.getState>): BankMacros {
  return {
    density: s.density,
    chaos: s.chaos,
    motion: s.motion,
    drift: s.drift,
    tension: s.tension,
  };
}

function lerpVal(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function applyLerpStep(): void {
  if (!state.lerpSource || !state.lerpTarget || state.lerpBarsTotal <= 0) return;
  const t = Math.min(1, Math.max(0, state.lerpBarsElapsed / state.lerpBarsTotal));
  // Density excluded — it snaps with the bank at swap, and the in-scene
  // drift below is the only thing that touches density during a scene.
  useSequencerStore.getState().setMacros({
    chaos: lerpVal(state.lerpSource.chaos, state.lerpTarget.chaos, t),
    motion: lerpVal(state.lerpSource.motion, state.lerpTarget.motion, t),
    drift: lerpVal(state.lerpSource.drift, state.lerpTarget.drift, t),
    tension: lerpVal(state.lerpSource.tension, state.lerpTarget.tension, t),
  });
}

// Drift jitter — re-rolled every DRIFT_PERIOD_BARS, applied as a signed
// offset on top of bankSavedDensity. Replaces the old `densityDriftTarget`
// (absolute value) so it can compose cleanly with the shape envelope.
function rollDriftJitter(): number {
  return (Math.random() * 2 - 1) * DRIFT_RANGE;
}

// Shape intensity at the current composition phase — used as the
// shape-driven boost on mid-fill probability. Sustain returns 0 (no arc,
// fills still fire via the constant BASE rate). Other shapes return the
// [0,1] curve value.
function currentShapeIntensity(globalStep: number): number {
  const s = useSequencerStore.getState();
  const { shape, phaseLength } = s.sceneGraph;
  if (shape === 'sustain') return 0;
  const phase = phaseAt(globalStep, s.ghostCompositionStartStep, phaseLength, shape);
  return targetEntropy(shape, phase, 0, 1);
}

function applyDensityDrift(): void {
  // Two-layer compose: bank-saved baseline + drift jitter. The arc shape
  // is NOT expressed as a baseline offset here — knob is too sensitive
  // (+10% reads as "fill") so the arc envelope rides on mid-fill frequency
  // instead. See applyMidFill below.
  state.densityTarget = Math.max(
    0,
    Math.min(1, state.bankSavedDensity + state.densityDriftJitter)
  );
}

function tickDriftJitter(globalStep: number): void {
  if (globalStep >= state.densityNextDriftStep) {
    state.densityDriftJitter = rollDriftJitter();
    state.densityNextDriftStep = globalStep + DRIFT_PERIOD_BARS * STEPS_PER_BAR;
  }
}

// Mid-scene fill — short density spike that resolves back to drift. The
// progress ramps 0..1 across the fill's bars (clamped if MID_FILL_BARS=1).
// Smoother handles the actual knob lerp from drift to peak and back.
function applyMidFill(): void {
  const elapsed = MID_FILL_BARS - state.midFillBarsLeft;
  const progress =
    MID_FILL_BARS <= 1 ? 1 : elapsed / (MID_FILL_BARS - 1);
  state.densityTarget = Math.max(
    0,
    Math.min(
      1,
      state.bankSavedDensity + state.densityDriftJitter + MID_FILL_BOOST * progress
    )
  );
}

// Fill build — applies in the last FILL_BARS of a scene's dwell. Linear ramp:
// 0% boost at fill-zone entry (barsRemaining = FILL_BARS) up to 100% at the
// transition bar (barsRemaining = 0). Replaces normal density drift during
// fill bars so the build's crank isn't fighting drift's pull toward
// bankSavedDensity. Chaos is not smoothed — fill is short (2 bars) and
// chaos is visually less tied to the knob feel; if it becomes objectionable
// we'll route it through the same smoother pattern.
function applyFillBuild(barsRemaining: number): void {
  const progress = (FILL_BARS - barsRemaining) / FILL_BARS;
  const store = useSequencerStore.getState();
  state.densityTarget = Math.max(
    0,
    Math.min(1, state.bankSavedDensity + FILL_DENSITY_BOOST * progress)
  );
  const fillChaos = Math.min(1, store.chaos + FILL_CHAOS_BOOST * progress);
  store.setMacros({ chaos: fillChaos });
}

// Per-bar density dispatcher. Pre-transition fill takes priority; otherwise
// mid-fill continues if in progress; otherwise roll for a new mid-fill
// (probability = currentShapeIntensity * MAX_MID_FILL_PROB); otherwise
// drift. Drift jitter is re-rolled on its own period regardless.
function tickDensity(globalStep: number, inFillZone: boolean): void {
  tickDriftJitter(globalStep);

  if (inFillZone) {
    state.midFillBarsLeft = 0;
    return; // applyFillBuild is called by tickBar separately
  }

  if (state.midFillBarsLeft > 0) {
    applyMidFill();
    state.midFillBarsLeft--;
    return;
  }

  // Roll for a new mid-fill — constant BASE rate + shape-driven BONUS.
  // Fills fire across all phases (not just climax) so patterns feel
  // alive in quiet sections too.
  const intensity = currentShapeIntensity(globalStep);
  const prob = BASE_FILL_PROB_PER_BAR + intensity * SHAPE_FILL_PROB_BONUS;
  if (Math.random() < prob) {
    state.midFillBarsLeft = MID_FILL_BARS;
    applyMidFill();
    state.midFillBarsLeft--;
    return;
  }

  applyDensityDrift();
}

// Per-frame density smoother. Runs only while ghost is enabled + playing.
// Pulls store.density toward state.densityTarget at a fixed per-frame
// fraction, so density changes from drift + fill feel like a knob being
// turned continuously rather than stepping at each bar boundary.
let densityRAF: number | null = null;
function densityTick(): void {
  const s = useSequencerStore.getState();
  if (!s.sceneGraph.enabled || !s.playing) {
    densityRAF = null;
    return;
  }
  const cur = s.density;
  const diff = state.densityTarget - cur;
  if (Math.abs(diff) > 0.0005) {
    s.setMacros({ density: cur + diff * DENSITY_SMOOTH_PER_FRAME });
  }
  densityRAF = requestAnimationFrame(densityTick);
}

function ensureDensitySmootherRunning(): void {
  if (densityRAF !== null) return;
  densityRAF = requestAnimationFrame(densityTick);
}

export function resetGhost(): void {
  state.sceneStartStep = 0;
  state.dwellTargetBars = 0;
  state.lastActiveBank = null;
  state.lerpSource = null;
  state.lerpTarget = null;
  state.lerpBarsTotal = 0;
  state.lerpBarsElapsed = 0;
  state.densityNextDriftStep = 0;
  state.midFillBarsLeft = 0;
  // Sustain-mode direction memory: reset to +1 so the first move biases up
  // from the current bank (arbitrary but deterministic; flips on first swap).
  state.lastEntropySign = 1;
  // Drift baseline + target re-initialize from the live store value the next
  // time the scene-change branch fires; no need to seed them here.
  // Wipe the display fields too so stale "X bars remaining" doesn't linger
  // after a stop or a fresh enable. Restart the composition phase reference
  // from the current globalStep so toggling ghost mid-session starts a fresh
  // arc rather than picking up wherever the last composition left off.
  const store = useSequencerStore.getState();
  store.setGhostDisplay(0, 0);
  store.setGhostCompositionStart(store.globalStep);
  // Pick log is intentionally NOT cleared — it's an ACTION LOG, persisting
  // across stop / enable / disable transitions. FIFO ring buffer in the
  // store caps growth; treat it as a session-long history vs. transient
  // per-take state.
  // Smoother target snaps to the live density value so the smoother has no
  // pending lerp on enable — it'll only start chasing when drift/fill set a
  // new target on the next bar boundary.
  state.densityTarget = store.density;
}

// Called from App.tsx's scheduler callback IMMEDIATELY BEFORE commitPendingBank().
// Snapshots the current (about-to-be-overwritten) macro values as the lerp
// source IFF a swap is pending AND ghost is enabled AND transitionBars > 0.
// On the next ghost.tickBar() (after the commit), the new bank's macros
// become the lerp target.
export function beforeBarCommit(): void {
  const store = useSequencerStore.getState();
  if (
    store.pendingBank !== null &&
    store.sceneGraph.enabled &&
    store.sceneGraph.transitionBars > 0
  ) {
    state.lerpSource = snapshotMacros(store);
  } else {
    // Any leftover source from a previous bar (e.g. user disabled ghost
    // mid-flight) shouldn't bleed into this swap.
    state.lerpSource = null;
  }
}

// Called every bar boundary from App.tsx's scheduler callback, AFTER
// commitPendingBank() has applied any queued swap for this bar. Reads current
// store state, may call queueBank() which becomes the *next* bar's swap.
export function tickBar(globalStep: number): void {
  const store = useSequencerStore.getState();
  const { sceneGraph, banks, activeBank, pendingBank } = store;

  // Scene change branch — always sync the active-bank watcher so manual bank
  // changes trigger a fresh dwell roll when ghost next acts. Doing this
  // even when disabled keeps state consistent if the user toggles on later.
  if (state.lastActiveBank !== activeBank) {
    // Track entropy delta sign across the swap for sustain zig-zag. Compare
    // the new active's entropy to the bank we just left; sign of the diff
    // becomes the picker's "last direction" so the next pick prefers the
    // opposite. Resilient to nulls (skip update when either side missing).
    if (state.lastActiveBank !== null && activeBank !== null) {
      const prev = banks[state.lastActiveBank];
      const curr = banks[activeBank];
      if (prev && curr) {
        const prevE = typeof prev.entropy === 'number' ? prev.entropy : 0.5;
        const currE = typeof curr.entropy === 'number' ? curr.entropy : 0.5;
        const delta = currE - prevE;
        if (Math.abs(delta) > 0.001) {
          state.lastEntropySign = delta > 0 ? 1 : -1;
        }
      }
    }

    state.lastActiveBank = activeBank;
    state.sceneStartStep = globalStep;
    // Dwell-range priority:
    //   1. Transition-kind banks: 1–2 bars (turnarounds/breaks, fixed range).
    //   2. Recipe-tagged scene banks: use RECIPE_DWELL[recipe] for musical-
    //      natural durations (build/hits 1-2, ambient 6-12, song-body 4-8).
    //   3. Untagged scene banks (user-snapped): fall back to the global
    //      sceneGraph min/max as before.
    const activeSlot = activeBank !== null ? banks[activeBank] : null;
    if (activeSlot?.kind === 'transition') {
      state.dwellTargetBars = rollDwellBars(TRANSITION_DWELL_MIN, TRANSITION_DWELL_MAX);
    } else if (activeSlot?.recipe && RECIPE_DWELL[activeSlot.recipe as keyof typeof RECIPE_DWELL]) {
      const range = RECIPE_DWELL[activeSlot.recipe as keyof typeof RECIPE_DWELL];
      state.dwellTargetBars = rollDwellBars(range.min, range.max);
    } else {
      state.dwellTargetBars = rollDwellBars(sceneGraph.minBars, sceneGraph.maxBars);
    }
    // Decorate the just-pushed log entry with the dwell decision. tickBar
    // fires AFTER applyBankSlot's manual push and AFTER pickNextBank's auto
    // push, so the most-recent entry is always the one we want to tag.
    if (activeBank !== null) {
      store.setDwellOnLastBankChange(activeBank, state.dwellTargetBars);
    }

    // Capture this bank's saved density as the drift baseline. applyBankSlot
    // already wrote it to the store, so reading store.density gives us the
    // authoritative value. Zero jitter at scene entry (no immediate
    // motion); first re-roll fires DRIFT_PERIOD_BARS into the scene so the
    // bank's saved density is heard cleanly before any drift kicks in.
    state.bankSavedDensity = store.density;
    state.densityDriftJitter = 0;
    state.densityTarget = state.bankSavedDensity;
    state.densityNextDriftStep = globalStep + DRIFT_PERIOD_BARS * STEPS_PER_BAR;
    state.midFillBarsLeft = 0;

    // Color-macro lerp setup. Only if beforeBarCommit captured a source on
    // this bar — that already gated on enabled + transitionBars > 0, so we
    // trust the presence of lerpSource as the green light.
    if (state.lerpSource) {
      state.lerpTarget = snapshotMacros(store);
      state.lerpBarsTotal = sceneGraph.transitionBars;
      state.lerpBarsElapsed = 0;
      // Apply step 0 immediately — overwrites the bank swap's macro write
      // with the source values, so the dispatch reading macros later in this
      // same scheduler callback sees the lerp's starting point rather than a
      // one-tick flash at the target.
      applyLerpStep();
    } else {
      state.lerpTarget = null;
      state.lerpBarsTotal = 0;
      state.lerpBarsElapsed = 0;
    }

    if (sceneGraph.enabled) {
      store.setGhostDisplay(state.dwellTargetBars, state.dwellTargetBars);
    }
    return;
  }

  // Advance an in-progress lerp regardless of enabled state. If the user
  // disabled the ghost mid-lerp, finishing the lerp is musically the
  // right thing — disable means "no more autonomous transitions," not
  // "abort whatever is in motion."
  if (
    state.lerpSource &&
    state.lerpTarget &&
    state.lerpBarsElapsed < state.lerpBarsTotal
  ) {
    state.lerpBarsElapsed++;
    applyLerpStep();
    if (state.lerpBarsElapsed >= state.lerpBarsTotal) {
      state.lerpSource = null;
      state.lerpTarget = null;
    }
  }

  // Compute scene position EARLY so fill-build can override drift in the
  // last FILL_BARS of the dwell. Pre-transition fill is the WS-style
  // "ghost making decisions during a scene" gesture — anticipates the
  // upcoming swap by cranking density + chaos, then the swap itself snaps
  // density and lerp settles chaos back down into the new scene.
  const elapsedBars = Math.floor((globalStep - state.sceneStartStep) / STEPS_PER_BAR);
  const remaining = Math.max(0, state.dwellTargetBars - elapsedBars);

  if (sceneGraph.enabled) {
    // Pre-transition fill takes priority over mid-scene fills. Outside
    // the fill zone, tickDensity decides between continuing a mid-fill,
    // rolling a new one (probability scaled by shape intensity), or
    // falling back to drift.
    const inFillZone =
      remaining > 0 &&
      remaining <= FILL_BARS &&
      state.dwellTargetBars > FILL_BARS;
    tickDensity(globalStep, inFillZone);
    if (inFillZone) {
      applyFillBuild(remaining);
    }
  }

  if (!sceneGraph.enabled) return;
  // Something else queued a swap — don't fight it; let it land and we'll
  // reset on the bar it commits.
  if (pendingBank !== null) return;

  store.setGhostDisplay(remaining, state.dwellTargetBars);

  if (elapsedBars < state.dwellTargetBars) return;

  const next = pickNextBank(
    banks,
    activeBank,
    sceneGraph.shape,
    sceneGraph.phaseLength,
    globalStep,
    store.ghostCompositionStartStep,
    state.lastEntropySign
  );
  if (next === null) return;
  store.queueBank(next);
}

// Subscribe once at app mount. Two transitions reset the dwell timer:
//   - playing flips true → false: stop resets so resume rolls fresh dwell
//   - sceneGraph.enabled flips false → true: toggling on after a long disabled
//     stretch shouldn't fire an immediate transition based on stale elapsed
//     bars from a previous session.
// Tracking vars are updated BEFORE calling resetGhost — resetGhost
// writes the display fields back to the store, which re-fires this subscriber
// synchronously, which would otherwise see stale lastEnabled and recurse
// forever. Snapshot the deltas first, update tracking, THEN act.
export function initGhost(): void {
  if (subscribed) return;
  subscribed = true;
  const init = useSequencerStore.getState();
  lastEnabled = init.sceneGraph.enabled;
  lastPlaying = init.playing;
  lastShape = init.sceneGraph.shape;
  useSequencerStore.subscribe((s) => {
    const stopJustPressed = lastPlaying && !s.playing;
    const playJustPressed = !lastPlaying && s.playing;
    const enableJustFlipped = !lastEnabled && s.sceneGraph.enabled;
    const disableJustFlipped = lastEnabled && !s.sceneGraph.enabled;
    const shapeChanged = s.sceneGraph.shape !== lastShape;
    const shapeFrom = lastShape;
    // Update tracking BEFORE acting so re-fires from log pushes don't
    // re-detect the same transitions and recurse.
    lastEnabled = s.sceneGraph.enabled;
    lastPlaying = s.playing;
    lastShape = s.sceneGraph.shape;
    if (stopJustPressed) resetGhost();
    if (enableJustFlipped) resetGhost();
    if ((enableJustFlipped || playJustPressed) && s.sceneGraph.enabled && s.playing) {
      ensureDensitySmootherRunning();
    }
    // Datafeed log — meta events (shape change, ghost toggle, transport
    // toggle) accumulate alongside bank changes for the action-log view.
    if (playJustPressed) {
      s.pushGhostPickEvent({
        kind: 'transport',
        globalStep: s.globalStep,
        playing: true,
      });
    }
    if (stopJustPressed) {
      s.pushGhostPickEvent({
        kind: 'transport',
        globalStep: s.globalStep,
        playing: false,
      });
    }
    if (enableJustFlipped) {
      s.pushGhostPickEvent({
        kind: 'ghost',
        globalStep: s.globalStep,
        enabled: true,
      });
    }
    if (disableJustFlipped) {
      s.pushGhostPickEvent({
        kind: 'ghost',
        globalStep: s.globalStep,
        enabled: false,
      });
    }
    if (shapeChanged) {
      s.pushGhostPickEvent({
        kind: 'shape',
        globalStep: s.globalStep,
        from: shapeFrom,
        to: s.sceneGraph.shape,
      });
    }
  });
}
