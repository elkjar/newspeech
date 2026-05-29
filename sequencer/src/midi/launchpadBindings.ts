// Wire two Launchpad X surfaces to the sequencer store in a "width" layout:
// the pair shows ONE section's 8 tracks across the full 16 steps —
//   left pad  = steps  1..8   (cols → abs steps 0..7)
//   right pad = steps  9..16  (cols → abs steps 8..15)
// The drum/melodic section is shared between both pads (toggle on the side
// rail). This replaces the single-pad quadrant fold: there are no quadrants,
// just a section and the full step width spread across two grids.
//
// Top rows = bank select, split across the pair:
//   left pad  top → banks 1..8   (slots 0..7)
//   right pad top → banks 9..16  (slots 8..15)
//
// Side rails are SYMMETRIC — the same controls on both pads so transport is
// reachable from whichever grid your hand is near (top→bottom):
//   [0] play/pause   [1] panic   [2] section toggle   [3] swap L/R devices
//   [4] ·  [5] ·     [6] pitch up   [7] pitch down
//
// Device assignment is by enumeration order (device 0 = left, 1 = right);
// `swapped` flips that mapping (persisted) for when the units come up
// reversed. With a single Launchpad connected, swap is ignored and the lone
// device acts as the left half (steps 1..8).
//
// Each row's playhead is computed from that track's own rate + length + the
// scene start offset (mirrors Track.tsx), so polyrhythmic / odd-meter / non-
// 1/16-rate rows light independently across the full 16-step span.

import { invoke } from '@tauri-apps/api/core';
import { useSequencerStore, RATE_STRIDE, type Track, type TrackSection } from '../state/store';
import { scheduler } from '../audio/scheduler';
import { togglePlayback } from '../audio/transport';
import {
  bulkRedraw,
  getConnectedCount,
  onLaunchpadConnectionChange,
  onLaunchpadEvent,
  setPadColor,
  setSideColor,
  setTopColor,
  setTopPulse,
  type LaunchpadEvent,
} from './launchpad';

// Monochrome white levels (0..127). Launchpad output is RGB SysEx with
// (level, level, level) so the surface matches the app's monochrome look.
// State separation is by brightness alone; no hue.
const COL_OFF = 0;
const COL_HELD = 10; // very dim — held continuation at rest
const COL_PLAY_OFF = 28; // dim — playhead over empty step
const COL_STEP_ON = 100; // medium-bright — step at rest (normal or tied source)
const COL_HELD_PH = 96; // brighter — playhead over held continuation
const COL_PLAY_HIT = 127; // brightest — playhead over on step
const COL_TIE_SOURCE = COL_STEP_ON; // tied sources read as normal on; held continuations differentiate the chain
const COL_TIE_HELD = COL_HELD;
const COL_TIE_HELD_PH = COL_HELD_PH;
const COL_PLAY_PLAYING = 96;
const COL_PLAY_STOPPED = 12;
const COL_PANIC = 50;
const COL_PITCH_READY = 96;
const COL_PITCH_IDLE = 12;
// Section toggle reflects the live section (so you can read state off the
// pad): bright = melodic, dim = drum. Swap shows brighter when engaged.
const COL_SECTION_MELODIC = 96;
const COL_SECTION_DRUM = 28;
const COL_SWAP_ON = 96;
const COL_SWAP_OFF = 12;
// Bank slot brightness ladder for the top row. Pending uses palette-pulse
// (animation) as its differentiator from active rather than a brightness
// step, so the active slot can sit at max-bright 127 without being outranked.
const COL_BANK_EMPTY = 0;
const COL_BANK_POPULATED = 25;
const COL_BANK_ACTIVE = 127;
const COL_BANK_PENDING_PALETTE = 3; // palette index 3 = bright white

const SURFACE_SIZE = 80;
const STEP_WIDTH = 16; // total step columns across the pair
const PITCH_MIN = -36;
const PITCH_MAX = 36;
const SWAP_KEY = 'newspeech.launchpad.swapped';

// ---------- device ↔ logical-half mapping ----------
// logical half 0 = left (steps 0..7), 1 = right (steps 8..15).
let swapped = loadSwapped();

function loadSwapped(): boolean {
  try {
    return localStorage.getItem(SWAP_KEY) === '1';
  } catch {
    return false;
  }
}
function persistSwapped(): void {
  try {
    localStorage.setItem(SWAP_KEY, swapped ? '1' : '0');
  } catch {
    // ignore
  }
}
/** Swap only takes effect with two devices present. */
function effectiveSwap(): boolean {
  return swapped && getConnectedCount() >= 2;
}
/** Physical device index that renders the given logical half. */
function deviceForHalf(half: 0 | 1): number {
  const swap = effectiveSwap();
  if (half === 0) return swap ? 1 : 0;
  return swap ? 0 : 1;
}
/** Logical half a physical device is currently showing. */
function halfForDevice(device: number): 0 | 1 {
  const swap = effectiveSwap();
  const base: 0 | 1 = device === 0 ? 0 : 1;
  return swap ? ((base ^ 1) as 0 | 1) : base;
}

// Per-row absolute step column (0..15) of the last painted playhead. -1 = no
// playhead currently drawn on that row (track absent, paused, or off-grid).
const lastPlayheadAbs: number[] = new Array(8).fill(-1);
let lastPlacedStep: { trackId: string; index: number } | null = null;
// Currently-held grid pads, encoded as device*64 + padIndex. Used to detect
// hold-source + tap-end tie gestures on the same track row — across both pads,
// so a tie can span the 8/9 seam.
const heldPads = new Set<number>();
let attached = false;
let unsubs: Array<() => void> = [];

function encodeHeld(device: number, padIndex: number): number {
  return device * 64 + padIndex;
}
function decodeHeld(code: number): { device: number; padIndex: number } {
  return { device: Math.floor(code / 64), padIndex: code % 64 };
}
/** Absolute step (0..15) a pad press maps to, given the device showing it. */
function absStepFor(device: number, col: number): number {
  return halfForDevice(device) * 8 + col;
}

function currentSection(): TrackSection {
  return useSequencerStore.getState().viewSection;
}

function visibleTracks(section: TrackSection): Track[] {
  return useSequencerStore
    .getState()
    .tracks.filter((t) => t.section === section)
    .slice(0, 8);
}

// Absolute playhead column (0..15) for a track, or -1 if outside the visible
// 16-step window (tracks longer than 16 lose steps beyond 15 — same limitation
// as the prior quadrant model, just without paging to reach them).
function computePlayheadAbsForTrack(track: Track | undefined): number {
  if (!track) return -1;
  const { globalStep, playing, sceneStartStep } = useSequencerStore.getState();
  if (!playing) return -1;
  const stride = RATE_STRIDE[track.rate];
  const raw = Math.floor((globalStep - sceneStartStep) / stride);
  const localStep = ((raw % track.length) + track.length) % track.length;
  return localStep < STEP_WIDTH ? localStep : -1;
}

function resetLastPlayheadAbs(): void {
  for (let i = 0; i < 8; i++) lastPlayheadAbs[i] = -1;
}

// Classify a step's role in a tie chain. A "source" is an on step whose note
// extends into the next slot (step.tieToNext = true). A "held" step is an off
// step reached by walking backwards through an unbroken chain of
// `tieToNext = true` predecessors landing on an on originator — mirrors
// `displayedStep` in StepInspector so the launchpad shows what the inspector
// shows. Other steps return 'none'.
function tieRole(track: Track, idx: number): 'none' | 'source' | 'held' {
  const step = track.steps[idx];
  if (!step) return 'none';
  if (step.on) return step.tieToNext ? 'source' : 'none';
  let cur = idx;
  while (cur > 0) {
    const prev = cur - 1;
    const prevStep = track.steps[prev];
    if (!prevStep?.tieToNext) return 'none';
    if (prevStep.on) return 'held';
    cur = prev;
  }
  return 'none';
}

function colorForCell(track: Track | undefined, stepIdx: number, onPlayhead: boolean): number {
  if (!track || stepIdx >= track.length) return onPlayhead ? COL_PLAY_OFF : COL_OFF;
  const step = track.steps[stepIdx];
  const on = !!(step && step.on);
  const role = tieRole(track, stepIdx);
  if (onPlayhead) {
    if (on) return COL_PLAY_HIT;
    if (role === 'held') return COL_TIE_HELD_PH;
    return COL_PLAY_OFF;
  }
  if (role === 'source') return COL_TIE_SOURCE;
  if (role === 'held') return COL_TIE_HELD;
  if (on) return COL_STEP_ON;
  return COL_OFF;
}

function bankLevel(
  slot: unknown,
  index: number,
  active: number | null,
  pending: number | null
): number {
  // Pending is drawn via palette pulse (applied separately) but we return a
  // static-bright fallback here so a one-frame stale value before the pulse
  // lands isn't black. Active stays max-bright 127.
  if (index === pending) return COL_BANK_ACTIVE;
  if (index === active) return COL_BANK_ACTIVE;
  if (slot) return COL_BANK_POPULATED;
  return COL_BANK_EMPTY;
}

// Build the full 80-slot surface for one logical half (0 = steps 0..7,
// 1 = steps 8..15). Grid + that half's bank octave + the shared side rail.
function buildSurfaceForHalf(half: 0 | 1): Uint8Array {
  const out = new Uint8Array(SURFACE_SIZE);
  const state = useSequencerStore.getState();
  const tracks = visibleTracks(state.viewSection);
  const pageStart = half * 8;
  for (let row = 0; row < 8; row++) {
    const track = tracks[row];
    const phAbs = computePlayheadAbsForTrack(track);
    for (let col = 0; col < 8; col++) {
      const absStep = pageStart + col;
      out[row * 8 + col] = colorForCell(track, absStep, absStep === phAbs);
    }
  }
  // Top row: bank select. Left pad → banks 0..7, right pad → 8..15.
  const bankBase = half * 8;
  for (let i = 0; i < 8; i++) {
    const slotIdx = bankBase + i;
    out[64 + i] = bankLevel(state.banks[slotIdx] ?? null, slotIdx, state.activeBank, state.pendingBank);
  }
  // Side rail (symmetric on both pads).
  out[72 + 0] = state.playing ? COL_PLAY_PLAYING : COL_PLAY_STOPPED;
  out[72 + 1] = COL_PANIC;
  out[72 + 2] = state.viewSection === 'melodic' ? COL_SECTION_MELODIC : COL_SECTION_DRUM;
  out[72 + 3] = effectiveSwap() ? COL_SWAP_ON : COL_SWAP_OFF;
  out[72 + 4] = COL_OFF;
  out[72 + 5] = COL_OFF;
  const pitchCol = lastPlacedStep ? COL_PITCH_READY : COL_PITCH_IDLE;
  out[72 + 6] = pitchCol;
  out[72 + 7] = pitchCol;
  return out;
}

// Pulse the pending-bank slot on whichever pad owns its octave.
function applyPendingPulse(): void {
  const pending = useSequencerStore.getState().pendingBank;
  if (pending === null || pending < 0 || pending >= 16) return;
  const half: 0 | 1 = pending < 8 ? 0 : 1;
  const device = deviceForHalf(half);
  setTopPulse(device, pending % 8, COL_BANK_PENDING_PALETTE);
}

// Paint both pads from scratch (full bulk redraw + pending pulse). Used on
// attach, section/swap change, grid edits, and device hot-plug.
function repaintBoth(): void {
  for (let half: 0 | 1 = 0; half <= 1; half = (half + 1) as 0 | 1) {
    bulkRedraw(deviceForHalf(half), buildSurfaceForHalf(half));
  }
  applyPendingPulse();
}

function repaintCellAbs(row: number, absStep: number, onPlayhead: boolean): void {
  if (absStep < 0) return;
  const half: 0 | 1 = absStep < 8 ? 0 : 1;
  const col = absStep % 8;
  const device = deviceForHalf(half);
  const track = visibleTracks(currentSection())[row];
  setPadColor(device, row * 8 + col, colorForCell(track, absStep, onPlayhead));
}

function updatePlayhead(): void {
  const tracks = visibleTracks(currentSection());
  for (let row = 0; row < 8; row++) {
    const next = computePlayheadAbsForTrack(tracks[row]);
    const prev = lastPlayheadAbs[row];
    if (next === prev) continue;
    repaintCellAbs(row, prev, false);
    repaintCellAbs(row, next, true);
    lastPlayheadAbs[row] = next;
  }
}

function seedPlayhead(): void {
  const tracks = visibleTracks(currentSection());
  for (let row = 0; row < 8; row++) {
    lastPlayheadAbs[row] = computePlayheadAbsForTrack(tracks[row]);
  }
}

// Repaint just the pitch-ready side buttons on both pads.
function repaintPitchButtons(): void {
  const col = lastPlacedStep ? COL_PITCH_READY : COL_PITCH_IDLE;
  for (let device = 0; device < getConnectedCount(); device++) {
    setSideColor(device, 6, col);
    setSideColor(device, 7, col);
  }
}

// Signature of the visible section — collapses tracks×steps to a string so we
// can cheaply detect "the grid changed" without diffing pad-by-pad. Hashes
// the FULL track because tie-held coloring of any step depends on tieToNext
// flags of preceding steps.
function visibleSignature(): string {
  const tracks = visibleTracks(currentSection());
  let s = '';
  for (let row = 0; row < 8; row++) {
    const t = tracks[row];
    if (!t) {
      s += '|--';
      continue;
    }
    s += '|' + t.id + ':';
    for (let c = 0; c < t.length; c++) {
      const st = t.steps[c];
      s += (st?.on ? '1' : '0') + (st?.tieToNext ? 't' : '_');
    }
  }
  return s;
}

function bankSignature(): string {
  const s = useSequencerStore.getState();
  let sig = `${s.activeBank ?? '_'}|${s.pendingBank ?? '_'}`;
  for (let i = 0; i < 16; i++) sig += s.banks[i] ? '1' : '0';
  return sig;
}

function toggleSwap(): void {
  swapped = !swapped;
  persistSwapped();
  resetLastPlayheadAbs();
  repaintBoth();
  seedPlayhead();
}

function handleEvent(device: number, e: LaunchpadEvent): void {
  // Track pad release for tie-gesture state. Other releases are no-ops.
  if (e.addr.element === 'pad' && !e.pressed) {
    heldPads.delete(encodeHeld(device, e.addr.index));
    return;
  }
  if (!e.pressed) return;
  const store = useSequencerStore.getState();

  if (e.addr.element === 'pad') {
    const row = Math.floor(e.addr.index / 8);
    const col = e.addr.index % 8;
    const tracks = visibleTracks(store.viewSection);
    const track = tracks[row];
    const stepIdx = absStepFor(device, col);
    if (!track || stepIdx >= track.length) {
      heldPads.add(encodeHeld(device, e.addr.index));
      return;
    }

    // Tie gesture: any other pad currently held on the SAME track row (either
    // pad) → toggle tieToNext across [min, max). Same semantics as the
    // on-screen shift-click range tie; spans the 8/9 seam if the held source
    // is on the other pad. Skips the normal toggleStep so the user can hold an
    // on step + tap an empty cell without flipping its state.
    let sourceStep = -1;
    for (const code of heldPads) {
      const { device: hDev, padIndex } = decodeHeld(code);
      if (Math.floor(padIndex / 8) !== row) continue;
      const hAbs = absStepFor(hDev, padIndex % 8);
      if (hAbs !== stepIdx) {
        sourceStep = hAbs;
        break;
      }
    }
    if (sourceStep >= 0) {
      const a = Math.min(sourceStep, stepIdx);
      const b = Math.max(sourceStep, stepIdx);
      let allTied = true;
      for (let i = a; i < b; i++) {
        if (!track.steps[i]?.tieToNext) {
          allTied = false;
          break;
        }
      }
      const next = !allTied;
      for (let i = a; i < b; i++) store.setStepTie(track.id, i, next);
      heldPads.add(encodeHeld(device, e.addr.index));
      return;
    }

    const wasOn = !!track.steps[stepIdx]?.on;
    store.toggleStep(track.id, stepIdx);
    if (!wasOn) {
      // OFF→ON: this is the step the pitch buttons will nudge. Pin via
      // tieAnchor so the inspector survives mouse-leave (selectedStep alone
      // is hover-cleared by TrackGrid). Mirror selectedStep too.
      const sel = { trackId: track.id, index: stepIdx };
      lastPlacedStep = sel;
      store.setTieAnchor(sel);
      store.setSelectedStep(sel);
    } else if (
      lastPlacedStep &&
      lastPlacedStep.trackId === track.id &&
      lastPlacedStep.index === stepIdx
    ) {
      // ON→OFF on the same step: release the pitch target + unpin.
      lastPlacedStep = null;
      store.setTieAnchor(null);
      store.setSelectedStep(null);
    }
    repaintPitchButtons();
    heldPads.add(encodeHeld(device, e.addr.index));
    return;
  }

  if (e.addr.element === 'top' && e.addr.index >= 0 && e.addr.index < 8) {
    // Top row → queue a bank. Left pad addresses slots 0..7, right pad 8..15.
    const slot = halfForDevice(device) * 8 + e.addr.index;
    store.queueBank(slot);
    return;
  }

  if (e.addr.element === 'side') {
    switch (e.addr.index) {
      case 0:
        // Route through togglePlayback so audio context, FX worklets,
        // scheduler, and recorder go through their full lifecycle — setPlaying
        // alone only flips the state flag and desyncs UI from audio.
        void togglePlayback();
        return;
      case 1:
        // All-notes-off across every cached output port. Doesn't affect the
        // sequencer's own playback — that's the play/stop button.
        void invoke('midi_panic').catch(() => {});
        return;
      case 2: {
        // Section toggle drum ↔ melodic. The store subscription repaints both
        // pads; nothing more to do here.
        const next: TrackSection = store.viewSection === 'drum' ? 'melodic' : 'drum';
        store.setViewSection(next);
        return;
      }
      case 3:
        toggleSwap();
        return;
      case 6:
      case 7: {
        // Pitch nudge on the most recently placed step.
        if (!lastPlacedStep) return;
        const { trackId, index } = lastPlacedStep;
        const track = store.tracks.find((t) => t.id === trackId);
        if (!track) return;
        const current = track.steps[index]?.pitch ?? 0;
        const delta = e.addr.index === 6 ? +1 : -1;
        const nextPitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, current + delta));
        if (nextPitch !== current) store.setStepPitch(trackId, index, nextPitch);
        // Re-pin the inspector (acts as the "toggle" — every pitch press
        // resurfaces the inspector if the user closed it).
        const sel = { trackId, index };
        store.setTieAnchor(sel);
        store.setSelectedStep(sel);
        return;
      }
      default:
        return;
    }
  }
}

export function attachLaunchpadBindings(): void {
  if (attached) return;
  attached = true;
  repaintBoth();
  seedPlayhead();

  unsubs.push(onLaunchpadEvent(handleEvent));

  // Per-step playhead. Cheaper than relying on the store subscription (which
  // fires on every globalStep write, not all of which matter).
  unsubs.push(scheduler.onStep('launchpad:playhead', () => updatePlayhead()));

  // Hot-plug of a second (or first) pad → repaint everything so the newly
  // present surface gets drawn and swap re-resolves with the new count.
  unsubs.push(
    onLaunchpadConnectionChange(() => {
      resetLastPlayheadAbs();
      repaintBoth();
      seedPlayhead();
    })
  );

  // Coarse-grained: detect grid edits + section/playing/bank changes.
  let prevSig = visibleSignature();
  let prevPlaying = useSequencerStore.getState().playing;
  let prevView = useSequencerStore.getState().viewSection;
  let prevBankSig = bankSignature();
  unsubs.push(
    useSequencerStore.subscribe((state) => {
      // Play state flip → repaint transport button on both pads + force
      // playhead refresh (when stopping we clear the columns; onStep has
      // stopped firing).
      if (state.playing !== prevPlaying) {
        prevPlaying = state.playing;
        for (let d = 0; d < getConnectedCount(); d++) {
          setSideColor(d, 0, state.playing ? COL_PLAY_PLAYING : COL_PLAY_STOPPED);
        }
        if (!state.playing) {
          for (let row = 0; row < 8; row++) {
            repaintCellAbs(row, lastPlayheadAbs[row], false);
            lastPlayheadAbs[row] = -1;
          }
        }
      }
      // Bank state changed (queue, commit, populate, wipe) → repaint both top
      // rows (left = slots 0..7, right = 8..15).
      const nextBankSig = bankSignature();
      if (nextBankSig !== prevBankSig) {
        prevBankSig = nextBankSig;
        for (let half: 0 | 1 = 0; half <= 1; half = (half + 1) as 0 | 1) {
          const device = deviceForHalf(half);
          const base = half * 8;
          for (let i = 0; i < 8; i++) {
            const slot = base + i;
            setTopColor(device, i, bankLevel(state.banks[slot] ?? null, slot, state.activeBank, state.pendingBank));
          }
        }
        applyPendingPulse();
      }
      // viewSection toggled (from on-screen UI or our own side button) →
      // repaint both pads with the new section's tracks.
      if (state.viewSection !== prevView) {
        prevView = state.viewSection;
        resetLastPlayheadAbs();
        prevSig = visibleSignature();
        repaintBoth();
        seedPlayhead();
        return;
      }
      // Grid edits within the focused section → repaint both pads.
      const nextSig = visibleSignature();
      if (nextSig !== prevSig) {
        prevSig = nextSig;
        repaintBoth();
        resetLastPlayheadAbs();
        updatePlayhead();
      }
    })
  );
}

export function detachLaunchpadBindings(): void {
  if (!attached) return;
  for (const u of unsubs) u();
  unsubs = [];
  attached = false;
  resetLastPlayheadAbs();
  lastPlacedStep = null;
  heldPads.clear();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    detachLaunchpadBindings();
  });
}
