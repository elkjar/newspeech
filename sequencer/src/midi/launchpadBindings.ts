// Wire the Launchpad X transport to the sequencer store. Translates pad
// presses into store mutations and renders the focused 8×8 slice
// (one quadrant of the full pattern) as colored pads.
//
// Quadrants (top-row arrow buttons, left→right):
//   0 = R1 → drum tracks  [0..7], steps [0..7]
//   1 = R2 → drum tracks  [0..7], steps [8..15]
//   2 = M1 → melody tracks[0..7], steps [0..7]
//   3 = M2 → melody tracks[0..7], steps [8..15]
//
// Right column (top→bottom): play/pause, ·, ·, ·, ·, ·, ·, panic.
// Other side buttons are off / reserved for future transport mappings
// (record arm, stop, page nudge with second Launchpad, etc.).
//
// Playhead column lights as the global scheduler advances. Reference rate
// is 1/16 (matching the default pattern length × per-track stride). Tracks
// running at other rates won't have their own per-track playhead until v2.

import { invoke } from '@tauri-apps/api/core';
import { useSequencerStore, RATE_STRIDE, PAGE_SIZE, type Track, type TrackSection } from '../state/store';
import { scheduler } from '../audio/scheduler';
import { togglePlayback } from '../audio/transport';
import {
  bulkRedraw,
  onLaunchpadEvent,
  setPadColor,
  setSideColor,
  setTopColor,
  setTopPulse,
  type LaunchpadEvent,
} from './launchpad';

type Quadrant = 0 | 1 | 2 | 3;

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
const COL_QUAD_ACTIVE = 96;
const COL_QUAD_IDLE = 12;
const COL_PLAY_PLAYING = 96;
const COL_PLAY_STOPPED = 12;
const COL_PANIC = 50;
const COL_PITCH_READY = 96;
const COL_PITCH_IDLE = 12;
// Bank slot brightness ladder for the top row. Pending uses palette-pulse
// (animation) as its differentiator from active rather than a brightness
// step, so the active slot can sit at max-bright 127 without being
// outranked.
const COL_BANK_EMPTY = 0;
const COL_BANK_POPULATED = 25;
const COL_BANK_ACTIVE = 127;
const COL_BANK_PENDING_PALETTE = 3; // palette index 3 = bright white

const SURFACE_SIZE = 80;
const PITCH_MIN = -36;
const PITCH_MAX = 36;

let activeQuadrant: Quadrant = 0;
let lastPlayheadCol = -1;
let lastPlacedStep: { trackId: string; index: number } | null = null;
// Currently-held grid pads, by 0..63 index. Used to detect hold-source +
// tap-end tie gestures on the same row.
const heldPads = new Set<number>();
let attached = false;
let unsubs: Array<() => void> = [];

function quadSection(q: Quadrant): TrackSection {
  return q === 0 || q === 1 ? 'drum' : 'melodic';
}
function quadPage(q: Quadrant): 0 | 1 {
  return q === 0 || q === 2 ? 0 : 1;
}

function visibleTracks(section: TrackSection): Track[] {
  return useSequencerStore
    .getState()
    .tracks.filter((t) => t.section === section)
    .slice(0, 8);
}

function computePlayheadCol(): number {
  const { globalStep, playing } = useSequencerStore.getState();
  if (!playing) return -1;
  const stride = RATE_STRIDE['1/16']; // 2 global ticks per 1/16 step
  const localStep = Math.floor(globalStep / stride) % PAGE_SIZE;
  const pageStart = quadPage(activeQuadrant) * 8;
  if (localStep < pageStart || localStep >= pageStart + 8) return -1;
  return localStep - pageStart;
}

// Classify a step's role in a tie chain. A "source" is an on step whose
// note extends into the next slot (step.tieToNext = true). A "held" step
// is an off step that's reached by walking backwards through an unbroken
// chain of `tieToNext = true` predecessors landing on an on originator —
// mirrors `displayedStep` in StepInspector so the launchpad shows what
// the inspector shows. Other steps return 'none'.
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

function buildSurface(): Uint8Array {
  const out = new Uint8Array(SURFACE_SIZE);
  const tracks = visibleTracks(quadSection(activeQuadrant));
  const pageStart = quadPage(activeQuadrant) * 8;
  const phCol = computePlayheadCol();
  for (let row = 0; row < 8; row++) {
    const track = tracks[row];
    for (let col = 0; col < 8; col++) {
      out[row * 8 + col] = colorForCell(track, pageStart + col, col === phCol);
    }
  }
  // Top row: bank select 1-8. Pending button gets a static placeholder
  // in the bulk redraw (so the slot isn't black for one frame) — the
  // caller applies setTopPulse after bulkRedraw to override it.
  const state = useSequencerStore.getState();
  for (let i = 0; i < 8; i++) {
    out[64 + i] = bankLevel(state.banks[i] ?? null, i, state.activeBank, state.pendingBank);
  }
  // Right column: play, panic, ◀ quadrant, ▶ quadrant, ·, ·, pitch up, pitch down.
  out[72 + 0] = state.playing ? COL_PLAY_PLAYING : COL_PLAY_STOPPED;
  out[72 + 1] = COL_PANIC;
  out[72 + 2] = activeQuadrant > 0 ? COL_QUAD_ACTIVE : COL_QUAD_IDLE;
  out[72 + 3] = activeQuadrant < 3 ? COL_QUAD_ACTIVE : COL_QUAD_IDLE;
  out[72 + 4] = COL_OFF;
  out[72 + 5] = COL_OFF;
  const pitchCol = lastPlacedStep ? COL_PITCH_READY : COL_PITCH_IDLE;
  out[72 + 6] = pitchCol;
  out[72 + 7] = pitchCol;
  return out;
}

function bankLevel(
  slot: unknown,
  index: number,
  active: number | null,
  pending: number | null
): number {
  // Pending is drawn via palette pulse (applied separately) but we return
  // a static-bright fallback here so a one-frame stale value before the
  // pulse lands isn't black. Active stays max-bright 127.
  if (index === pending) return COL_BANK_ACTIVE;
  if (index === active) return COL_BANK_ACTIVE;
  if (slot) return COL_BANK_POPULATED;
  return COL_BANK_EMPTY;
}

// Drive the pending-bank pulse. Called after any operation that paints
// the top row, so the pulse overrides the static brightness for that slot.
function applyPendingPulse(): void {
  const pending = useSequencerStore.getState().pendingBank;
  if (pending === null || pending < 0 || pending >= 8) return;
  setTopPulse(pending, COL_BANK_PENDING_PALETTE);
}

function repaintColumn(col: number, onPlayhead: boolean): void {
  if (col < 0) return;
  const tracks = visibleTracks(quadSection(activeQuadrant));
  const pageStart = quadPage(activeQuadrant) * 8;
  for (let row = 0; row < 8; row++) {
    setPadColor(row * 8 + col, colorForCell(tracks[row], pageStart + col, onPlayhead));
  }
}

function updatePlayhead(): void {
  const next = computePlayheadCol();
  if (next === lastPlayheadCol) return;
  repaintColumn(lastPlayheadCol, false);
  repaintColumn(next, true);
  lastPlayheadCol = next;
}

// Signature of the visible slice — collapses tracks×steps to a string so we
// can cheaply detect "the grid changed" without diffing pad-by-pad. Hashes
// the FULL track (not just the visible 8 cells) because tie-held coloring
// of an in-view step depends on tieToNext flags of any preceding step,
// including ones in the other page.
function visibleSignature(quad: Quadrant): string {
  const tracks = visibleTracks(quadSection(quad));
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

function handleEvent(e: LaunchpadEvent): void {
  // Track pad release for tie-gesture state. Other releases are no-ops.
  if (e.addr.element === 'pad' && !e.pressed) {
    heldPads.delete(e.addr.index);
    return;
  }
  if (!e.pressed) return;
  const store = useSequencerStore.getState();
  if (e.addr.element === 'pad') {
    const row = Math.floor(e.addr.index / 8);
    const col = e.addr.index % 8;
    const tracks = visibleTracks(quadSection(activeQuadrant));
    const track = tracks[row];
    if (!track) {
      heldPads.add(e.addr.index);
      return;
    }
    const pageStart = quadPage(activeQuadrant) * 8;
    const stepIdx = pageStart + col;
    if (stepIdx >= track.length) {
      heldPads.add(e.addr.index);
      return;
    }

    // Tie gesture: any other pad currently held in the same row → toggle
    // tieToNext across [min, max). Same semantics as the on-screen
    // shift-click range tie. Skips the normal toggleStep so the user can
    // hold an on step + tap an empty cell without flipping its state.
    let sourceCol = -1;
    for (const heldIdx of heldPads) {
      if (Math.floor(heldIdx / 8) === row && (heldIdx % 8) !== col) {
        sourceCol = heldIdx % 8;
        break;
      }
    }
    if (sourceCol >= 0) {
      const a = pageStart + Math.min(sourceCol, col);
      const b = pageStart + Math.max(sourceCol, col);
      let allTied = true;
      for (let i = a; i < b; i++) {
        if (!track.steps[i]?.tieToNext) {
          allTied = false;
          break;
        }
      }
      const next = !allTied;
      for (let i = a; i < b; i++) {
        store.setStepTie(track.id, i, next);
      }
      heldPads.add(e.addr.index);
      return;
    }

    const wasOn = !!track.steps[stepIdx]?.on;
    store.toggleStep(track.id, stepIdx);
    if (!wasOn) {
      // OFF→ON: this is the step the pitch buttons will nudge. Pin via
      // tieAnchor so the inspector survives mouse-leave (selectedStep alone
      // is hover-cleared by TrackGrid). Mirror selectedStep too so hover-
      // based features see the same step the launchpad is editing.
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
    setSideColor(6, lastPlacedStep ? COL_PITCH_READY : COL_PITCH_IDLE);
    setSideColor(7, lastPlacedStep ? COL_PITCH_READY : COL_PITCH_IDLE);
    heldPads.add(e.addr.index);
    return;
  }
  if (e.addr.element === 'top' && e.addr.index >= 0 && e.addr.index < 8) {
    // Top row 1-8 → queue bank slots 0-7. queueBank no-ops on empty slots
    // and on a press of the already-active bank; if stopped it applies
    // immediately, if playing it sets pendingBank for bar-boundary commit.
    store.queueBank(e.addr.index);
    return;
  }
  if (e.addr.element === 'side') {
    if (e.addr.index === 0) {
      // Route through togglePlayback so audio context, FX worklets, scheduler,
      // and recorder go through their full lifecycle — setPlaying alone only
      // flips the state flag and desyncs UI from audio.
      void togglePlayback();
      return;
    }
    if (e.addr.index === 1) {
      // All-notes-off across every cached output port. Doesn't affect the
      // sequencer's own playback — that's the play/stop button.
      void invoke('midi_panic').catch(() => {});
      return;
    }
    if (e.addr.index === 2 || e.addr.index === 3) {
      // Quadrant nav. side[2] = left (prev), side[3] = right (next). Labels
      // (CC 69 / 59) don't match the action — these slots were free, the top
      // arrows reclaimed for bank select.
      const delta = e.addr.index === 2 ? -1 : +1;
      const next = activeQuadrant + delta;
      if (next < 0 || next > 3) return;
      activeQuadrant = next as Quadrant;
      const wantSection = quadSection(activeQuadrant);
      if (store.viewSection !== wantSection) store.setViewSection(wantSection);
      if (lastPlacedStep) {
        store.setTieAnchor(null);
        store.setSelectedStep(null);
      }
      lastPlacedStep = null;
      heldPads.clear();
      lastPlayheadCol = -1;
      bulkRedraw(buildSurface());
      applyPendingPulse();
      return;
    }
    if (e.addr.index === 6 || e.addr.index === 7) {
      // Pitch nudge on the most recently placed step.
      if (!lastPlacedStep) return;
      const { trackId, index } = lastPlacedStep;
      const track = store.tracks.find((t) => t.id === trackId);
      if (!track) return;
      const current = track.steps[index]?.pitch ?? 0;
      const delta = e.addr.index === 6 ? +1 : -1;
      const next = Math.max(PITCH_MIN, Math.min(PITCH_MAX, current + delta));
      if (next !== current) store.setStepPitch(trackId, index, next);
      // Re-pin the inspector to this step (acts as the "toggle" — every
      // pitch press resurfaces the inspector if the user closed it).
      const sel = { trackId, index };
      store.setTieAnchor(sel);
      store.setSelectedStep(sel);
      return;
    }
  }
}

export function attachLaunchpadBindings(): void {
  if (attached) return;
  attached = true;
  // Mirror current viewSection into activeQuadrant so the launchpad opens
  // on whichever section the user was already looking at.
  const initial = useSequencerStore.getState().viewSection;
  activeQuadrant = initial === 'drum' ? 0 : 2;
  // buildSurface() already paints the playhead column at the current step,
  // so seed lastPlayheadCol from the same computation rather than re-painting.
  bulkRedraw(buildSurface());
  applyPendingPulse();
  lastPlayheadCol = computePlayheadCol();

  unsubs.push(onLaunchpadEvent(handleEvent));

  // Per-step playhead. Cheaper than relying on the store subscription
  // (which fires on every globalStep write, not all of which matter).
  unsubs.push(scheduler.onStep(() => updatePlayhead()));

  // Coarse-grained: detect grid edits + section/playing/bank changes.
  let prevSig = visibleSignature(activeQuadrant);
  let prevPlaying = useSequencerStore.getState().playing;
  let prevView = useSequencerStore.getState().viewSection;
  let prevBankSig = bankSignature();
  unsubs.push(
    useSequencerStore.subscribe((state) => {
      // Play state flip → repaint transport button + force playhead
      // refresh (when stopping we need to clear the column, but onStep
      // has stopped firing).
      if (state.playing !== prevPlaying) {
        prevPlaying = state.playing;
        setSideColor(0, state.playing ? COL_PLAY_PLAYING : COL_PLAY_STOPPED);
        if (!state.playing) {
          // Restore old column to its non-playhead colors.
          repaintColumn(lastPlayheadCol, false);
          lastPlayheadCol = -1;
        }
      }
      // Bank state changed (queue, commit, populate, wipe) → repaint top row.
      const nextBankSig = bankSignature();
      if (nextBankSig !== prevBankSig) {
        prevBankSig = nextBankSig;
        for (let i = 0; i < 8; i++) {
          setTopColor(
            i,
            bankLevel(state.banks[i] ?? null, i, state.activeBank, state.pendingBank)
          );
        }
        applyPendingPulse();
      }
      // viewSection toggled from on-screen UI → realign quadrant.
      if (state.viewSection !== prevView) {
        prevView = state.viewSection;
        if (state.viewSection === 'drum' && (activeQuadrant === 2 || activeQuadrant === 3)) {
          activeQuadrant = 0;
        } else if (state.viewSection === 'melodic' && (activeQuadrant === 0 || activeQuadrant === 1)) {
          activeQuadrant = 2;
        }
        lastPlayheadCol = -1;
        prevSig = visibleSignature(activeQuadrant);
        bulkRedraw(buildSurface());
        applyPendingPulse();
        return;
      }
      // Grid edits within the focused quadrant → bulk redraw.
      const nextSig = visibleSignature(activeQuadrant);
      if (nextSig !== prevSig) {
        prevSig = nextSig;
        bulkRedraw(buildSurface());
        applyPendingPulse();
        lastPlayheadCol = -1;
        updatePlayhead();
      }
    })
  );
}

function bankSignature(): string {
  const s = useSequencerStore.getState();
  let sig = `${s.activeBank ?? '_'}|${s.pendingBank ?? '_'}`;
  for (let i = 0; i < 8; i++) sig += s.banks[i] ? '1' : '0';
  return sig;
}

export function detachLaunchpadBindings(): void {
  if (!attached) return;
  for (const u of unsubs) u();
  unsubs = [];
  attached = false;
  lastPlayheadCol = -1;
  lastPlacedStep = null;
  heldPads.clear();
}

// Re-export the top-color setter so the connection wiring can flash the
// quadrant buttons during boot if it wants. Unused for now but cheap.
export { setTopColor };

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    detachLaunchpadBindings();
  });
}
