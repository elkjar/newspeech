import { useSequencerStore, type BankSlot, type BankMacros } from '../state/store';
import { RECIPE_DWELL } from './generator';

// Conductor v1.5 — autonomous walker across populated banks, color-macro lerp
// on transitions, and ±10% in-scene density drift.
//
// Density is treated differently from the four "color" macros (chaos / motion
// / drift / tension): it's a pattern-tuning lens whose meaningful value is
// tightly coupled to the authored ON/OFF distribution of each bank. Lerping
// it across a swap means applying one pattern's density tuning to another
// pattern's structure, which produces the "out of control" feeling when banks
// have very different authored densities. So density SNAPS with the bank at
// the swap (atomic, same as the rest of bank state), and the conductor
// modulates it ±10% around the bank's saved value during the scene as a
// subtle performance variation.
//
// Color macros still lerp from previous bank's effective values to new
// bank's saved values over `transitionBars` bars at scene entry.
//
// Per-bank weighted edges + per-bank durations are still the next pass.

// Bar resolution lives in the scheduler — 32 globalSteps per 4/4 bar at 32nd
// granularity. Kept local to the conductor rather than imported to avoid a
// cycle through the scheduler module.
const STEPS_PER_BAR = 32;

// Density drift constants. ±10% absolute range around the bank's saved
// density, re-rolled every 4 bars, smoothed toward the new target at 25% of
// the remaining distance per bar (so a fresh target is ~95% reached after
// ~10 bars, comfortably within most scene dwells).
const DRIFT_RANGE = 0.1;
const DRIFT_PERIOD_BARS = 4;
const DRIFT_SMOOTHING = 0.25;

// Pre-transition fill constants. In the last FILL_BARS of a scene's dwell,
// the conductor replaces normal density drift with a build curve that cranks
// density + chaos toward higher values — producer-natural "fill" gesture
// signaling change is coming. Boosts are additive on top of current values
// (clamped to 1.0), peak at the transition bar, then snap with the bank swap
// (density) or descend via macro lerp (chaos) into the new scene.
const FILL_BARS = 2;
const FILL_DENSITY_BOOST = 0.5;
const FILL_CHAOS_BOOST = 0.25;

interface ConductorRuntime {
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
  // Density drift state — independent of the color-macro lerp. bankSavedDensity
  // is the baseline captured at scene entry; densityDriftTarget is the
  // currently-walking target within bankSaved±DRIFT_RANGE.
  bankSavedDensity: number;
  densityDriftTarget: number;
  densityNextDriftStep: number;
}

const state: ConductorRuntime = {
  sceneStartStep: 0,
  dwellTargetBars: 0,
  lastActiveBank: null,
  lerpSource: null,
  lerpTarget: null,
  lerpBarsTotal: 0,
  lerpBarsElapsed: 0,
  bankSavedDensity: 0.5,
  densityDriftTarget: 0.5,
  densityNextDriftStep: 0,
};

let lastEnabled = false;
let lastPlaying = false;
let subscribed = false;

function rollDwellBars(minBars: number, maxBars: number): number {
  const lo = Math.max(1, Math.floor(minBars));
  const hi = Math.max(lo, Math.floor(maxBars));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

// Transition-kind banks are 1–2 bar inserts. When the conductor lands on one
// (typically because the user manually queued it), dwell is forced into this
// tight range regardless of the global min/max so the bank exits fast.
const TRANSITION_DWELL_MIN = 1;
const TRANSITION_DWELL_MAX = 2;

function pickNextBank(
  banks: (BankSlot | null)[],
  currentBank: number | null
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
  // Same-recipe avoidance: never pick a bank whose recipe matches the
  // current one if a different-recipe option exists. Keeps "build" or
  // "hits" from cycling into themselves repeatedly. Falls back to the
  // full populated pool only when every candidate shares the current
  // recipe (user has e.g. only built melodic banks).
  const currentRecipe =
    currentBank !== null ? banks[currentBank]?.recipe : undefined;
  if (currentRecipe) {
    const differentRecipe = populated.filter(
      (i) => banks[i]?.recipe !== currentRecipe
    );
    if (differentRecipe.length > 0) {
      return differentRecipe[Math.floor(Math.random() * differentRecipe.length)];
    }
  }
  return populated[Math.floor(Math.random() * populated.length)];
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

function rollDriftTarget(base: number): number {
  return Math.max(0, Math.min(1, base + (Math.random() * 2 - 1) * DRIFT_RANGE));
}

function applyDensityDrift(globalStep: number): void {
  const store = useSequencerStore.getState();
  if (globalStep >= state.densityNextDriftStep) {
    state.densityDriftTarget = rollDriftTarget(state.bankSavedDensity);
    state.densityNextDriftStep = globalStep + DRIFT_PERIOD_BARS * STEPS_PER_BAR;
  }
  const cur = store.density;
  const next = cur + (state.densityDriftTarget - cur) * DRIFT_SMOOTHING;
  // No-op skip when already at target within a hair — avoids spamming
  // setMacros (and the resulting subscriber fan-out) once we've converged.
  if (Math.abs(next - cur) < 0.0005) return;
  store.setMacros({ density: next });
}

// Fill build — applies in the last FILL_BARS of a scene's dwell. Linear ramp:
// 0% boost at fill-zone entry (barsRemaining = FILL_BARS) up to 100% at the
// transition bar (barsRemaining = 0). Density and chaos additively boost
// toward 1.0 (clamped). Replaces normal density drift during fill bars so
// the build isn't fighting drift's pull toward bankSavedDensity.
function applyFillBuild(barsRemaining: number): void {
  const progress = (FILL_BARS - barsRemaining) / FILL_BARS;
  const store = useSequencerStore.getState();
  const fillDensity = Math.min(1, store.density + FILL_DENSITY_BOOST * progress);
  const fillChaos = Math.min(1, store.chaos + FILL_CHAOS_BOOST * progress);
  store.setMacros({ density: fillDensity, chaos: fillChaos });
}

export function resetConductor(): void {
  state.sceneStartStep = 0;
  state.dwellTargetBars = 0;
  state.lastActiveBank = null;
  state.lerpSource = null;
  state.lerpTarget = null;
  state.lerpBarsTotal = 0;
  state.lerpBarsElapsed = 0;
  state.densityNextDriftStep = 0;
  // Drift baseline + target re-initialize from the live store value the next
  // time the scene-change branch fires; no need to seed them here.
  // Wipe the display fields too so stale "X bars remaining" doesn't linger
  // after a stop or a fresh enable.
  const store = useSequencerStore.getState();
  store.setConductorDisplay(0, 0);
}

// Called from App.tsx's scheduler callback IMMEDIATELY BEFORE commitPendingBank().
// Snapshots the current (about-to-be-overwritten) macro values as the lerp
// source IFF a swap is pending AND conductor is enabled AND transitionBars > 0.
// On the next conductor.tickBar() (after the commit), the new bank's macros
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
    // Any leftover source from a previous bar (e.g. user disabled conductor
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
  // changes trigger a fresh dwell roll when conductor next acts. Doing this
  // even when disabled keeps state consistent if the user toggles on later.
  if (state.lastActiveBank !== activeBank) {
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

    // Capture this bank's saved density as the drift baseline. applyBankSlot
    // already wrote it to the store, so reading store.density gives us the
    // authoritative value. First drift target = baseline (no immediate
    // motion); first re-roll fires DRIFT_PERIOD_BARS into the scene so the
    // bank's saved density is heard cleanly before any drift kicks in.
    state.bankSavedDensity = store.density;
    state.densityDriftTarget = state.bankSavedDensity;
    state.densityNextDriftStep = globalStep + DRIFT_PERIOD_BARS * STEPS_PER_BAR;

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
      store.setConductorDisplay(state.dwellTargetBars, state.dwellTargetBars);
    }
    return;
  }

  // Advance an in-progress lerp regardless of enabled state. If the user
  // disabled the conductor mid-lerp, finishing the lerp is musically the
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
  // "conductor making decisions during a scene" gesture — anticipates the
  // upcoming swap by cranking density + chaos, then the swap itself snaps
  // density and lerp settles chaos back down into the new scene.
  const elapsedBars = Math.floor((globalStep - state.sceneStartStep) / STEPS_PER_BAR);
  const remaining = Math.max(0, state.dwellTargetBars - elapsedBars);

  if (sceneGraph.enabled) {
    // Fill build replaces drift during fill bars so the build's density
    // crank isn't fighting drift's pull toward bankSavedDensity. Outside
    // fill zone, drift runs normally.
    const inFillZone =
      remaining > 0 &&
      remaining <= FILL_BARS &&
      state.dwellTargetBars > FILL_BARS;
    if (inFillZone) {
      applyFillBuild(remaining);
    } else {
      applyDensityDrift(globalStep);
    }
  }

  if (!sceneGraph.enabled) return;
  // Something else queued a swap — don't fight it; let it land and we'll
  // reset on the bar it commits.
  if (pendingBank !== null) return;

  store.setConductorDisplay(remaining, state.dwellTargetBars);

  if (elapsedBars < state.dwellTargetBars) return;

  const next = pickNextBank(banks, activeBank);
  if (next === null) return;
  store.queueBank(next);
}

// Subscribe once at app mount. Two transitions reset the dwell timer:
//   - playing flips true → false: stop resets so resume rolls fresh dwell
//   - sceneGraph.enabled flips false → true: toggling on after a long disabled
//     stretch shouldn't fire an immediate transition based on stale elapsed
//     bars from a previous session.
// Tracking vars are updated BEFORE calling resetConductor — resetConductor
// writes the display fields back to the store, which re-fires this subscriber
// synchronously, which would otherwise see stale lastEnabled and recurse
// forever. Snapshot the deltas first, update tracking, THEN act.
export function initConductor(): void {
  if (subscribed) return;
  subscribed = true;
  const init = useSequencerStore.getState();
  lastEnabled = init.sceneGraph.enabled;
  lastPlaying = init.playing;
  useSequencerStore.subscribe((s) => {
    const stopJustPressed = lastPlaying && !s.playing;
    const enableJustFlipped = !lastEnabled && s.sceneGraph.enabled;
    lastEnabled = s.sceneGraph.enabled;
    lastPlaying = s.playing;
    if (stopJustPressed) resetConductor();
    if (enableJustFlipped) resetConductor();
  });
}
