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
//   [4] chord page   [5] session page   [6] keyboard page   [7] drum (reserved)
// (side[4..6] toggle per-device page modes — see the Page system below. Pitch
//  nudge was removed; set pitch via keyboard mode instead.)
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
import { resolveChord, type ChordVoicing } from '../audio/chords';
import { octaveDegrees, quantize } from '../audio/scale';
import { monitorChord, monitorDrum, monitorNote, monitorRelease } from '../audio/monitor';
import {
  writeDrumHit,
  writeRecordedNote,
  finalizeRecordedNote,
  type RecordedOverdub,
} from './recordInput';
import {
  bulkRedraw,
  getConnectedCount,
  onLaunchpadConnectionChange,
  onLaunchpadEvent,
  setPadColor,
  setPulse,
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
// Keyboard page: a scale-degree grid. Root degrees read brighter so home is
// always findable; other in-scale degrees dim; a held pad lights brightest.
const COL_KB_ROOT = 50;
const COL_KB_NOTE = 16;
const COL_KB_HELD = 120;
// Drum page: bottom row = per-channel base-sample trigger pads (L→R = drum
// channels 1..8); brighter when that channel is record-armed so you can see
// which one captures. Rows above = a vertical ratchet ladder per channel.
const COL_DRUM_TRIG = 40; // trigger pad at rest
const COL_DRUM_TRIG_ARMED = 96; // trigger pad whose track is record-armed
const COL_DRUM_HIT = 127; // flash on tap
const COL_DRUM_LADDER = 20; // ratchet ladder, filled rung
const COL_DRUM_LADDER_SEL = 80; // ratchet ladder, the selected (top) rung
const COL_DRUM_REC_ON = 110; // top-row record arm, channel armed
const COL_DRUM_REC_OFF = 12; // top-row record arm, channel present but disarmed
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

// Chord page (per-device mode). Columns 0..6 = scale degrees I..VII off the
// scene key; column 7 reserved. Rows = an 8-rung voicing ladder, plainest at
// the BOTTOM (grid row 7) climbing to richest/most-open at the TOP (row 0).
const COL_CHORD_PRESSED = 127; // last-auditioned degree pad lights; rest stay dark
const COL_MODE_OFF = 12; // side[4] in step mode — chord mode available (dim)
const COL_MODE_ON = 110; // side[4] in chord mode — active (bright)
const COL_OCTAVE_OFF = 0; // column-7 octave pad, unselected (off — only the
// selected octave lights, so the active row reads at a glance)
const COL_OCTAVE_SEL = 100; // column-7 octave pad, currently selected (bright)
// Chord-page TOP ROW = chord-master step selector (the authoring target).
const COL_STEP_EMPTY = 12; // step within length, no chord (dim)
const COL_STEP_HAS = 45; // step has a chord authored (on) — medium
const COL_STEP_SELECTED = 120; // step selected as the write target (bright)

// Session page (per-device mode). 8×8 matrix: rows = performance song slots
// 0..7, cols = scene slots 0..7 within each song. Lighting separates state by
// brightness alone (monochrome): empty, a populated scene, a non-active song's
// resume scene (where it'll come in), and the one live cell. Pending swaps
// (queued scene / queued song) pulse via palette like the bank pending.
const COL_SESS_SCENE = 25; // a populated scene slot at rest
const COL_SESS_RESUME = 60; // a non-active song's saved activeScene (resume point)
const COL_SESS_LIVE = 127; // active song + active scene — playing now
const COL_SESS_PENDING_PALETTE = 3; // palette index 3 = bright white (pulse)

// Voicing ladder, index 0 = plainest. row r on the grid → ladder[7 - r], so
// the bottom row is a plain triad and the top row an open 11th. Hand-curated
// for 8 distinct rungs (the voicing-macro cascade only has ~6 distinct stages,
// so it wouldn't quantize cleanly into 8). Tune freely.
const CHORD_VOICING_LADDER: Array<Pick<ChordVoicing, 'extension' | 'inversion' | 'spread'>> = [
  { extension: 'triad', inversion: 0, spread: 'close' },
  { extension: 'triad', inversion: 1, spread: 'close' },
  { extension: 'triad', inversion: 0, spread: 'open' },
  { extension: '7', inversion: 0, spread: 'close' },
  { extension: '7', inversion: 1, spread: 'close' },
  { extension: '9', inversion: 0, spread: 'close' },
  { extension: '9', inversion: 0, spread: 'open' },
  { extension: '11', inversion: 0, spread: 'open' },
];

const SURFACE_SIZE = 80;
const STEP_WIDTH = 16; // total step columns across the pair
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
// Currently-held grid pads, encoded as device*64 + padIndex. Used to detect
// hold-source + tap-end tie gestures on the same track row — across both pads,
// so a tie can span the 8/9 seam.
const heldPads = new Set<number>();
// Per-PHYSICAL-device page mode. Independent so one pad can be the chord
// palette / session launcher / keyboard while the other stays a normal step
// half (user workflow). Indexed by physical device (0/1), NOT logical half.
// ('drum' is reserved — planned next page, side[7].)
type DeviceMode = 'step' | 'chord' | 'session' | 'keyboard' | 'drum';
const deviceMode: DeviceMode[] = ['step', 'step'];
// Drum page: per-channel (0..7, L→R) ratchet ladder selection baked into
// recorded hits. 1 = single hit (default, no ladder lit); 2..8 = roll. GLOBAL
// (a channel-authoring setting, shared if both pads show the drum page).
const drumRatchet: number[] = new Array(8).fill(1);
// Drum-page record arm is the store's per-track `inputArmed` (the TOP ROW
// toggles it), NOT a launchpad-local flag — so arming a channel from the pad
// also lights that track's record dot in the app UI. Drum arm is MULTI (see
// setTrackInputArmed: melodic single-target, drum multi).
// Keyboard page: notes held down on each device, keyed device*64+padIndex →
// the target track + monitor voice id (so a release ramps THAT voice down) +
// the overdub it recorded (so the release finalizes that step's gate).
const kbHeld = new Map<number, { trackId: string; noteId: number; overdub: RecordedOverdub | null }>();
// Monitor voice-handle source for the launchpad keyboard. Based high to dodge
// recordInput's counter (from 1) and the chord-revoice namespace (1e9).
let nextKbNoteId = 2_000_000_000;
// Per-device last-auditioned pad index (0..63), for bright press feedback on
// the chord page. -1 = none.
const lastAuditionPad: number[] = [-1, -1];
// Per-device chord-page octave offset (octaves, applied on top of the chord
// master's own octave). Set by the column-7 octave selector. 0 = no shift.
const chordOctave: number[] = [0, 0];
// Chord-page write target = the PINNED step (`tieAnchor`) on the chord master,
// mirroring the MIDI-keyboard pinned step-edit in recordInput.ts: select a step
// on the grid (or via the top row, which also pins), then a degree-pad tap
// binds the chord to THAT step. No internal cursor / no auto-advance — the live
// grid selection is the target, so it tracks clicks the moment they happen.
// Nothing pinned on the chord master → taps audition only.
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
  out[72 + 4] = COL_MODE_OFF; // chord-mode toggle (dim = available)
  out[72 + 5] = COL_MODE_OFF; // session-mode toggle (dim = available)
  out[72 + 6] = COL_MODE_OFF; // keyboard-mode toggle (dim = available)
  out[72 + 7] = COL_MODE_OFF; // drum-mode toggle (reserved — page not built yet)
  return out;
}

// ---------- chord page ----------
// Column 7 = octave selector. Top pad (row 0) is the highest octave, bottom
// (row 7) the lowest; row 3 is 0 (no shift). Range +3..−4 — tune freely.
function octaveForRow(row: number): number {
  return 3 - row;
}
function rowForOctave(oct: number): number {
  return 3 - oct;
}

// Base (unpressed) color for a chord-page pad. cols 0..6 = degrees I..VII
// (tonic column brighter as a home reference); col 7 = octave selector (the
// selected octave's pad is bright, the rest dim).
function chordPadBase(device: number, padIndex: number): number {
  const col = padIndex % 8;
  if (col === 7) {
    return octaveForRow(Math.floor(padIndex / 8)) === chordOctave[device]
      ? COL_OCTAVE_SEL
      : COL_OCTAVE_OFF;
  }
  return COL_OFF; // degree pads dark at rest — only the last-auditioned lights
}

// First melodic track — the default chord target when nothing's pinned (and the
// engine's chord MASTER: melodic slot 0 sets the chord context followers read).
function chordMaster(): Track | undefined {
  return useSequencerStore.getState().tracks.find((t) => t.section === 'melodic');
}

// Top-row step selector reaches steps 0..7; the pin can sit beyond that (set via
// the grid), in which case it just isn't shown on the top row.
const CHORD_TOP_STEPS = 8;

// The melodic VOICE track a launchpad-pinned `tieAnchor` points to — null if the
// pin isn't on a melodic voice track. Chords can be authored onto ANY melodic
// voice track, not just the chord master: the engine plays the full chord from a
// step's chordVoicing for tracks in 'semitones' (UI "ignore") mode — the default
// for new melodic tracks (resolveFollowerNote in tick.ts). chord-tone/scale-tone/
// root-follow tracks store the voicing but sound a single derived note by design.
function pinnedVoiceTrack(): Track | undefined {
  const s = useSequencerStore.getState();
  const pin = s.tieAnchor;
  if (!pin) return undefined;
  const t = s.tracks.find((tr) => tr.id === pin.trackId);
  return t && t.section === 'melodic' && t.source.kind === 'voice' ? t : undefined;
}

// The melodic track the chord + keyboard pages operate on: the pinned melodic
// voice track (selected step), else the first melodic track as the default.
// "Select a step, then author/play that channel" — shared by both pages.
function targetMelodicTrack(): Track | undefined {
  return pinnedVoiceTrack() ?? chordMaster();
}

// The pinned step index on the current target track, or null if nothing valid is
// pinned. The chord page's write target — the same `tieAnchor` pin a grid click
// or step-page pad sets, so selecting a step is immediately the chord target.
function pinnedChordStep(): number | null {
  const t = pinnedVoiceTrack();
  const pin = useSequencerStore.getState().tieAnchor;
  if (t && pin && pin.index < t.length) return pin.index;
  return null;
}

// Top-row (step selector) color for chord-master step `stepIdx`.
function chordTopColor(stepIdx: number, cm: Track | undefined): number {
  if (!cm || stepIdx >= cm.length) return COL_OFF;
  if (stepIdx === pinnedChordStep()) return COL_STEP_SELECTED;
  return cm.steps[stepIdx]?.on ? COL_STEP_HAS : COL_STEP_EMPTY;
}

// Repaint the top-row step selector on every chord-mode device. Shows the steps
// of the current TARGET track (the pinned melodic voice track, else the chord
// master), so the selector follows whichever channel you're authoring chords on.
function repaintChordTops(): void {
  const t = targetMelodicTrack();
  for (let d = 0; d < 2; d++) {
    if (deviceMode[d] !== 'chord') continue;
    for (let i = 0; i < 8; i++) setTopColor(d, i, chordTopColor(i, t));
  }
}

// Full 80-slot surface for a device in chord mode: the degree×voicing palette,
// the column-7 octave selector, the top-row step selector, + a minimal side
// rail (play / panic / mode-toggle-active).
function buildChordSurface(device: number): Uint8Array {
  const out = new Uint8Array(SURFACE_SIZE);
  // Degree pads (cols 0..6) stay dark; only column 7's selected octave lights.
  for (let row = 0; row < 8; row++) {
    out[row * 8 + 7] =
      octaveForRow(row) === chordOctave[device] ? COL_OCTAVE_SEL : COL_OCTAVE_OFF;
  }
  const last = lastAuditionPad[device];
  if (last >= 0) out[last] = COL_CHORD_PRESSED;
  const t = targetMelodicTrack();
  for (let i = 0; i < 8; i++) out[64 + i] = chordTopColor(i, t);
  out[72 + 0] = useSequencerStore.getState().playing ? COL_PLAY_PLAYING : COL_PLAY_STOPPED;
  out[72 + 1] = COL_PANIC;
  out[72 + 4] = COL_MODE_ON;
  out[72 + 5] = COL_MODE_OFF; // session available from the chord page
  return out;
}

// ---------- session page ----------
// 8×8 matrix navigator over the performance/composition hierarchy: rows =
// performance song slots, cols = scene slots within each song. The active
// song's row shows the LIVE composition (its activeScene = the bright live
// cell); other rows show that song's snapshot (its saved activeScene marked as
// the resume point). Banks deliberately stay on the step page — this surface
// is for navigating songs + scenes, the two layers with no hardware face.
//
// Fire semantics (the row decides the cost, no mode button):
//   - tap a cell in the ACTIVE song's row  → loadScene(col)  (scene jump)
//   - tap a cell in ANOTHER song's row      → loadSong(row)   (song swap,
//     tail-out when playing). v1 lands on the song's own saved scene; the
//     column is informational. Landing on a specific scene of another song
//     needs after-swap scene cueing — deferred with the ghost-lens page.
// Both go through the store's orchestrated helpers (stopped→immediate,
// playing→queue + auto-save), never raw setters — see feedback-hardware-via-helper.

// Resolve a row's scene array + its active-scene index. The active song reads
// the live composition; every other song reads its stored snapshot.
function sessionRow(
  device_state: ReturnType<typeof useSequencerStore.getState>,
  row: number
): { scenes: (unknown | null)[]; activeScene: number | null } | null {
  if (row === device_state.performance.activeSong) {
    return {
      scenes: device_state.composition.scenes,
      activeScene: device_state.composition.activeScene,
    };
  }
  const song = device_state.performance.songs[row];
  if (!song) return null;
  return { scenes: song.scenes, activeScene: song.activeScene };
}

function buildSessionSurface(_device: number): Uint8Array {
  const out = new Uint8Array(SURFACE_SIZE);
  const state = useSequencerStore.getState();
  const activeSong = state.performance.activeSong;
  for (let row = 0; row < 8; row++) {
    const info = sessionRow(state, row);
    if (!info) continue; // empty song slot → whole row off
    for (let col = 0; col < 8; col++) {
      if (!info.scenes[col]) continue; // empty scene slot → off
      if (row === activeSong && col === info.activeScene) out[row * 8 + col] = COL_SESS_LIVE;
      else if (col === info.activeScene) out[row * 8 + col] = COL_SESS_RESUME;
      else out[row * 8 + col] = COL_SESS_SCENE;
    }
  }
  out[72 + 0] = state.playing ? COL_PLAY_PLAYING : COL_PLAY_STOPPED;
  out[72 + 1] = COL_PANIC;
  out[72 + 4] = COL_MODE_OFF; // chord available from the session page
  out[72 + 5] = COL_MODE_ON; // session active
  return out;
}

// Pulse the cued swap targets on a session device (over the static fallback
// already painted by buildSessionSurface). pendingScene pulses within the
// active song's row; pendingSong pulses the target song's resume cell.
function applySessionPulses(device: number): void {
  const state = useSequencerStore.getState();
  const pScene = state.composition.pendingScene;
  if (pScene !== null && state.performance.activeSong !== null) {
    const idx = state.performance.activeSong * 8 + pScene;
    setPulse(device, { element: 'pad', index: idx }, COL_SESS_PENDING_PALETTE);
  }
  const pSong = state.performance.pendingSong;
  if (pSong !== null) {
    const song = state.performance.songs[pSong];
    const col = song?.activeScene ?? 0;
    setPulse(device, { element: 'pad', index: pSong * 8 + col }, COL_SESS_PENDING_PALETTE);
  }
}

// ---------- keyboard page ----------
// A scale-quantized note grid for live play. CLEAN OCTAVE ROWS: each row is one
// octave, root-to-root — a diatonic (7-note) scale fills all 8 columns
// (degrees 1..7 + the octave), so roots line up vertically on columns 0 and 7.
// Scales with fewer notes (pentatonic) light only their degrees + the octave;
// the trailing columns are DEAD (unlit, unplayable) rather than spilling into
// the next octave. The BOTTOM row is OCTAVE 1, each row UP adds an octave
// (octave 1..8), anchored absolutely (C1 = MIDI 24) off the scene root's pitch
// class — independent of the track octave; the row IS the octave. Plays the
// live monitor voice of the TARGET track (the selected step's track),
// velocity-sensitive. (Recording via the per-track record arm is the follow-up.)
type KbScale = ReturnType<typeof useSequencerStore.getState>['scale'];

// Scale-degree above the root for a pad: bottom row = octave 1 (degree 0..N),
// each row up adds octaveDegrees. Columns 0..N are valid (N = the octave note);
// columns > N are dead for that scale.
function kbDegree(row: number, col: number, scale: KbScale): number {
  return (7 - row) * octaveDegrees(scale) + col;
}

// Absolute MIDI for a keyboard pad. Anchored so the bottom row sounds at octave
// 1 (root pitch class at C1 = MIDI 24) regardless of the scene root's own octave
// or the track octave — the row IS the octave.
function kbMidi(row: number, col: number, rootNote: number, scale: KbScale): number {
  const pc = ((rootNote % 12) + 12) % 12;
  return quantize(24 + pc, scale, kbDegree(row, col, scale));
}

// Resting color for a keyboard pad: dead (off) past the scale's last column so
// e.g. pentatonic rows don't spill; roots (octave boundaries) brighter; other
// in-scale degrees dim.
function kbBaseColor(row: number, col: number, scale: KbScale): number {
  const n = octaveDegrees(scale);
  if (col > n) return COL_OFF; // dead key — scale is narrower than 8 root-to-root
  return kbDegree(row, col, scale) % n === 0 ? COL_KB_ROOT : COL_KB_NOTE;
}

// Full 80-slot keyboard surface: the scale grid + held-note highlight for this
// device + a minimal side rail (play / panic / page toggles).
function buildKeyboardSurface(device: number): Uint8Array {
  const out = new Uint8Array(SURFACE_SIZE);
  const { scale, playing } = useSequencerStore.getState();
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) out[row * 8 + col] = kbBaseColor(row, col, scale);
  }
  // Light any pads currently held DOWN on this device.
  for (const code of kbHeld.keys()) {
    const { device: d, padIndex } = decodeHeld(code);
    if (d === device) out[padIndex] = COL_KB_HELD;
  }
  out[72 + 0] = playing ? COL_PLAY_PLAYING : COL_PLAY_STOPPED;
  out[72 + 1] = COL_PANIC;
  out[72 + 4] = COL_MODE_OFF; // chord available
  out[72 + 5] = COL_MODE_OFF; // session available
  out[72 + 6] = COL_MODE_ON; // keyboard active
  out[72 + 7] = COL_MODE_OFF; // drum reserved
  return out;
}

// Author the chord at grid (row, col) into the pinned step on the TARGET track:
// writes the voicing plock, stores the octave as a degree-space pitch offset
// (ChordVoicing has no octave field; one octave = octaveDegrees(scale) degrees),
// and turns the step on so it sounds. Targets the PINNED step (`tieAnchor`) on
// the pinned melodic voice track — works on ANY melodic track, not just the
// chord master (the engine plays the chord for 'semitones'-mode tracks). Returns
// true if a chord was written (false = nothing valid pinned), so the caller
// knows whether to refresh the selector.
function authorChord(device: number, row: number, col: number): boolean {
  if (col > 6) return false;
  const step = pinnedChordStep();
  const t = pinnedVoiceTrack();
  if (step === null || !t) return false;
  const state = useSequencerStore.getState();
  const rung = CHORD_VOICING_LADDER[7 - row];
  const voicing: ChordVoicing = { degree: (col + 1) as ChordVoicing['degree'], ...rung };
  state.setStepChordVoicing(t.id, step, voicing);
  state.setStepPitch(t.id, step, chordOctave[device] * octaveDegrees(state.scale));
  state.setStepOn(t.id, step, true);
  return true;
}

// Resolve + audition the chord at grid (row, col): col → degree I..VII, row →
// voicing ladder (bottom = plainest). Auditions on the current TARGET track's
// voice (the pinned track, else the chord master) at the scene root/scale + the
// track's octave + the device's selected octave, so the audition matches what
// authoring will write. Fire-and-forget.
function auditionCell(device: number, row: number, col: number): void {
  if (col > 6) return;
  const state = useSequencerStore.getState();
  const t = targetMelodicTrack();
  if (!t || t.source.kind !== 'voice') return;
  const rung = CHORD_VOICING_LADDER[7 - row];
  const voicing: ChordVoicing = { degree: (col + 1) as ChordVoicing['degree'], ...rung };
  const { root, intervals } = resolveChord(state.rootNote, state.scale, voicing, 0);
  monitorChord(t, root + (t.octave + chordOctave[device]) * 12, intervals, 0.9);
}

// Repaint one physical device per its current mode: bulk-redraw the page's
// surface, then let the page paint any transient overlay (pulses). Registry-
// driven — adding a page needs no edit here.
function repaintDevice(device: number): void {
  const page = PAGES[deviceMode[device]];
  bulkRedraw(device, page.buildSurface(device));
  page.applyOverlay?.(device);
}

// Release every keyboard note a device is holding (its monitor voices ramp
// down). Used when leaving keyboard mode or detaching so notes never hang.
function releaseKbNotes(device: number): void {
  const tracks = useSequencerStore.getState().tracks;
  for (const [code, held] of kbHeld) {
    if (decodeHeld(code).device !== device) continue;
    const t = tracks.find((tr) => tr.id === held.trackId);
    if (t) monitorRelease(t, held.noteId);
    kbHeld.delete(code);
  }
}

// Set ONE device's page mode (toggling back to 'step' if it's already there),
// repaint just that device. side[4] → chord, side[5] → session, side[6] →
// keyboard; each acts as an on/off toggle from any page.
function setDeviceMode(device: number, mode: DeviceMode): void {
  const next: DeviceMode = deviceMode[device] === mode ? 'step' : mode;
  // Let the outgoing page clean up (e.g. keyboard releases held notes).
  PAGES[deviceMode[device]].onLeave?.(device);
  deviceMode[device] = next;
  lastAuditionPad[device] = -1;
  // No cursor to reset — the chord page authors into the live `tieAnchor` pin,
  // so whatever step is selected on the grid carries straight into chord mode.
  repaintDevice(device);
  applyPendingPulse();
}

// Pulse the pending-bank slot on whichever pad owns its octave (skip if that
// device is on the chord page — its top row is reserved).
function applyPendingPulse(): void {
  const pending = useSequencerStore.getState().pendingBank;
  if (pending === null || pending < 0 || pending >= 16) return;
  const half: 0 | 1 = pending < 8 ? 0 : 1;
  const device = deviceForHalf(half);
  if (deviceMode[device] !== 'step') return; // chord/session own their top row
  setTopPulse(device, pending % 8, COL_BANK_PENDING_PALETTE);
}

// Paint both pads from scratch (full bulk redraw + pending pulse). Used on
// attach, section/swap change, grid edits, and device hot-plug. Each device is
// painted per its own page mode, so a chord-mode pad is left alone.
function repaintBoth(): void {
  for (let device = 0; device < 2; device++) repaintDevice(device);
  applyPendingPulse();
}

function repaintCellAbs(row: number, absStep: number, onPlayhead: boolean): void {
  if (absStep < 0) return;
  const half: 0 | 1 = absStep < 8 ? 0 : 1;
  const col = absStep % 8;
  const device = deviceForHalf(half);
  if (deviceMode[device] !== 'step') return; // chord/session pages own this device
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

// Signature of everything the session matrix draws: which song/scene is live or
// pending, plus each slot's populated mask + saved active scene. The active
// song's row reflects the LIVE composition (its scene mask + activeScene), so
// that's hashed separately from the snapshots.
function sessionSignature(): string {
  const s = useSequencerStore.getState();
  let sig = `${s.performance.activeSong ?? '_'}/${s.performance.pendingSong ?? '_'}`;
  sig += `/${s.composition.activeScene ?? '_'}/${s.composition.pendingScene ?? '_'}`;
  sig += '#' + s.composition.scenes.map((sc) => (sc ? '1' : '0')).join('');
  for (let r = 0; r < 8; r++) {
    const song = s.performance.songs[r];
    sig += song
      ? `|${song.activeScene ?? '_'}:${song.scenes.map((sc) => (sc ? '1' : '0')).join('')}`
      : '|.';
  }
  return sig;
}

// Signature of what the chord-page top row (step selector) draws: the pinned
// step + the TARGET track's id + on-mask over the displayed range. Lets a grid
// click (which moves `tieAnchor`, and so the target track) or a target-track
// edit refresh the selector on the chord pads even though the chord page isn't
// tied to the viewed section.
function chordTopSignature(): string {
  const t = targetMelodicTrack();
  let sig = `${pinnedChordStep() ?? '_'}/${t?.id ?? ''}/${t?.length ?? 0}`;
  if (t) for (let i = 0; i < Math.min(t.length, CHORD_TOP_STEPS); i++) sig += t.steps[i]?.on ? '1' : '0';
  return sig;
}

// Signature of what the keyboard grid draws: scale + root drive the in-key
// layout, root highlight, and dead-key columns. (Octaves are anchored
// absolutely, so the track octave doesn't affect the layout.) A change repaints
// keyboard-mode devices.
function kbSignature(): string {
  const s = useSequencerStore.getState();
  return `${s.scale}/${s.rootNote}`;
}

function toggleSwap(): void {
  swapped = !swapped;
  persistSwapped();
  resetLastPlayheadAbs();
  repaintBoth();
  seedPlayhead();
}

// Side-rail buttons that toggle a device's page mode (reachable from ANY page —
// press again to return to 'step').
const SIDE_PAGE_TOGGLE: Record<number, DeviceMode> = {
  4: 'chord',
  5: 'session',
  6: 'keyboard',
  7: 'drum',
};

// Event dispatcher. A page-toggle side button flips this device's mode; every
// other event routes to the device's current page handler from the registry.
function handleEvent(device: number, e: LaunchpadEvent): void {
  const toggle = e.addr.element === 'side' ? SIDE_PAGE_TOGGLE[e.addr.index] : undefined;
  if (toggle) {
    if (e.pressed) setDeviceMode(device, toggle);
    return;
  }
  PAGES[deviceMode[device]].handleEvent(device, e);
}

// Keyboard page: scale-quantized live play. Pad press → monitor the target
// track's voice (velocity-sensitive); release → ramp that voice down. Side rail
// keeps play / panic live. Top row unused (octave shift is a later option — the
// 8 rows already span 8 octaves). Recording via the per-track arm is planned.
function handleKeyboardEvent(device: number, e: LaunchpadEvent): void {
  if (e.addr.element === 'side') {
    if (!e.pressed) return;
    if (e.addr.index === 0) void togglePlayback();
    else if (e.addr.index === 1) void invoke('midi_panic').catch(() => {});
    return;
  }
  if (e.addr.element !== 'pad') return;
  const code = encodeHeld(device, e.addr.index);
  if (!e.pressed) {
    const held = kbHeld.get(code);
    if (held) {
      const t = useSequencerStore.getState().tracks.find((tr) => tr.id === held.trackId);
      if (t) monitorRelease(t, held.noteId);
      // Write the recorded note's length from how long the pad was held — gate
      // for short notes, a tie chain for longer ones. Shared with the MIDI keyboard.
      if (held.overdub) finalizeRecordedNote(held.overdub);
      kbHeld.delete(code);
    }
    const row = Math.floor(e.addr.index / 8);
    const col = e.addr.index % 8;
    setPadColor(device, e.addr.index, kbBaseColor(row, col, useSequencerStore.getState().scale));
    return;
  }
  const t = targetMelodicTrack();
  if (!t || t.source.kind !== 'voice') return;
  const s = useSequencerStore.getState();
  const row = Math.floor(e.addr.index / 8);
  const col = e.addr.index % 8;
  if (col > octaveDegrees(s.scale)) return; // dead key — outside the scale
  const midi = kbMidi(row, col, s.rootNote, s.scale);
  const noteId = nextKbNoteId++;
  monitorNote(t, midi, Math.max(0.05, e.velocity / 127), noteId);
  // Record into the channel when its record arm is on — same write path as the
  // MIDI keyboard. The keyboard plays ABSOLUTE octaves (track octave not
  // applied), so subtract it: the engine re-adds track.octave on playback, and
  // the stored degree then reproduces the pitch just heard. The returned
  // overdub lets the pad release finalize that step's gate (note length).
  const overdub = t.inputArmed ? writeRecordedNote(t, midi - t.octave * 12, e.velocity / 127) : null;
  kbHeld.set(code, { trackId: t.id, noteId, overdub });
  setPadColor(device, e.addr.index, COL_KB_HELD);
}

// Session page: pads fire songs/scenes; play/panic stay live on the side rail.
function handleSessionEvent(_device: number, e: LaunchpadEvent): void {
  if (!e.pressed) return;
  if (e.addr.element === 'side') {
    if (e.addr.index === 0) void togglePlayback();
    else if (e.addr.index === 1) void invoke('midi_panic').catch(() => {});
    return;
  }
  if (e.addr.element !== 'pad') return; // top row unused in v1
  const row = Math.floor(e.addr.index / 8); // song slot
  const col = e.addr.index % 8; // scene slot
  const store = useSequencerStore.getState();
  if (row === store.performance.activeSong) {
    // Scene jump within the live composition. No-op on the live cell or empty
    // scene slots; loadScene handles stopped→immediate / playing→pendingScene.
    if (!store.composition.scenes[col]) return;
    if (col === store.composition.activeScene) return;
    store.loadScene(col);
    return;
  }
  // Another song's row → swap songs (tail-out when playing). v1 lands on the
  // song's own saved scene regardless of which column was tapped.
  if (!store.performance.songs[row]) return; // empty song slot
  store.loadSong(row);
}

// Chord page: pads audition the degree×voicing chord; play/panic stay live.
function handleChordEvent(device: number, e: LaunchpadEvent): void {
  if (!e.pressed) return;
  if (e.addr.element === 'side') {
    if (e.addr.index === 0) void togglePlayback();
    else if (e.addr.index === 1) void invoke('midi_panic').catch(() => {});
    return;
  }
  if (e.addr.element === 'top') {
    // Step selector — pin a step on the TARGET track as the write target (the
    // same `tieAnchor` pin a grid click sets; tap again to unpin → audition-
    // only). Pins on the current target track, so to author chords on a non-
    // master channel, pin one of its steps from the grid / step-page first.
    const step = e.addr.index;
    const t = targetMelodicTrack();
    if (!t || step >= t.length) return;
    const store = useSequencerStore.getState();
    if (pinnedChordStep() === step) {
      store.setTieAnchor(null);
      store.setSelectedStep(null);
    } else {
      const sel = { trackId: t.id, index: step };
      store.setTieAnchor(sel);
      store.setSelectedStep(sel);
    }
    repaintChordTops();
    return;
  }
  if (e.addr.element !== 'pad') return;
  const row = Math.floor(e.addr.index / 8);
  const col = e.addr.index % 8;
  if (col === 7) {
    // Octave selector — pick this row's octave, re-light the column.
    const oct = octaveForRow(row);
    if (chordOctave[device] !== oct) {
      const prevRow = rowForOctave(chordOctave[device]);
      chordOctave[device] = oct;
      if (prevRow >= 0 && prevRow < 8) setPadColor(device, prevRow * 8 + 7, COL_OCTAVE_OFF);
      setPadColor(device, e.addr.index, COL_OCTAVE_SEL);
    }
    return;
  }
  auditionCell(device, row, col);
  // If a chord-master step is pinned, bind the chord to THAT step (like playing
  // a note onto a pinned step with the keyboard). No advance — pick the next
  // step yourself (grid click or top row). Nothing pinned → audition only.
  if (authorChord(device, row, col)) {
    repaintChordTops();
  }
  // Bright press feedback on this device; restore the previously-lit pad.
  const prev = lastAuditionPad[device];
  lastAuditionPad[device] = e.addr.index;
  if (prev >= 0 && prev !== e.addr.index) setPadColor(device, prev, chordPadBase(device, prev));
  setPadColor(device, e.addr.index, COL_CHORD_PRESSED);
}

function handleStepEvent(device: number, e: LaunchpadEvent): void {
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
    const pin = store.tieAnchor;
    if (!wasOn) {
      // OFF→ON: pin this step so the inspector + chord/keyboard target follow
      // it. tieAnchor survives mouse-leave (selectedStep alone is hover-cleared
      // by TrackGrid); mirror selectedStep too.
      const sel = { trackId: track.id, index: stepIdx };
      store.setTieAnchor(sel);
      store.setSelectedStep(sel);
    } else if (pin && pin.trackId === track.id && pin.index === stepIdx) {
      // ON→OFF on the pinned step: unpin.
      store.setTieAnchor(null);
      store.setSelectedStep(null);
    }
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
      // side[6] (keyboard) / side[7] (drum, reserved) are intercepted by the
      // dispatcher before routing here — pitch nudge was removed (use keyboard
      // mode to set pitch instead).
      default:
        return;
    }
  }
}

// ---------- drum page ----------
// Vertical finger-drum surface, mapped from the BOTTOM: the bottom row (row 7)
// is 8 base-sample trigger pads, L→R = drum channels 1..8 (the drum-section
// tracks, independent of the step pad's viewed section). Tap a trigger pad →
// monitor that voice at natural pitch (velocity from pad pressure) + record the
// hit into the channel if it's record-armed and the transport is running.
// The 7 rows ABOVE each channel are its authoring column — v1 is a ratchet
// ladder: tap a height to set the ratchet (row 6 = ×2 climbing to row 0 = ×8)
// baked into that channel's recorded hits; tap the lit rung again to clear back
// to ×1. (Room here for more per-channel authoring later — probability,
// euclidean fills, etc.)
// The TOP ROW = per-channel RECORD ARM (one pad per channel). Multi: arm any
// subset (or all) and every armed channel captures its hits in one pass — drum
// recording isn't single-target like the melodic arm. Monitoring is always live
// regardless; the arm only gates whether a hit writes to the channel.

// The 8 drum-section voice tracks (column c → channel c+1). Independent of the
// step pad's viewSection, like the chord/keyboard pages target melodic.
function drumTracks(): Track[] {
  return useSequencerStore
    .getState()
    .tracks.filter((t) => t.section === 'drum')
    .slice(0, 8);
}

// Ratchet (1..8) for the ladder row in a channel column: row 6 (just above the
// trigger) = ×2, climbing to row 0 = ×8. Row 7 (the trigger) maps to ×1.
function ratchetForRow(row: number): number {
  return 8 - row;
}
function rowForRatchet(ratchet: number): number {
  return 8 - ratchet;
}

function buildDrumSurface(_device: number): Uint8Array {
  const out = new Uint8Array(SURFACE_SIZE);
  const tracks = drumTracks();
  for (let col = 0; col < 8; col++) {
    const track = tracks[col];
    if (!track) continue; // no channel here → whole column dark
    // Top row = per-channel record arm; the trigger pad also brightens when its
    // channel is armed so the record set reads at a glance from either end.
    out[64 + col] = track.inputArmed ? COL_DRUM_REC_ON : COL_DRUM_REC_OFF;
    out[7 * 8 + col] = track.inputArmed ? COL_DRUM_TRIG_ARMED : COL_DRUM_TRIG;
    const r = drumRatchet[col];
    if (r > 1) {
      const selRow = rowForRatchet(r); // 0..6
      for (let row = selRow; row <= 6; row++) {
        out[row * 8 + col] = row === selRow ? COL_DRUM_LADDER_SEL : COL_DRUM_LADDER;
      }
    }
  }
  const playing = useSequencerStore.getState().playing;
  out[72 + 0] = playing ? COL_PLAY_PLAYING : COL_PLAY_STOPPED;
  out[72 + 1] = COL_PANIC;
  out[72 + 4] = COL_MODE_OFF; // chord available
  out[72 + 5] = COL_MODE_OFF; // session available
  out[72 + 6] = COL_MODE_OFF; // keyboard available
  out[72 + 7] = COL_MODE_ON; // drum active
  return out;
}

// Drum page: bottom row triggers + records; rows above set the ratchet ladder.
function handleDrumEvent(device: number, e: LaunchpadEvent): void {
  if (e.addr.element === 'side') {
    if (!e.pressed) return;
    if (e.addr.index === 0) void togglePlayback();
    else if (e.addr.index === 1) void invoke('midi_panic').catch(() => {});
    return;
  }
  if (e.addr.element === 'top') {
    // Top row = per-channel record arm (multi for drums). Toggle the store's
    // inputArmed via the same setter the app UI uses, so the record dot lights
    // there too; the drumSignature subscription repaints the pad.
    if (!e.pressed) return;
    const t = drumTracks()[e.addr.index];
    if (!t) return; // no channel here
    useSequencerStore.getState().setTrackInputArmed(t.id, !t.inputArmed);
    return;
  }
  if (e.addr.element !== 'pad') return;
  const row = Math.floor(e.addr.index / 8);
  const col = e.addr.index % 8;
  const track = drumTracks()[col];
  if (!track) return; // empty channel column

  if (row === 7) {
    // Trigger pad: ALWAYS monitor the voice; record the hit only if this channel
    // is armed (writeDrumHit then no-ops unless the transport is running). Flash
    // bright on press, restore on release.
    if (e.pressed) {
      const vel = Math.max(0.05, e.velocity / 127);
      monitorDrum(track, vel);
      writeDrumHit(track, e.velocity / 127, drumRatchet[col]); // no-ops unless armed + playing
      setPadColor(device, e.addr.index, COL_DRUM_HIT);
    } else {
      setPadColor(device, e.addr.index, track.inputArmed ? COL_DRUM_TRIG_ARMED : COL_DRUM_TRIG);
    }
    return;
  }

  // Ratchet ladder (rows 0..6): set this channel's ratchet, toggling back to ×1
  // if you tap the already-selected rung. Global state, so repaint every drum
  // pad (cheap — a single bulk redraw, and ratchet taps are infrequent).
  if (!e.pressed) return;
  const r = ratchetForRow(row);
  drumRatchet[col] = drumRatchet[col] === r ? 1 : r;
  for (let d = 0; d < getConnectedCount(); d++) {
    if (deviceMode[d] === 'drum') repaintDevice(d);
  }
}

// Drum page reactivity: repaint when the drum track set changes (a channel
// added/removed → columns shift) OR any drum channel's record arm flips — the
// arm lives in the store now, so a tap (this pad, the other pad, or the app UI)
// repaints the trigger + top-row indicators here. Playing is the cross-page
// side[0] sub.
function drumSignature(): string {
  let s = '';
  for (const t of drumTracks()) s += `|${t.id}:${t.inputArmed ? '1' : '0'}`;
  return s;
}
function drumAttach(): () => void {
  let prev = drumSignature();
  return useSequencerStore.subscribe(() => {
    const next = drumSignature();
    if (next !== prev) {
      prev = next;
      for (let d = 0; d < getConnectedCount(); d++) {
        if (deviceMode[d] === 'drum') repaintDevice(d);
      }
    }
  });
}

// ---------- page registry ----------
// Each page mode is one self-contained object: how to paint a device showing
// it (buildSurface + optional transient applyOverlay), how to handle its
// events, how to clean up when a device leaves it (onLeave), and how to wire
// its own reactive repaints (attach → cleanup). The dispatcher, repaint, and
// mode-switch above are all driven off this map, so a new page (drum, ghost-
// lens) is added by writing one object + registering it here — no central
// branch to edit. Each `attach` keeps its own prev-signature so it repaints
// only when the slice it cares about changes.
interface LaunchpadPage {
  id: DeviceMode;
  buildSurface: (device: number) => Uint8Array;
  applyOverlay?: (device: number) => void;
  handleEvent: (device: number, e: LaunchpadEvent) => void;
  onLeave?: (device: number) => void;
  attach?: () => () => void;
}

// Step page reactivity: the per-step playhead (incremental, via scheduler.onStep
// — cheaper than a store sub which fires on every globalStep) plus a store sub
// for playhead-clear-on-stop, bank top rows, section toggle, and grid edits.
function stepAttach(): () => void {
  const subs: Array<() => void> = [];
  subs.push(scheduler.onStep('launchpad:playhead', () => updatePlayhead()));
  let prevSig = visibleSignature();
  let prevPlaying = useSequencerStore.getState().playing;
  let prevView = useSequencerStore.getState().viewSection;
  let prevBankSig = bankSignature();
  subs.push(
    useSequencerStore.subscribe((state) => {
      // Stop → clear the playhead columns (onStep has stopped firing). The
      // play-button itself is repainted globally (every page shows it).
      if (state.playing !== prevPlaying) {
        prevPlaying = state.playing;
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
          if (deviceMode[device] !== 'step') continue; // chord/session own their top row
          const base = half * 8;
          for (let i = 0; i < 8; i++) {
            const slot = base + i;
            setTopColor(device, i, bankLevel(state.banks[slot] ?? null, slot, state.activeBank, state.pendingBank));
          }
        }
        applyPendingPulse();
      }
      // viewSection toggled (from on-screen UI or our own side button) →
      // repaint both pads with the new section's tracks. Returns early so a
      // section toggle doesn't double-fire the grid-edit branch below.
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
  return () => subs.forEach((u) => u());
}

// Chord page reactivity: a pinned-step move (grid click) or chord-master content
// change refreshes the top-row step selector. repaintChordTops only touches the
// top row, so the lit degree/octave pads underneath are left intact.
function chordAttach(): () => void {
  let prevChordTopSig = chordTopSignature();
  return useSequencerStore.subscribe(() => {
    const next = chordTopSignature();
    if (next !== prevChordTopSig) {
      prevChordTopSig = next;
      repaintChordTops();
    }
  });
}

// Session page reactivity: song/scene swap/queue/commit/populate/clear repaints
// any session-mode pad. Cheap when none is in session mode (loop body skipped).
function sessionAttach(): () => void {
  let prevSessionSig = sessionSignature();
  return useSequencerStore.subscribe(() => {
    const next = sessionSignature();
    if (next !== prevSessionSig) {
      prevSessionSig = next;
      for (let d = 0; d < getConnectedCount(); d++) {
        if (deviceMode[d] === 'session') repaintDevice(d);
      }
    }
  });
}

// Keyboard page reactivity: scale / root change repaints any keyboard-mode pad
// so the in-key layout + root highlight track the scene. Held notes survive
// (buildKeyboardSurface re-lights them from kbHeld).
function keyboardAttach(): () => void {
  let prevKbSig = kbSignature();
  return useSequencerStore.subscribe(() => {
    const next = kbSignature();
    if (next !== prevKbSig) {
      prevKbSig = next;
      for (let d = 0; d < getConnectedCount(); d++) {
        if (deviceMode[d] === 'keyboard') repaintDevice(d);
      }
    }
  });
}

const PAGES: Record<DeviceMode, LaunchpadPage> = {
  step: {
    id: 'step',
    buildSurface: (device) => buildSurfaceForHalf(halfForDevice(device)),
    handleEvent: handleStepEvent,
    attach: stepAttach,
  },
  chord: {
    id: 'chord',
    buildSurface: buildChordSurface,
    handleEvent: handleChordEvent,
    attach: chordAttach,
  },
  session: {
    id: 'session',
    buildSurface: buildSessionSurface,
    applyOverlay: applySessionPulses,
    handleEvent: handleSessionEvent,
    attach: sessionAttach,
  },
  keyboard: {
    id: 'keyboard',
    buildSurface: buildKeyboardSurface,
    handleEvent: handleKeyboardEvent,
    onLeave: releaseKbNotes,
    attach: keyboardAttach,
  },
  drum: {
    id: 'drum',
    buildSurface: buildDrumSurface,
    handleEvent: handleDrumEvent,
    attach: drumAttach,
  },
};

export function attachLaunchpadBindings(): void {
  if (attached) return;
  attached = true;
  repaintBoth();
  seedPlayhead();

  unsubs.push(onLaunchpadEvent(handleEvent));

  // Cross-page: the play/pause button (side[0]) shows on every page, so its
  // state is repainted globally regardless of each device's mode.
  let prevPlaying = useSequencerStore.getState().playing;
  unsubs.push(
    useSequencerStore.subscribe((state) => {
      if (state.playing !== prevPlaying) {
        prevPlaying = state.playing;
        for (let d = 0; d < getConnectedCount(); d++) {
          setSideColor(d, 0, state.playing ? COL_PLAY_PLAYING : COL_PLAY_STOPPED);
        }
      }
    })
  );

  // Hot-plug of a second (or first) pad → repaint everything so the newly
  // present surface gets drawn and swap re-resolves with the new count.
  unsubs.push(
    onLaunchpadConnectionChange(() => {
      resetLastPlayheadAbs();
      repaintBoth();
      seedPlayhead();
    })
  );

  // Each page wires its own reactive repaints and returns a cleanup.
  for (const page of Object.values(PAGES)) {
    const cleanup = page.attach?.();
    if (cleanup) unsubs.push(cleanup);
  }
}

export function detachLaunchpadBindings(): void {
  if (!attached) return;
  for (const u of unsubs) u();
  unsubs = [];
  attached = false;
  resetLastPlayheadAbs();
  releaseKbNotes(0);
  releaseKbNotes(1);
  kbHeld.clear();
  heldPads.clear();
  deviceMode[0] = 'step';
  deviceMode[1] = 'step';
  lastAuditionPad[0] = -1;
  lastAuditionPad[1] = -1;
  chordOctave[0] = 0;
  chordOctave[1] = 0;
  drumRatchet.fill(1);
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    detachLaunchpadBindings();
  });
}
