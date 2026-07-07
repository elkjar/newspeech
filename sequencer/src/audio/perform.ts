// Perform mode — session-only punch-in FX layer (docs/perform-mode.md).
// P1: beat repeat. Module singleton owned by the dispatcher (same pattern as
// harmonic motion's cross-tick state): the keyboard arms/releases, the
// dispatcher anchors the window on the scheduler's tick grid once per tick,
// and runTick consumes the snapshot. Never persisted — perform state is
// live-performance state, same rule as the active bank/scene.

import { scheduler } from './scheduler';

export interface RepeatWindow {
  // Window length in global scheduler ticks (32nds). Sub-tick values
  // (0.5 / 0.25 / 0.125) are the roll/stutter territory.
  windowTicks: number;
  // Scene-space tick the remap starts applying — the first tick seen after
  // the key went down (unquantized; latency = the dispatch horizon only).
  engageScene: number;
  // Scene-space tick that was AUDIBLE at the keypress. The capture anchors
  // here, not at engage: the scheduler head runs ~250ms ahead of the ear, so
  // anchoring at engage catches a neighboring step, not the one the user
  // punched on. (v1 quantized engage UP to a future boundary and captured
  // backwards from it — in sparse patterns that looped not-yet-heard, often
  // empty windows: the "holding r drops the notes out" feel.)
  anchorScene: number;
  // Scene-space start of the captured window: the window CONTAINING the
  // anchor, snapped DOWN to the window grid — what was being heard at
  // punch-in, phase-locked to the bar.
  windowStartScene: number;
}

// Repeat-length ladder, longest first — the hardware's 16·8·4·2·1·1/2·1/4·
// 1/8·1/16 sequencer-step ladder (1 step = a 16th = 2 global ticks), mapped
// onto the number row 1..9 while the repeat key is held.
export const REPEAT_LADDER_TICKS = [32, 16, 8, 4, 2, 1, 0.5, 0.25, 0.125];
export const REPEAT_LADDER_LABELS = [
  '16',
  '8',
  '4',
  '2',
  '1',
  '1/2',
  '1/4',
  '1/8',
  '1/16',
];

interface PerformState {
  // Punch-in track mask. Empty = ALL tracks — the hardware's "no selection
  // means everything" default. P2 adds the track-select row in the PERFORM
  // tab; toggling every track off falls back to ALL rather than silence.
  trackMask: Set<string>;
  // Requested window length while the repeat key is held; null = released.
  heldTicks: number | null;
  anchored: RepeatWindow | null;
  // P2 punch FX — trigger-time transforms on masked tracks, hardware-style:
  // each effect has 4 configurable value SLOTS punched from the tab (the
  // Tracker's off + presets model). Reverse flips new triggers to reverse
  // one-shot (loopMode 4); tune offsets new-note pitch in semitones (ringing
  // notes unaffected — matches hardware); filter is an ABSOLUTE cutoff punch
  // (0..1 norm) riding the live per-track cutoff push, so it bends already-
  // sounding voices and restores the knob value on release.
  reverse: boolean;
  // Latched slot index per effect (null = off). Everything except repeat
  // (momentary) and reverse (single toggle) lives here.
  latched: Record<LatchedEffect, number | null>;
}

// The latching slot effects. tune/bits/scrub/chop/sat are trigger-time
// transforms (new notes only); filter/reverb/delay ride the live per-track
// DSP push (bend ringing voices).
export type LatchedEffect =
  | 'tune'
  | 'filter'
  | 'bits'
  | 'scrub'
  | 'chop'
  | 'sat'
  | 'reverb'
  | 'delay';

const state: PerformState = {
  trackMask: new Set(),
  heldTicks: null,
  anchored: null,
  reverse: false,
  latched: {
    tune: null,
    filter: null,
    bits: null,
    scrub: null,
    chop: null,
    sat: null,
    reverb: null,
    delay: null,
  },
};

// ---- Slot values (config, not engagement) ----------------------------------
// The VALUES are rig config — they persist like MIDI mappings. Which slot is
// engaged stays session-only like everything else here.

export interface PerformSlotValues {
  repeat: number[]; // 4 ladder indices into REPEAT_LADDER_TICKS
  tune: number[]; // 4 semitone offsets, int -12..+12
  filter: number[]; // 4 absolute cutoff positions, 0..100
  bits: number[]; // 4 bit depths, int 4..16 (16 = engine bypass)
  scrub: number[]; // 4 sample-start scrub depths, 0..100 (% of trim window)
  chop: number[]; // 4 forced gate lengths, 0..100 (% of step)
  sat: number[]; // 4 saturation drives, 0..100 (tanh crushes past 50)
  reverb: number[]; // 4 absolute reverb-send positions, 0..100
  delay: number[]; // 4 absolute delay-send positions, 0..100
}

const LS_SLOTS = 'newspeech.sequencer.performSlots';

// Defaults per Chris's punch set: repeat 1 · 1/4 · 2 · 1/8, filter 20/60/10/90.
const DEFAULT_SLOTS: PerformSlotValues = {
  repeat: [4, 6, 3, 7],
  tune: [-12, -5, 7, 12],
  filter: [20, 60, 10, 90],
  bits: [4, 3, 2, 1],
  scrub: [25, 50, 75, 100],
  chop: [5, 15, 30, 60],
  sat: [30, 50, 75, 100],
  reverb: [25, 50, 75, 100],
  delay: [25, 50, 75, 100],
};

// Persisted-slots schema version. v2 = the bits column reset to the 4·3·2·1
// destruction ladder — every bits value stored before the engine's crush
// floor dropped 4→1 (2026-07-07) was assigned against a range where
// everything above 4 bits is imperceptible, so v1 bits (default OR
// hand-assigned) are stale by construction. Other columns carry over.
const SLOTS_VERSION = 2;

function loadSlots(): PerformSlotValues {
  try {
    const raw = localStorage.getItem(LS_SLOTS);
    if (!raw) return { ...DEFAULT_SLOTS };
    const parsed = JSON.parse(raw) as Partial<PerformSlotValues> & {
      v?: number;
    };
    const four = (v: unknown, fallback: number[]) =>
      Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number')
        ? (v as number[])
        : fallback;
    if ((parsed.v ?? 1) < 2) {
      parsed.bits = DEFAULT_SLOTS.bits;
    }
    const loaded = {
      repeat: four(parsed.repeat, DEFAULT_SLOTS.repeat),
      tune: four(parsed.tune, DEFAULT_SLOTS.tune),
      filter: four(parsed.filter, DEFAULT_SLOTS.filter),
      bits: four(parsed.bits, DEFAULT_SLOTS.bits),
      scrub: four(parsed.scrub, DEFAULT_SLOTS.scrub),
      chop: four(parsed.chop, DEFAULT_SLOTS.chop),
      sat: four(parsed.sat, DEFAULT_SLOTS.sat),
      reverb: four(parsed.reverb, DEFAULT_SLOTS.reverb),
      delay: four(parsed.delay, DEFAULT_SLOTS.delay),
    };
    if ((parsed.v ?? 1) < SLOTS_VERSION) saveSlots(loaded);
    return loaded;
  } catch {
    return { ...DEFAULT_SLOTS };
  }
}

function saveSlots(v: PerformSlotValues) {
  try {
    localStorage.setItem(LS_SLOTS, JSON.stringify({ v: SLOTS_VERSION, ...v }));
  } catch {
    // storage full/unavailable — values still apply for the session
  }
}

const slots: PerformSlotValues = loadSlots();

export function slotValues(): PerformSlotValues {
  return slots;
}

// Wheel-edit a slot's value in place. Engaged slots read live, so editing an
// active punch retunes it on the next trigger (filter: next rAF frame).
export function nudgeSlotValue(
  effect: keyof PerformSlotValues,
  index: number,
  dir: 1 | -1,
) {
  const cur = slots[effect][index];
  let next = cur;
  if (effect === 'repeat') {
    next = Math.max(0, Math.min(REPEAT_LADDER_TICKS.length - 1, cur + dir));
  } else if (effect === 'tune') {
    next = Math.max(-12, Math.min(12, cur + dir));
  } else if (effect === 'bits') {
    // Floor 1 — the engine crushes to 2^(bits-1) levels, so 2 = five
    // levels and 1 = full square. The destruction end is the point.
    next = Math.max(1, Math.min(16, cur + dir));
  } else {
    // filter / reverb / delay — 0..100 position, 5 per step
    next = Math.max(0, Math.min(100, cur + dir * 5));
  }
  if (next === cur) return;
  slots[effect][index] = next;
  saveSlots(slots);
  notify();
}

// Last-used ladder position — a bare hold re-engages the previous length.
let ladderIndex = 3; // 2 steps

// Re-anchor guards: scene swaps invalidate scene-space window coords, and a
// transport restart winds sceneStep back below the stale anchor.
let lastSceneStart: number | null = null;
let lastSceneStep = -1;

const listeners = new Set<() => void>();
// Monotonic change counter — the PERFORM tab's useSyncExternalStore snapshot
// (primitive, so any state edge re-renders the panel which then reads the
// getters below).
let version = 0;
function notify() {
  version++;
  for (const l of listeners) l();
}

export function performVersion(): number {
  return version;
}

// Punch-edge hook — installed by the App dispatcher. Fires on every state
// edge (arm, length switch mid-hold, release) AFTER the state change, so the
// dispatcher can flush the queued trigger horizon and re-emit it under the
// new perform state (this is what makes engage/release feel immediate
// instead of ~250ms late).
let edgeHandler: (() => void) | null = null;
export function setPerformEdgeHandler(fn: (() => void) | null) {
  edgeHandler = fn;
}

export function subscribePerform(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// null when released; the engaged window length in ticks while held — the
// PERFORM tab lights whichever slot (or keyboard ladder value) matches.
export function repeatHeldTicks(): number | null {
  return state.heldTicks;
}

export function repeatHeld(): boolean {
  return state.heldTicks !== null;
}

// Audible global step at the moment of the (latest) arm — the capture
// anchor. null = transport wasn't producing audible steps; fall back to the
// engage tick.
let armAudibleGlobal: number | null = null;

export function armRepeat(index?: number) {
  if (index !== undefined) {
    ladderIndex = Math.max(0, Math.min(REPEAT_LADDER_TICKS.length - 1, index));
  }
  const ticks = REPEAT_LADDER_TICKS[ladderIndex];
  if (state.heldTicks === ticks) return;
  // Catch what the ear is on RIGHT NOW — also on a length switch mid-hold,
  // so re-arming captures the currently-sounding window, not the original.
  armAudibleGlobal = scheduler.getAudibleStep();
  state.heldTicks = ticks;
  state.anchored = null;
  notify();
  edgeHandler?.();
}

export function releaseRepeat() {
  if (state.heldTicks === null) return;
  state.heldTicks = null;
  state.anchored = null;
  notify();
  edgeHandler?.();
}

export function isTrackMasked(trackId: string): boolean {
  return state.trackMask.size === 0 || state.trackMask.has(trackId);
}

// ---- P2: track mask + reverse / tune / filter ------------------------------
//
// Punch-edge rule: the flush-and-redispatch edge is only safe while a repeat
// is engaged — replay ticks never advance mutation counters, so re-running
// them is idempotent. Normal ticks DID advance on first dispatch; re-running
// those would re-roll dice and double-advance accumulators. So mask/reverse
// edges fire the handler only under an engaged repeat (where immediacy
// matters most — the repeat+reverse combo); otherwise the change rides the
// next scheduled tick (~250ms horizon worst case). Tune/filter are
// continuous sweeps — no edge, the horizon is imperceptible mid-gesture.

function edgeIfRepeating() {
  if (state.heldTicks !== null) edgeHandler?.();
}

export function toggleTrackMask(trackId: string) {
  if (state.trackMask.has(trackId)) state.trackMask.delete(trackId);
  else state.trackMask.add(trackId);
  notify();
  edgeIfRepeating();
}

export function clearTrackMask() {
  if (state.trackMask.size === 0) return;
  state.trackMask.clear();
  notify();
  edgeIfRepeating();
}

export function trackMaskHas(trackId: string): boolean {
  return state.trackMask.has(trackId);
}

export function trackMaskEmpty(): boolean {
  return state.trackMask.size === 0;
}

export function toggleReverse() {
  state.reverse = !state.reverse;
  notify();
  edgeIfRepeating();
}

export function reverseOn(): boolean {
  return state.reverse;
}

// Latch a slot — punching the engaged slot again releases it (back to off),
// matching the hardware's off + presets rows.
export function punchSlot(effect: LatchedEffect, index: number) {
  state.latched[effect] = state.latched[effect] === index ? null : index;
  notify();
}

export function activeSlot(effect: LatchedEffect): number | null {
  return state.latched[effect];
}

// Dispatch-time reads — applied per trigger in the App dispatcher.
export function performReverse(trackId: string): boolean {
  return state.reverse && isTrackMasked(trackId);
}

// Latched slot value for a masked track, or null when the effect is off /
// the track is outside the mask.
function latchedValue(effect: LatchedEffect, trackId: string): number | null {
  const idx = state.latched[effect];
  if (idx === null || !isTrackMasked(trackId)) return null;
  return slots[effect][idx];
}

// Playback-rate multiplier for new notes on masked tracks (1 = neutral).
export function performTuneRatio(trackId: string): number {
  const semis = latchedValue('tune', trackId);
  return semis === null || semis === 0 ? 1 : Math.pow(2, semis / 12);
}

// Absolute cutoff-norm override for masked tracks (null = no punch — the
// track's own knob value stands). Consumed by the rAF filter push in
// App.tsx, so it also bends already-ringing voices and self-restores.
export function performFilterCutoff(trackId: string): number | null {
  const v = latchedValue('filter', trackId);
  return v === null ? null : v / 100;
}

// Bit-depth punch for masked tracks (null = no punch). The dispatcher takes
// min(voice bits, slot bits) — a punch only ever deepens the crush; it never
// cleans up a voice authored crunchier than the slot.
export function performBitDepth(trackId: string): number | null {
  return latchedValue('bits', trackId);
}

// Sample-start scrub depth 0..1 (null = off). The dispatcher dices a random
// start offset within [0, depth] of the voice's trim window PER TRIGGER —
// every hit fires from a different position into the sample.
export function performScrubDepth(trackId: string): number | null {
  const v = latchedValue('scrub', trackId);
  return v === null ? null : v / 100;
}

// Forced gate fraction 0..1 of the step (null = off). The dispatcher
// replaces the voice's envelope with a snappy synthetic one holding for
// this fraction — everything masked turns staccato regardless of authored
// length. 0 is a bare click (broken range on purpose).
export function performChopGate(trackId: string): number | null {
  const v = latchedValue('chop', trackId);
  return v === null ? null : v / 100;
}

// Saturation-drive punch 0..1 (null = off). The dispatcher takes
// max(voice drive, slot drive) — same only-adds-dirt rule as bits; the
// tanh stage crushes past 0.5, so the top slots are proper destruction.
// New notes only (replaced the smear timing punch 2026-07-07 — no musical
// use found in practice).
export function performSaturation(trackId: string): number | null {
  const v = latchedValue('sat', trackId);
  return v === null ? null : v / 100;
}

// Absolute reverb/delay-send overrides for masked tracks (null = no punch —
// the voice's own send stands). Same live path as the filter punch (the rAF
// setTrackFiltersBulk push), so a punch throws already-ringing voices into
// the bus and self-restores on release.
export function performReverbSend(trackId: string): number | null {
  const v = latchedValue('reverb', trackId);
  return v === null ? null : v / 100;
}

export function performDelaySend(trackId: string): number | null {
  const v = latchedValue('delay', trackId);
  return v === null ? null : v / 100;
}

// Dispatcher hook — called once per scheduler tick BEFORE runTick. Anchors a
// pending punch-in on the first tick it sees after the key goes down: engage
// there, capturing the grid-snapped window that contains it. Release is
// unquantized too (state simply clears) — the real step counter kept
// advancing underneath, so playback resumes exactly in-position.
export function performRepeatForTick(
  sceneStep: number,
  sceneStartStep: number,
): RepeatWindow | null {
  if (sceneStartStep !== lastSceneStart || sceneStep < lastSceneStep) {
    lastSceneStart = sceneStartStep;
    state.anchored = null;
  }
  lastSceneStep = sceneStep;
  if (state.heldTicks === null) return null;
  if (state.anchored === null) {
    const w = state.heldTicks;
    const anchorScene = Math.min(
      sceneStep,
      Math.max(
        0,
        armAudibleGlobal !== null ? armAudibleGlobal - sceneStartStep : sceneStep,
      ),
    );
    state.anchored = {
      windowTicks: w,
      engageScene: sceneStep,
      anchorScene,
      // Sub-tick windows have no coarser grid to snap to — the "window" is
      // the anchor tick itself (the stutter capture reads the row step
      // containing it).
      windowStartScene: w >= 1 ? Math.floor(anchorScene / w) * w : anchorScene,
    };
  }
  return state.anchored;
}

// Dev: the dispatcher + keyboard handlers capture these functions at mount, so
// HMR can't hot-swap the module in the running loop — force a full reload on
// change, matching engine/tick.ts. No-op in production.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
