import {
  useSequencerStore,
  type BankSlot,
  type BankMacros,
  type BankOrderMode,
  type Scene,
  type Song,
  type SceneShape,
} from '../state/store';
import { scheduler } from '../audio/scheduler';
import { fadeTextures } from '../audio/nativeEngine';
import { endArrangementPlayback } from '../audio/transport';
import { RECIPE_DWELL } from './generator';
import { targetEntropy, phaseAt } from './shape';

// How long outgoing texture voices ring down across a song transition —
// matches transport.ts's stop fade so the gesture is consistent. The
// outgoing song's textures fade over the first SONG_FADE_SECS of the new
// song. Kept here (not imported) to avoid a transport.ts ↔ ghost.ts cycle.
const SONG_FADE_SECS = 6;

// Ghost v1.5 — autonomous walker across populated banks, color-macro lerp
// on transitions, and probabilistic mid-scene density fills.
//
// Density is treated differently from the four "color" macros (chaos / motion
// / drift / tension): it's a pattern-tuning lens whose meaningful value is
// tightly coupled to the authored ON/OFF distribution of each bank. Lerping
// it across a swap means applying one pattern's density tuning to another
// pattern's structure, which produces the "out of control" feeling when banks
// have very different authored densities. So density SNAPS with the bank at
// the swap (atomic, same as the rest of bank state), and ghost only
// modulates it via fill gestures — never a sustained drift baseline.
// Between fills, density sits exactly at the bank's saved value.
//
// Color macros still lerp from previous bank's effective values to new
// bank's saved values over `transitionBars` bars at scene entry.
//
// Per-bank weighted edges + per-bank durations are still the next pass.

// Bar resolution lives in the scheduler — 32 globalSteps per 4/4 bar at 32nd
// granularity. Kept local to the ghost rather than imported to avoid a
// cycle through the scheduler module.
const STEPS_PER_BAR = 32;

// Resting density — the value ghost holds between gestures and settles back to.
// 0.5 is the bipolar neutral in macros.ts ("pattern as authored"; below thins,
// above fills), so fills depart UP from 0.5 into fill territory and always
// return to 0.5. There is no longer a per-pattern density baseline (macros went
// global on 2026-05-29; bank swaps no longer restore density), so this flat
// value is the resting point for everything. Capturing store.density as the
// baseline (the old behavior) ratcheted upward forever, because each
// pre-transition build inflated store.density just before the swap captured it —
// density crept up and never came back down.
const RESTING_DENSITY = 0.5;

// Mid-scene fill — short density gesture fired probabilistically during
// the scene. Each spike is 1 bar at +MID_FILL_BOOST above RESTING_DENSITY,
// then resolves back to the resting value. The arc envelope is expressed via
// FREQUENCY of these gestures, not a sustained shift.
//
// 2026-05-24 — heavy tone-down per user listening notes ("ghost is too
// heavy-handed with density"). Spike magnitude + base rate both cut so
// density mostly sits at the resting value with small occasional gestures;
// the other macros (chaos, motion, drift, tension) carry the variation.
//
// Probability per bar = BASE + shape_intensity * SHAPE_BONUS. BASE > 0
// because Chris's hand-played patterns get fills CONSTANTLY across all
// scene phases — that's the lifeblood, not a climax-only thing. With the
// lower values, fills land roughly every ~10–14 bars in flat sections
// and ~5 bars at arc peaks.
const MID_FILL_BARS = 1;
const MID_FILL_BOOST = 0.05;
const BASE_FILL_PROB_PER_BAR = 0.08;
const SHAPE_FILL_PROB_BONUS = 0.12;

// Per-frame smoothing factor for the RAF density smoother. At 60fps a value
// of 0.06 reaches ~85% of the target in ~30 frames (~0.5s) — feels like a
// hand turning a knob, not a step jump.
const DENSITY_SMOOTH_PER_FRAME = 0.06;

// Pre-transition fill constants. In the last FILL_BARS of a scene's dwell,
// the ghost replaces normal density drift with a build curve that cranks
// density + chaos toward higher values — producer-natural "fill" gesture
// signaling change is coming. Boosts are additive on top of current values
// (clamped to 1.0), peak at the transition bar, then snap with the bank swap
// (density) or descend via macro lerp (chaos) into the new scene.
//
// Density boost is intentionally modest. 2026-05-20: 0.5 → 0.20.
// 2026-05-24: 0.20 → 0.10 alongside the heavy mid-fill tone-down — the
// pre-transition fill should signal change is coming without crowding
// the existing pattern, and the surrounding macros (chaos, motion) carry
// most of the build feel.
const FILL_BARS = 2;
const FILL_DENSITY_BOOST = 0.1;
const FILL_CHAOS_BOOST = 0.25;

// Ghost-driven lead melodic development (Phase 1, 2026-05-26; opened to FULL
// range 2026-05-27). Ghost adds an arc-shaped amount to LEAD tracks' mutation-
// tree depth (treePos) — autonomous melodic variation Ghost couldn't reach
// before (it only ever rearranged / filled / lerped macros, never developed a
// melody). Spans the FULL parameter across the arc: ~0 at the edges → full at
// the peak. The mutation control's OWN guardrails (density-conserving moves, no
// phantom ties, grid-weighted placement, depth-staged forks) keep it musical
// even maxed — so unlike density it needs no low ceiling. ADDITIVE in the engine
// (rides on the user's manual mutation / LFO); held at 0 when ghost is disabled.
const GHOST_LEAD_MUT_BASE = 0; // floor in all phases (0 = clean at arc edges; raise for constant melodic life)
const GHOST_LEAD_MUT_CEILING = 1; // arc peak — full mutation depth (the control self-guardrails)

// STAGGERED per-lead spotlight (Phase 1.5, 2026-05-27). Rather than one global
// amount applied to every lead in lockstep, each lead's ghost mutation is its
// own arc-scaled envelope on a phase-offset cycle — so development ROTATES voice
// to voice (one lead climbs while another rests): an arranger's call-and-
// response rather than everyone moving together. Periods are coprime-ish primes
// so the rotation drifts and never exactly repeats ([[feedback-intersecting-systems]]).
const SPOTLIGHT_PERIODS_BARS = [11, 13, 17, 19];

// Per-track value, recomputed each bar by tickBar; getGhostLeadMutation reads it.
const ghostLeadMut = new Map<string, number>();

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Per-lead spotlight in [0,1]: a smooth raised-cosine swell whose period + phase
// are derived from the trackId, so each lead peaks at a different time.
function staggerSpotlight(trackId: string, barTime: number): number {
  const h = hashStr(trackId);
  const period = SPOTLIGHT_PERIODS_BARS[h % SPOTLIGHT_PERIODS_BARS.length];
  const offset = ((h >>> 8) % 1024) / 1024;
  const phase = (barTime / period + offset) % 1;
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * phase);
}

// Read by App.tsx into the engine's TickInputs each tick, per track. The engine
// adds it to that lead's treePos (inside the useTree branch — leads only).
export function getGhostLeadMutation(trackId: string): number {
  return ghostLeadMut.get(trackId) ?? 0;
}

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
  // Density gesture state — independent of the color-macro lerp. The resting
  // value is the module-level RESTING_DENSITY (0.5 = bipolar neutral), not a captured per-bank
  // baseline, so only the live target + in-flight fill state live here.
  //   densityTarget — the actual destination the RAF smoother chases
  //   midFillBarsLeft — >0 while a mid-scene fill is in progress; the
  //                     per-bar tick decrements; pre-transition fill
  //                     cancels any active mid-fill on entry
  densityTarget: number;
  midFillBarsLeft: number;
  // The user's chaos value captured at pre-transition fill-zone entry, before
  // the build boosts it. The boost rides on THIS (not the live store value, which
  // would compound), and the swap's lerp settles chaos back down to it — so the
  // build is a self-reverting gesture instead of a permanent climb. null = no
  // fill build active. (Banks no longer carry macros since 2026-05-29, so the
  // lerp has no per-bank chaos to settle toward; this is that target.)
  chaosBeforeFill: number | null;
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
  densityTarget: RESTING_DENSITY,
  midFillBarsLeft: 0,
  chaosBeforeFill: null,
  lastEntropySign: 1,
};

let lastEnabled = false;
let lastPlaying = false;
let lastShape: SceneShape = 'arc';
let unsubscribe: (() => void) | null = null;

// User-input override: when the user touches density (knob, MIDI CC, etc.)
// the ghost's per-frame density smoother goes quiet for this many bars.
// `tickDensity` (per-bar) keeps planning the target so the resume catches
// up to whatever ghost would have wanted; only the per-frame WRITE pauses,
// so the user holds whatever they dialled in until the window expires.
const DENSITY_OVERRIDE_BARS = 2;
let userDensityOverrideBars = 0;

export function noteDensityUserInput(): void {
  userDensityOverrideBars = DENSITY_OVERRIDE_BARS;
}

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

// Sequence-mode picker: walk filled scene-kind banks in slot order,
// wrapping past the end. Skips empty slots and transitions. Same-recipe
// avoidance + entropy weighting are bypassed — user's slot order IS the
// authored intent.
function pickSequenceNextBank(
  banks: (BankSlot | null)[],
  currentBank: number | null
): number | null {
  const start = (currentBank ?? -1) + 1;
  for (let i = start; i < banks.length; i++) {
    const slot = banks[i];
    if (slot && slot.kind !== 'transition') return i;
  }
  for (let i = 0; i < start; i++) {
    const slot = banks[i];
    if (slot && slot.kind !== 'transition' && i !== currentBank) return i;
  }
  return null;
}

function pickNextBank(
  banks: (BankSlot | null)[],
  currentBank: number | null,
  shape: SceneShape,
  phaseLength: number,
  globalStep: number,
  compositionStartStep: number,
  lastEntropySign: number,
  bankOrderMode: BankOrderMode
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

  // Sequence mode short-circuits all entropy + shape logic. We still push
  // an auto log entry so the event log shows the pick — synthetic target
  // = pickedEntropy so the delta column reads 0.
  if (bankOrderMode === 'sequence') {
    const winner = pickSequenceNextBank(banks, currentBank);
    if (winner === null) return null;
    const winnerEntropy = bankEntropy(banks[winner]);
    useSequencerStore.getState().pushGhostPickEvent({
      kind: 'auto',
      globalStep,
      slot: winner,
      shape,
      phase: 0,
      target: winnerEntropy,
      pickedEntropy: winnerEntropy,
      deltaFromTarget: 0,
      candidateCount: populated.length,
    });
    return winner;
  }

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
    voicing: s.voicing,
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

// Mid-scene fill — short density spike that resolves back to the bank's
// saved density. The progress ramps 0..1 across the fill's bars (clamped
// if MID_FILL_BARS=1). Writes density directly to the store; the
// per-frame smoother that used to glide between values was removed
// (RAF pile-up under HMR was killing UI responsiveness).
function applyMidFill(): void {
  const elapsed = MID_FILL_BARS - state.midFillBarsLeft;
  const progress =
    MID_FILL_BARS <= 1 ? 1 : elapsed / (MID_FILL_BARS - 1);
  state.densityTarget = Math.max(
    0,
    Math.min(1, RESTING_DENSITY + MID_FILL_BOOST * progress)
  );
}

// Fill build — applies in the last FILL_BARS of a scene's dwell. Linear ramp:
// 0% boost at fill-zone entry (barsRemaining = FILL_BARS) up to 100% at the
// transition bar (barsRemaining = 0). Replaces normal density drift during
// fill bars so the build's crank isn't fighting the pull back toward
// RESTING_DENSITY. Chaos is not smoothed — fill is short (2 bars) and
// chaos is visually less tied to the knob feel; if it becomes objectionable
// we'll route it through the same smoother pattern.
function applyFillBuild(barsRemaining: number): void {
  const progress = (FILL_BARS - barsRemaining) / FILL_BARS;
  const store = useSequencerStore.getState();
  state.densityTarget = Math.max(
    0,
    Math.min(1, RESTING_DENSITY + FILL_DENSITY_BOOST * progress)
  );
  // Capture the user's chaos once at fill-zone entry, then boost FROM that
  // baseline — reading store.chaos each bar would compound the boost (the prior
  // bar already wrote a boosted value back). The swap restores chaos to this
  // baseline (see tickBar), so the build is a temporary climb, not a ratchet.
  if (state.chaosBeforeFill === null) state.chaosBeforeFill = store.chaos;
  const fillChaos = Math.min(1, state.chaosBeforeFill + FILL_CHAOS_BOOST * progress);
  store.setMacros({ chaos: fillChaos });
}

// Per-bar density dispatcher. Pre-transition fill takes priority; otherwise
// mid-fill continues if in progress; otherwise roll for a new mid-fill
// (probability = BASE + shape_intensity * BONUS). When no fill is active,
// density rests at the bank's saved value — no drift baseline rides
// underneath.
function tickDensity(globalStep: number, inFillZone: boolean): void {
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

  // No fill in flight — settle back to the resting density (0.5, bipolar neutral).
  state.densityTarget = RESTING_DENSITY;
}

// Per-frame density smoother. Runs only while ghost is enabled + playing.
// Pulls store.density toward state.densityTarget at a fixed per-frame
// fraction, so density changes from fills feel like a knob being turned
// continuously rather than stepping at each bar boundary.
let densityRAF: number | null = null;
function densityTick(): void {
  const s = useSequencerStore.getState();
  if (!s.sceneGraph.enabled || !s.playing) {
    densityRAF = null;
    return;
  }
  if (userDensityOverrideBars <= 0) {
    const cur = s.density;
    const diff = state.densityTarget - cur;
    if (Math.abs(diff) > 0.0005) {
      s.setMacros({ density: cur + diff * DENSITY_SMOOTH_PER_FRAME });
    }
  }
  densityRAF = requestAnimationFrame(densityTick);
}

function ensureDensitySmootherRunning(): void {
  if (densityRAF !== null) return;
  densityRAF = requestAnimationFrame(densityTick);
}

// HMR cleanup. Without this, every reload of this module orphans the
// active RAF loop — the OLD densityTick keeps calling setMacros each
// frame against the same store, and the NEW module starts another RAF
// alongside. Two (or N) density writers fighting per frame; potential
// source of audio-thread pressure that compounds across edits.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (densityRAF !== null) {
      cancelAnimationFrame(densityRAF);
      densityRAF = null;
    }
  });
  // ghost.tickBar / getGhostLeadMutation are captured by the scheduler step
  // callback at mount, so HMR can't hot-swap them in the running loop. Force a
  // reload on change so ghost edits take effect. No-op in production.
  import.meta.hot.accept(() => window.location.reload());
}

export function resetGhost(): void {
  state.sceneStartStep = 0;
  state.dwellTargetBars = 0;
  state.lastActiveBank = null;
  state.lerpSource = null;
  state.lerpTarget = null;
  state.lerpBarsTotal = 0;
  state.lerpBarsElapsed = 0;
  state.midFillBarsLeft = 0;
  state.chaosBeforeFill = null; // drop any in-flight pre-transition build baseline
  ghostLeadMut.clear(); // drop ghost's lead-mutation contribution immediately on stop / re-enable
  // Sustain-mode direction memory: reset to +1 so the first move biases up
  // from the current bank (arbitrary but deterministic; flips on first swap).
  state.lastEntropySign = 1;
  // densityTarget re-initializes to RESTING_DENSITY below; the per-frame
  // smoother then glides store.density to the 0.5 neutral once playing.
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
  // Density target rests at the 0.5 neutral on enable; the per-frame smoother
  // glides store.density to it (no jerk) once playing. Fills set it again
  // on the next bar boundary.
  state.densityTarget = RESTING_DENSITY;
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

// Song-mode advance: when the current arrangement row's bar count has elapsed,
// move the cursor to the next row and engage its scene+bank (queued, commits
// next bar). Self-contained — reads elapsed from the row's cursorStartStep, so
// it works both on a fresh swap bar (elapsed 0 → only 1-bar rows advance) and
// on later bars (elapsed ≥ bars-1). No-op while a swap is already in flight.
function arrangementAdvance(
  store: ReturnType<typeof useSequencerStore.getState>,
  globalStep: number,
): void {
  const arr = store.arrangement;
  if (!arr.active || arr.rows.length === 0) return;
  if (store.pendingBank !== null || store.composition.pendingScene !== null) return;
  const row = arr.rows[arr.cursor] ?? arr.rows[0];
  const rowBars = Math.max(1, Math.floor(row.bars));
  const elapsed = Math.floor((globalStep - arr.cursorStartStep) / STEPS_PER_BAR);
  if (elapsed < rowBars - 1) return;
  let next = arr.cursor + 1;
  if (next >= arr.rows.length) {
    if (!arr.loop) {
      // End of song. Let the final row play its full `bars` (elapsed reaches
      // rowBars-1 = its last bar → return), then at the next boundary
      // (elapsed === rowBars) gate that bar's emission via pendingEnd and tear
      // down the transport. The stop is deferred: scheduler.stop() called
      // synchronously from inside its own tick loop corrupts the step counter.
      if (elapsed >= rowBars && !arr.pendingEnd) {
        store.setArrangementPendingEnd(true);
        queueMicrotask(endArrangementPlayback);
      }
      return;
    }
    next = 0;
  }
  const nextRow = arr.rows[next];
  store.setArrangementCursor(next, globalStep + STEPS_PER_BAR);
  store.engageArrangementTarget(nextRow.scene, nextRow.bank);
}

// Called every bar boundary from App.tsx's scheduler callback, AFTER
// commitPendingBank() has applied any queued swap for this bar. Reads current
// store state, may call queueBank() which becomes the *next* bar's swap.
export function tickBar(globalStep: number): void {
  // Decrement the user-input density override window every bar, regardless
  // of ghost enabled/disabled state. Otherwise toggling ghost off mid-window
  // would freeze the counter and the override would resume next session.
  if (userDensityOverrideBars > 0) userDensityOverrideBars--;
  const store = useSequencerStore.getState();
  const { sceneGraph, banks, activeBank, pendingBank } = store;

  // Per-lead staggered ghost mutation — recompute every bar (before the scene-
  // change early-return so it always tracks). Each track gets its own arc ×
  // spotlight envelope, so development rotates between leads. currentShapeIntensity
  // is the [0,1] arc curve (0 for sustain). Held empty (→ 0) when disabled.
  if (sceneGraph.enabled) {
    const intensity = currentShapeIntensity(globalStep);
    const barTime = globalStep / STEPS_PER_BAR;
    const span = GHOST_LEAD_MUT_CEILING - GHOST_LEAD_MUT_BASE;
    for (const t of store.tracks) {
      ghostLeadMut.set(
        t.id,
        GHOST_LEAD_MUT_BASE + intensity * staggerSpotlight(t.id, barTime) * span,
      );
    }
  } else {
    ghostLeadMut.clear();
  }

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
    //   1. Transition-kind banks: 1–2 bars (turnarounds/breaks, fixed).
    //   2. Scene-length-aware: when ghost is enabled and 2+ scene banks
    //      are filled, divide phaseLength by filled-bank count so banks
    //      get an even slice of the scene window (e.g. 4 banks × 64 bars
    //      → ~16 bars each). Small ±15% jitter keeps it from feeling
    //      metronomic. THIS is what makes the bank rotation feel sized
    //      to the scene.
    //   3. Recipe-tagged scene banks (no scene-length context): use
    //      RECIPE_DWELL[recipe] for musical-natural durations.
    //   4. Untagged scene banks (user-snapped): fall back to the global
    //      sceneGraph min/max as before.
    const activeSlot = activeBank !== null ? banks[activeBank] : null;
    const sceneBankCount = banks.filter(
      (b) => b !== null && b.kind !== 'transition'
    ).length;
    if (activeSlot?.dwellBars !== undefined && activeSlot.dwellBars > 0) {
      // Per-bank manual override — pin this bank to exactly this many
      // bars, ignoring scene-length / recipe / global defaults.
      state.dwellTargetBars = Math.max(1, Math.floor(activeSlot.dwellBars));
    } else if (activeSlot?.kind === 'transition') {
      state.dwellTargetBars = rollDwellBars(TRANSITION_DWELL_MIN, TRANSITION_DWELL_MAX);
    } else if (sceneGraph.enabled && sceneBankCount >= 2) {
      const target = Math.max(2, sceneGraph.phaseLength / sceneBankCount);
      const lo = Math.max(2, Math.round(target * 0.85));
      const hi = Math.max(lo, Math.round(target * 1.15));
      state.dwellTargetBars = rollDwellBars(lo, hi);
    } else if (activeSlot?.recipe && RECIPE_DWELL[activeSlot.recipe as keyof typeof RECIPE_DWELL]) {
      const range = RECIPE_DWELL[activeSlot.recipe as keyof typeof RECIPE_DWELL];
      state.dwellTargetBars = rollDwellBars(range.min, range.max);
    } else {
      state.dwellTargetBars = rollDwellBars(sceneGraph.minBars, sceneGraph.maxBars);
    }
    // Song mode owns duration: override the rolled dwell with the current
    // arrangement row's authored bar count, so the ghost's pre-transition fill
    // (below) aligns to the authored row boundary instead of a random dwell.
    if (store.arrangement.active && store.arrangement.rows.length > 0) {
      const row = store.arrangement.rows[store.arrangement.cursor];
      if (row) state.dwellTargetBars = Math.max(1, Math.floor(row.bars));
    }
    // Decorate the just-pushed log entry with the dwell decision. tickBar
    // fires AFTER applyBankSlot's manual push and AFTER pickNextBank's auto
    // push, so the most-recent entry is always the one we want to tag.
    if (activeBank !== null) {
      store.setDwellOnLastBankChange(activeBank, state.dwellTargetBars);
    }

    // Settle density back to the resting value (0.5 neutral) on every swap and
    // cancel any in-flight fill. Density is NOT re-captured from store.density
    // here: macros went global on 2026-05-29 (applyBankSlot no longer restores
    // density per bank), so store.density at swap time is the live value —
    // already inflated by this scene's pre-transition build. Capturing it
    // ratcheted the baseline up forever ("density stuck up ~40%, never comes
    // down"). There is no per-pattern baseline anymore; the resting value is a
    // flat 0.5 for all banks.
    state.densityTarget = RESTING_DENSITY;
    state.midFillBarsLeft = 0;

    // Chaos has the same hazard: the pre-transition build boosted store.chaos,
    // and with macros global the lerp's target (snapshotMacros below) is that
    // same boosted value — so chaos would never settle and would stack swap over
    // swap. Settle it back to the pre-build baseline instead: hand that to the
    // lerp as its chaos target when a transition lerp runs (so it ramps the build
    // back down), else restore it directly.
    const chaosRest = state.chaosBeforeFill;
    state.chaosBeforeFill = null;

    // Color-macro lerp setup. Only if beforeBarCommit captured a source on
    // this bar — that already gated on enabled + transitionBars > 0, so we
    // trust the presence of lerpSource as the green light.
    if (state.lerpSource) {
      state.lerpTarget = snapshotMacros(store);
      if (chaosRest !== null) state.lerpTarget.chaos = chaosRest;
      state.lerpBarsTotal = sceneGraph.transitionBars;
      state.lerpBarsElapsed = 0;
      // Apply step 0 immediately — overwrites the bank swap's macro write
      // with the source values, so the dispatch reading macros later in this
      // same scheduler callback sees the lerp's starting point rather than a
      // one-tick flash at the target.
      applyLerpStep();
    } else {
      // No transition lerp — restore the pre-build chaos immediately so the
      // build gesture doesn't persist into the next scene.
      if (chaosRest !== null) store.setMacros({ chaos: chaosRest });
      state.lerpTarget = null;
      state.lerpBarsTotal = 0;
      state.lerpBarsElapsed = 0;
    }

    if (sceneGraph.enabled) {
      store.setGhostDisplay(state.dwellTargetBars, state.dwellTargetBars);
    }
    // Song mode: this swap bar is consumed by the branch, so the main
    // arrangement block below won't see it — handle a 1-bar row's same-bar
    // advance here (arrangementAdvance no-ops for longer rows at elapsed 0).
    arrangementAdvance(store, globalStep);
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

  // Song mode (arrangement) owns bank/scene progression when active. Runs
  // regardless of ghost-enabled so a "locked song" advances deterministically
  // even with the ghost off; the ghost's per-bar performance work (lead
  // mutation + fills above) still runs when enabled. Only the bank/scene CHOICE
  // is taken over — we skip the autonomous pick + composition auto-advance below.
  if (store.arrangement.active && store.arrangement.rows.length > 0) {
    arrangementAdvance(store, globalStep);
    return; // arrangement owns progression — skip the ghost pick below
  }

  if (!sceneGraph.enabled) return;

  // Composition auto-advance fires every bar boundary, INDEPENDENTLY of
  // bank-pick state. Bank dwell and scene length are independent clocks —
  // if we gated this on the bank-pick path, a scene with only one filled
  // bank or with bank dwell that doesn't divide phaseLength would advance
  // late or never. Runs before the pendingBank / dwell-not-yet guards so
  // an in-flight bank queue doesn't suppress the scene swap.
  // If the composition advanced (next scene), swapped to the next song,
  // or stopped the set, bail — the store has changed under us and the
  // bank-pick below would operate on a stale snapshot.
  if (maybeAutoAdvanceScene(store, globalStep)) return;

  // Something else queued a swap — don't fight it; let it land and we'll
  // reset on the bar it commits.
  if (pendingBank !== null) return;

  store.setGhostDisplay(remaining, state.dwellTargetBars);

  // Fire the pick during the LAST bar of the dwell so queueBank → commit
  // (next bar boundary) lands exactly dwellTargetBars after the bank started.
  // Without the -1, dwell=8 plays 9 bars (queue fires at start of bar 9,
  // commits at start of bar 10).
  if (elapsedBars < state.dwellTargetBars - 1) return;

  const next = pickNextBank(
    banks,
    activeBank,
    sceneGraph.shape,
    sceneGraph.phaseLength,
    globalStep,
    store.ghostCompositionStartStep,
    state.lastEntropySign,
    sceneGraph.bankOrderMode
  );
  if (next === null) return;
  store.queueBank(next, 'auto');
}

function findNextScene(
  scenes: (Scene | null)[],
  fromIdx: number,
  endsAfterLast: boolean
): number | null {
  for (let i = fromIdx + 1; i < scenes.length; i++) {
    if (scenes[i] !== null) return i;
  }
  if (endsAfterLast) return null;
  for (let i = 0; i < fromIdx; i++) {
    if (scenes[i] !== null) return i;
  }
  return null;
}

// Next filled song slot after `fromIdx`, no wrap — the set has a defined
// ending (stop after the last filled song) rather than looping. A
// set-loop toggle could relax this later.
function findNextSong(
  songs: (Song | null)[],
  fromIdx: number
): number | null {
  for (let i = fromIdx + 1; i < songs.length; i++) {
    if (songs[i] !== null) return i;
  }
  return null;
}

// Returns true if it changed the store (advanced a scene, swapped songs,
// or stopped) — the caller must then bail rather than continue acting on
// its now-stale snapshot.
function maybeAutoAdvanceScene(
  store: ReturnType<typeof useSequencerStore.getState>,
  globalStep: number
): boolean {
  const { composition, sceneGraph, performance } = store;
  if (composition.activeScene === null) return false;
  if (composition.pendingScene !== null) return false;
  const filled = composition.scenes.filter((s) => s !== null).length;
  if (filled === 0) return false;

  // Is this composition sitting in a performance with a further song to
  // play? If so, the SET is the loop unit — composition end advances the
  // song even for a single-scene / !endsAfterLast song (which would
  // otherwise loop in place forever and never reach the next song).
  const nextSong =
    performance.activeSong !== null && performance.pendingSong === null
      ? findNextSong(performance.songs, performance.activeSong)
      : null;

  // A solo, looping (!endsAfterLast) scene with no next song just plays
  // continuously — nothing to advance to, and re-loading it every
  // phaseLength would pointlessly re-trigger its macros.
  if (filled === 1 && !composition.endsAfterLast && nextSong === null) {
    return false;
  }

  const elapsed = Math.floor(
    (globalStep - store.ghostCompositionStartStep) / STEPS_PER_BAR
  );
  if (elapsed < sceneGraph.phaseLength - 1) return false;

  // More scenes left in this composition? (no-wrap detection.)
  const nextScene = findNextScene(composition.scenes, composition.activeScene, true);
  if (nextScene !== null) {
    store.loadScene(nextScene, 'ghost');
    return true;
  }

  // Composition's last scene just finished its arc.
  //
  // Priority 1 — performance set: hand directly to the next filled song.
  // Immediate atomic swap (no tail-out gap, per the "shift directly" feel
  // Chris wants); the outgoing song's texture voices ring down over the
  // new song via fadeTextures, so the transition bridges on the textural
  // layer rather than a silent gap.
  if (nextSong !== null) {
    void fadeTextures(SONG_FADE_SECS);
    store.swapSongImmediate(nextSong, globalStep);
    return true;
  }

  // Priority 2 — standalone composition (or last song in the set) with a
  // defined ending: stop. Scheduler needs an explicit halt alongside the
  // store flag because it runs its own loop.
  if (composition.endsAfterLast) {
    store.setPlaying(false);
    scheduler.stop();
    return true;
  }

  // Priority 3 — no defined ending and no next song: loop the composition
  // back to its first scene.
  const wrapScene = findNextScene(composition.scenes, composition.activeScene, false);
  if (wrapScene !== null && wrapScene !== composition.activeScene) {
    store.loadScene(wrapScene, 'ghost');
    return true;
  }
  return false;
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
  if (unsubscribe) return;
  const init = useSequencerStore.getState();
  lastEnabled = init.sceneGraph.enabled;
  lastPlaying = init.playing;
  lastShape = init.sceneGraph.shape;
  unsubscribe = useSequencerStore.subscribe((s) => {
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

// HMR cleanup — without this, every dev-mode reload of ghost.ts stacks a
// new zustand subscriber on top of the previous one (zustand has no idea
// the module was replaced). See [[reference-zustand-hmr-subscriber]].
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
    if (densityRAF !== null) {
      cancelAnimationFrame(densityRAF);
      densityRAF = null;
    }
  });
}
