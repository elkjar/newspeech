import { create } from 'zustand';
import type { Scale } from '../audio/scale';
import { euclidean } from '../audio/euclidean';
import { getOverlay, clearOverlay } from '../audio/mutationOverlay';
import { resetPadDrift } from '../audio/padState';
import {
  defaultLFOs,
  freezeLFOs,
  unfreezeLFOs,
  type LFO,
  type LFODestination,
} from '../audio/lfo';
import {
  PRESETS,
  getInstrument,
  sourceIsMelodic,
  type TrackSource,
} from '../instruments/library';
import { sendPatchSelect, resolveDeviceId } from '../audio/midiOut';
import { voiceTrackDefaults } from '../audio/voices';
import { bankEntropyTotal } from '../ghost/entropy';
import { noteDensityUserInput } from '../ghost/ghost';
import { ensureBothSections, hydrateTrack, hydrateLFOs, applyPositionalRoleDefaults, hydrateBanks, blankTrack } from './hydrate';
import {
  hydrateTape as hydrateTapeFromPreset,
  hydrateGlitch as hydrateGlitchFromPreset,
  hydrateReverb as hydrateReverbFromPreset,
  hydrateSaturation as hydrateSaturationFromPreset,
  hydrateMaster as hydrateMasterFromPreset,
  hydrateSceneGraph,
} from './persist';
import defaultPreset from './defaultPreset.json';
import type { TapeParams } from '../audio/tape';
import type { GlitchParams } from '../audio/glitch';
import type { ReverbParams } from '../audio/reverb';
import type { SaturationParams } from '../audio/saturation';
import { MASTER_PRESETS, type MasterParams } from '../audio/master';
import type { ChordVoicing } from '../audio/chords';
import { resetChordContext } from '../audio/chordContext';

export type EditMode = 'live' | 'velocity' | 'chance' | 'ratchet' | 'timing' | 'gate';

export interface StepSelection {
  trackId: string;
  index: number;
}

export interface Step {
  on: boolean;
  velocity: number;
  pitch: number;
  probability: number;
  ratchet: number;
  microTiming: number;
  gate: number;
  tieToNext: boolean;
  // Optional per-step chord-voicing plock. When undefined, dispatch falls
  // back to the track's `defaultChordVoicing`. The first per-step parameter
  // that's a sparse override rather than a direct field — kept as a clean
  // pattern for any future plocks.
  chordVoicing?: ChordVoicing;
}

export interface EuclideanParams {
  hits: number;
  rotation: number;
}

export type TrackSection = 'drum' | 'melodic';

// How `step.pitch` is interpreted at dispatch on melodic tracks. Four modes:
//   - 'semitones' (UI: ignore) — independent. step.pitch is a scale-degree
//     offset against the scene tonic. Track doesn't follow the chord master.
//   - 'chord-tone' (UI: chord) — follower. step.pitch is an INDEX into the
//     chord master's current chord tones (root / 3rd / 5th / 7th / 9th /
//     11th depending on extension). Big leaps that lock to harmony.
//   - 'scale-tone' (UI: scale) — follower. step.pitch is a scale-degree
//     offset from the chord master's CURRENT root, using the scene scale.
//     Stepwise diatonic walks that move with the chord.
//   - 'root-follow' (UI: drone) — follower. step.pitch ignored, always
//     plays the chord master's current root.
// Row 0 (chord master) ignores its own pitchInterp at dispatch — uses its
// chord voicing for the whole trigger.
export type PitchInterp = 'semitones' | 'chord-tone' | 'scale-tone' | 'root-follow';

export const PITCH_INTERPS: PitchInterp[] = ['semitones', 'chord-tone', 'scale-tone', 'root-follow'];

export type StepRate = '2/1' | '1/1' | '1/2' | '1/4' | '1/8' | '1/16' | '1/32';

// Full rate set, longest-first to match dropdown order. Melodic rows expose
// all entries; drum rows are gated to DRUM_STEP_RATES via the row-panel UI to
// keep the drum workflow within familiar bounds.
export const STEP_RATES: StepRate[] = ['2/1', '1/1', '1/2', '1/4', '1/8', '1/16', '1/32'];
export const DRUM_STEP_RATES: StepRate[] = ['1/4', '1/8', '1/16', '1/32'];

// number of global scheduler ticks per row step. Scheduler runs at 32nds
// (8/beat = 32/bar in 4/4), so:
//   1/32 = 1, 1/16 = 2, 1/8 = 4, 1/4 = 8, 1/2 = 16, 1/1 = 32 (one bar), 2/1 = 64 (two bars).
// A 16-step row at 2/1 = 32 bars per cycle.
export const RATE_STRIDE: Record<StepRate, number> = {
  '2/1': 64,
  '1/1': 32,
  '1/2': 16,
  '1/4': 8,
  '1/8': 4,
  '1/16': 2,
  '1/32': 1,
};

export interface TrackMidi {
  channel: number;
  portName: string | null;
  program: number | null;
  bankMSB: number | null;
  bankLSB: number | null;
  note: number | null;
}

export interface Track {
  id: string;
  source: TrackSource;
  section: TrackSection;
  mute: boolean;
  solo: boolean;
  length: number;
  lastPitch: number;
  viewPage: number;
  mutation: number;
  rowRatchet: number;
  rate: StepRate;
  lockTiming: boolean;
  euclidean: EuclideanParams;
  steps: Step[];
  midi: TrackMidi;
  // sample/internal-synth playback level multiplier; no effect on MIDI velocity
  gain: number;
  // Wet/dry crossfade into the FX bus (0..1). 0 = pure dry, no FX bus
  // contribution. 0.5 = 50/50 dry + wet. 1.0 = pure wet (the dry leg
  // drops out and only the FX bus return is heard). LFO-modulatable.
  fxSend: number;
  // stereo placement (0..1, 0.5 = center). Mapped to [-1,+1] at the audio
  // boundary in samplePlayer. Internal voices/synths only — instrument MIDI
  // rows ignore this (same scope as `gain`).
  pan: number;
  // Track-level default chord voicing — applied by dispatch when a step has
  // no chordVoicing plock. Position-locked behavior (row 1 = chord master)
  // lands in Stage 5; Stage 4 just persists the field so per-step plocks
  // have something to fall back to.
  defaultChordVoicing: ChordVoicing;
  // How `step.pitch` is read on this track. Defaults are positional but
  // user-overridable via the row panel. Ignored for drum tracks and for the
  // chord master row (its own voicing drives the trigger).
  pitchInterp: PitchInterp;
  // Per-track octave offset in octave units (integer, semitones = octave*12).
  // Default 0 for most rows; bass row 1 defaults to -2 so the chord context's
  // root lands in bass range rather than chord-master range. Applied to every
  // melodic trigger after the role-based note resolution.
  octave: number;
  // Per-track Moog-style ladder filter (slice 1: cutoff + resonance). Both in
  // 0..1 store space. Cutoff log-maps to ~50..18000 Hz at the audio boundary;
  // 1.0 = fully open, transparent at default. Resonance 0..1 scales to feedback
  // gain 0..4 inside the worklet (self-oscillates at high values). Internal
  // voices only, same scope as gain/pan/fxSend.
  filterCutoff: number;
  filterResonance: number;
  // When true, retriggering this track chokes its previous active sample
  // sources (soft 20ms release). Useful for bass/lead roles where a long
  // sample tail layering on top of a new trigger sounds wrong. Off by
  // default. Composer sets it true on bass tracks via populateBass; pad /
  // motif / drum tracks leave it false so triggers layer naturally.
  monophonic: boolean;
  // v1 arpeggiator config — per-track toggle. When `on`, multi-note chord
  // triggers (voiceIntervals.length > 1) get split into N sequential
  // single-tone triggers spread evenly across the step duration. Single-
  // note triggers are unaffected. Pattern = "up" (chord intervals in
  // their natural order); range / pattern / gate selection deferred.
  arpConfig?: { on: boolean };
  // Physical output assignment (Tauri app only — the web build's stereo
  // mix bus ignores this). 0-indexed firstChannel; stereo=true routes
  // L→firstChannel + R→firstChannel+1 with the track's pan applied;
  // stereo=false sums L+R*0.5 into firstChannel with pan ignored
  // (bass / kick on a single mono out is the canonical use).
  output: TrackOutput;
}

export interface TrackOutput {
  firstChannel: number;
  stereo: boolean;
}

export const DEFAULT_TRACK_OUTPUT: TrackOutput = { firstChannel: 0, stereo: true };

// Global mix-routing config (Tauri / native engine only). Lives in
// localStorage so the user's physical-interface setup persists across
// app launches independently of any project preset.
//   • multiOut    — master switch. When OFF, every voice + the FX bus
//                   collapse to channels 1-2 regardless of per-track
//                   assignment. When ON, per-track outputs + FX output
//                   land on their configured channels.
//   • fxOutput    — where the FX bus (currently just reverb wet)
//                   lands when multiOut is ON. Default 1-2.
//   • fxBypass    — kills the entire FX chain (pre-master drive +
//                   reverb). Voice fxSend is treated as 0 so dry
//                   passes through at full level and no wet
//                   accumulates; the pre-master saturator is also
//                   skipped. Reverb's own bypass (ReverbParams.bypass)
//                   is independent — it skips only the reverb stage
//                   so the drive remains audible.
export interface NativeMix {
  multiOut: boolean;
  fxOutput: TrackOutput;
  fxBypass: boolean;
}

export const DEFAULT_NATIVE_MIX: NativeMix = {
  multiOut: false,
  fxOutput: { firstChannel: 0, stereo: true },
  fxBypass: false,
};

const LS_NATIVE_MIX = 'newspeech.sequencer.nativeMix';

function readPersistedNativeMix(): NativeMix {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_NATIVE_MIX };
  try {
    const raw = localStorage.getItem(LS_NATIVE_MIX);
    if (!raw) return { ...DEFAULT_NATIVE_MIX };
    const v = JSON.parse(raw) as Partial<NativeMix>;
    const out = v.fxOutput && typeof v.fxOutput === 'object' ? v.fxOutput : DEFAULT_NATIVE_MIX.fxOutput;
    return {
      multiOut: typeof v.multiOut === 'boolean' ? v.multiOut : DEFAULT_NATIVE_MIX.multiOut,
      fxOutput: {
        firstChannel:
          typeof out.firstChannel === 'number' && out.firstChannel >= 0
            ? Math.floor(out.firstChannel)
            : DEFAULT_NATIVE_MIX.fxOutput.firstChannel,
        stereo: typeof out.stereo === 'boolean' ? out.stereo : DEFAULT_NATIVE_MIX.fxOutput.stereo,
      },
      fxBypass: typeof v.fxBypass === 'boolean' ? v.fxBypass : DEFAULT_NATIVE_MIX.fxBypass,
    };
  } catch {
    return { ...DEFAULT_NATIVE_MIX };
  }
}

function writePersistedNativeMix(v: NativeMix): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(LS_NATIVE_MIX, JSON.stringify(v));
  } catch {
    /* quota / private mode — silent */
  }
}

export const DEFAULT_TRACK_MIDI: TrackMidi = {
  channel: 0,
  portName: null,
  program: null,
  bankMSB: null,
  bankLSB: null,
  note: null,
};

// snapshot factory defaults from an instrument id into a track midi config
export function snapshotInstrumentMidi(instrumentId: string): TrackMidi {
  const inst = getInstrument(instrumentId);
  if (!inst) return { ...DEFAULT_TRACK_MIDI };
  return {
    channel: inst.channel,
    portName: inst.portName,
    program: inst.program,
    bankMSB: inst.bankMSB,
    bankLSB: inst.bankLSB,
    note: inst.fixedNote,
  };
}

export const PAGE_SIZE = 16;
export const NUM_PAGES = 4;
export const BANK_SLOT_COUNT = 16;

export interface BankMacros {
  density: number;
  chaos: number;
  motion: number;
  drift: number;
  tension: number;
}

// Bank kind — scene banks are full-length musical sections (dwell governed
// by the ghost's global min/max); transition banks are 1–2 bar inserts
// (drum-mute turnarounds, breakdowns, etc.) that the ghost exits fast.
// Last two pad slots (14, 15) default to 'transition' on new snapshots;
// kind is the authority once set so a user can still snap a scene to those
// slots if they want.
export type BankKind = 'scene' | 'transition';

export interface BankSlot {
  tracks: Track[];
  macros: BankMacros;
  kind: BankKind;
  // The compose recipe that generated this bank — used by the ghost for
  // per-recipe dwell ranges and same-recipe avoidance. Optional: user-saved
  // banks (snapBank) don't have a recipe, in which case the ghost falls
  // back to its global dwell range and any pick is valid.
  recipe?: string;
  // Cached Ghost entropy (0..1). Computed when the slot is written
  // (snapshotBank, ghost.generateBank) and round-tripped in `.seq`. Optional
  // so old saves without the field still load — hydrator recomputes from
  // tracks/macros on load if missing.
  entropy?: number;
  // Per-bank dwell override (bars). When set, ghost uses this exact value
  // instead of recipe-derived or scene-length-aware dwell. Lets the user
  // pin specific banks to specific durations regardless of scene context.
  // Undefined = automatic.
  dwellBars?: number;
}

// A composition's per-scene snapshot — captures everything that should
// swap as a unit when transitioning between scenes. Tracks include voice
// assignments + per-track mix knobs (which DO load fresh at scene swap,
// unlike bank swap which preserves "band identity"). Banks are the full
// 16-slot palette for that scene. Macros + sceneGraph drive ghost
// behavior within that scene.
//
// Master FX (saturation/glitch/reverb/tape), BPM, scale, rootNote stay
// global across scenes — per user [[project_scene_session]] direction
// 2026-05-20 ("FX stays global").
export interface Scene {
  name?: string;
  tracks: Track[];
  banks: (BankSlot | null)[];
  activeBank: number | null;
  macros: BankMacros;
  sceneGraph: SceneGraphConfig;
}

export const COMPOSITION_SLOT_COUNT = 8;

export interface Composition {
  scenes: (Scene | null)[];
  activeScene: number | null;
  // Bar-boundary queued scene swap — mirrors pendingBank for banks.
  // Cleared on commit, on transport stop, and on explicit disarm. UI
  // pulses the pending slot until commit lands.
  pendingScene: number | null;
  // When true, composition stops after the last scene's shape completes
  // (vs. looping back to scene 0). Mirrors the "defined ending" framing
  // for piece-shaped compositions.
  endsAfterLast: boolean;
}

// Song = one composition as it sits in a Performance slot. Captures
// everything that changes between songs in a set: the full composition
// (scenes + ordering + endsAfterLast), the bank palette behind those
// scenes, the live tracks, macros, sceneGraph, and the song-level
// globals (bpm / rootNote / scale / lfos). Master FX and nativeMix
// stay global per [[project_scene_session]].
export interface Song {
  name?: string;
  tracks: Track[];
  banks: (BankSlot | null)[];
  activeBank: number | null;
  macros: BankMacros;
  sceneGraph: SceneGraphConfig;
  scenes: (Scene | null)[];
  activeScene: number | null;
  endsAfterLast: boolean;
  bpm: number;
  rootNote: number;
  scale: Scale;
  lfos: LFO[];
}

export const PERFORMANCE_SLOT_COUNT = 8;

export interface Performance {
  songs: (Song | null)[];
  activeSong: number | null;
  // Bar-boundary queued song swap, with optional tail-out gap before the
  // snap lands. While `pendingSong` is set and `tailOutBarsRemaining > 0`,
  // the scheduler stops emitting fresh triggers so existing voices ring
  // out cleanly; when the count reaches 0 we applySong atomically.
  pendingSong: number | null;
  tailOutBarsRemaining: number;
  // How many bars of tail-out gap to insert before snapping to a queued
  // song. 0 = atomic swap on next bar boundary (same as scene swap).
  tailOutBars: number;
}

export const DEFAULT_PERFORMANCE: Performance = {
  songs: Array.from({ length: PERFORMANCE_SLOT_COUNT }, () => null),
  activeSong: null,
  pendingSong: null,
  tailOutBarsRemaining: 0,
  tailOutBars: 2,
};

// Toast for user-facing app notifications. Surface for: recording finalize
// confirmation + error reporting (silent failures = lost takes the user
// didn't know about). Kept generic enough to grow other event sources.
//   kind: success auto-dismisses after AUTO_DISMISS_MS in the Toast
//         component; error is sticky until manually closed.
//   revealPath: optional Tauri-only path to open in Finder on click.
export interface Toast {
  id: string;
  kind: 'success' | 'error';
  text: string;
  revealPath?: string;
  createdAt: number;
}

// Ghost picker rationale entry — one record per bank change, autonomous
// or manual. Lives in the store as a small ring buffer so GhostDebug can
// render the recent decision history (datafeed framing per
// [[project_ghost_overlay]]). Transient — not persisted in `.seq`.
//
// Two kinds:
//   'auto' — ghost picker fired; captures full context (target curve
//     value, winner entropy, delta, candidate pool, shape phase).
//   'manual' — user-driven swap (click, blank-start) where the rich
//     context doesn't apply. Still captures globalStep + slot so the
//     log shows EVERY change in order. applyBankSlot dedupes against
//     a recent auto entry for the same slot so an auto pick that
//     reaches commit doesn't get a duplicate manual entry.
export type GhostPickLogEntry =
  | {
      kind: 'auto';
      globalStep: number;
      slot: number;
      shape: 'sustain' | 'build' | 'arc' | 'wave' | 'decay';
      phase: number;
      target: number;
      pickedEntropy: number;
      deltaFromTarget: number;
      candidateCount: number;
      // Filled by tickBar AFTER the dwell roll lands. Indicates how many
      // bars ghost will hold this bank before considering the next pick.
      dwellBars?: number;
    }
  | {
      kind: 'manual';
      globalStep: number;
      slot: number;
      // 12-char hex nonce, generated at push time. Split into three 4-char
      // chunks at render time so manual rows fill the same visual column
      // width as auto rows. Purely cosmetic — datafeed framing.
      nonce: string;
      dwellBars?: number;
    }
  | {
      kind: 'shape';
      globalStep: number;
      from: 'sustain' | 'build' | 'arc' | 'wave' | 'decay';
      to: 'sustain' | 'build' | 'arc' | 'wave' | 'decay';
    }
  | { kind: 'ghost'; globalStep: number; enabled: boolean }
  | { kind: 'transport'; globalStep: number; playing: boolean }
  // Pre-filled startup-sequence rows + future system messages. Rendered
  // with the same hex-chunk styling as manual entries so the log isn't
  // empty on first launch. Pure flavor — no semantic meaning.
  | { kind: 'system'; globalStep: number; label: string; nonce: string }
  // Step placement — pushed when a step is turned ON via toggleStep.
  // Captures track/step coords + the step's velocity as the numerical
  // value. Step-off toggles are not logged (placement, not removal).
  | {
      kind: 'step';
      globalStep: number;
      track: number;
      step: number;
      value: number;
    }
  | {
      kind: 'scene';
      globalStep: number;
      slot: number;
    };

export const GHOST_PICK_LOG_LIMIT = 16;

// Ghost scene-graph config. `shape` + `phaseLength` drive the entropy-aware
// picker introduced 2026-05-20:
//   sustain — no target; picker zig-zags around current entropy
//   build   — target ramps low→high over phaseLength bars, then holds high
//   arc     — target curves low→high→low (sin), one full arc over phaseLength
//   wave    — target oscillates as sin with phaseLength = period (loops)
//   decay   — target ramps high→low over phaseLength bars, then holds low
// `phaseLength` interpretation depends on shape (full duration for
// build/arc/decay; one full oscillation period for wave; ignored for sustain).
// transitionBars lerps the 5 global macros from the previous bank's effective
// values to the new bank's saved values over N bars at the start of each
// scene; 0 = atomic snap.
export type SceneShape = 'sustain' | 'build' | 'arc' | 'wave' | 'decay';

export const SCENE_SHAPES: SceneShape[] = ['sustain', 'build', 'arc', 'wave', 'decay'];

export type BankOrderMode = 'entropy' | 'sequence';

export interface SceneGraphConfig {
  enabled: boolean;
  minBars: number;
  maxBars: number;
  transitionBars: number;
  shape: SceneShape;
  phaseLength: number;
  // 'entropy' (default): ghost picks banks via shape curve + entropy
  // delta + slot-distance bias. 'sequence': ghost walks filled scene
  // banks in slot order, wrapping at the end. Same-recipe avoidance +
  // entropy weighting are skipped — slot order is the user's authored
  // intent. Shape + phase still drive density envelope independent of
  // picker mode.
  bankOrderMode: BankOrderMode;
}

export const DEFAULT_SCENE_GRAPH: SceneGraphConfig = {
  enabled: false,
  minBars: 8,
  maxBars: 24,
  transitionBars: 4,
  shape: 'arc',
  phaseLength: 128,
  bankOrderMode: 'entropy',
};

interface SequencerState {
  bpm: number;
  rootNote: number;
  scale: Scale;
  tracks: Track[];
  lfos: LFO[];
  selectingLFO: number | null;
  globalStep: number;
  // Phase reference for per-track step math. Reset to current globalStep on
  // every bank swap so each scene's tracks start at their own step 0 — needed
  // for polyrhythmic content where length-N tracks would otherwise pick up
  // mid-cycle at swap moments (the math is `globalStep % length`, which only
  // lands on 0 at bar boundaries for length 16).
  sceneStartStep: number;
  playing: boolean;
  editMode: EditMode;
  midiOutDeviceId: string | null;
  viewSection: TrackSection;
  density: number;
  chaos: number;
  motion: number;
  drift: number;
  tension: number;
  freeze: boolean;
  // Recorder arm state. The audio recorder (`audio/recorder.ts`) subscribes
  // to the store and records when `armed && playing`. Auto-disarms when a
  // take finalizes — one explicit arm per take.
  armed: boolean;
  setArmed: (v: boolean) => void;
  toggleArmed: () => void;
  // Count-in toggle. When true, `togglePlayback` schedules one bar of
  // quarter-note clicks before the scheduler's first step. Session-only;
  // not persisted to .seq.
  clickIn: boolean;
  setClickIn: (v: boolean) => void;
  toggleClickIn: () => void;
  // Recorder tap-point toggle. When false: recorder taps master output
  // (what the user hears, all FX baked in). When true: recorder taps
  // voicesBus pre-everything — raw sample audio with no master / tape /
  // glitch / reverb / saturation processing. The audible output is
  // unaffected either way; this only swaps where the WAV's data comes
  // from. Useful for DAW workflows where you want the sequencer's
  // character live but a clean source to process in the DAW.
  recordRaw: boolean;
  setRecordRaw: (v: boolean) => void;
  toggleRecordRaw: () => void;
  // Splits toggle. When true, a take produces two WAVs (rhythm + melody)
  // instead of one combined. Forces sample-bus tap territory; `recordRaw`
  // becomes a no-op while splits is on. Count-in clicks land in both splits
  // for DAW alignment.
  splits: boolean;
  setSplits: (v: boolean) => void;
  toggleSplits: () => void;
  // Multitrack toggle. When true, a take produces one WAV per audio-
  // producing track (16+ files) tapped from per-track recording buses,
  // pre-FX/pre-master. Mutually exclusive with `splits`. Toggling this on
  // also flips `recordRaw` on for visual coherence — multitrack inherently
  // captures raw signal.
  multitrack: boolean;
  setMultitrack: (v: boolean) => void;
  toggleMultitrack: () => void;
  tape: TapeParams;
  setTape: (patch: Partial<TapeParams>) => void;
  glitch: GlitchParams;
  setGlitch: (patch: Partial<GlitchParams>) => void;
  reverb: ReverbParams;
  setReverb: (patch: Partial<ReverbParams>) => void;
  nativeMix: NativeMix;
  setNativeMix: (patch: Partial<NativeMix>) => void;
  saturation: SaturationParams;
  setSaturation: (patch: Partial<SaturationParams>) => void;
  master: MasterParams;
  setMaster: (patch: Partial<MasterParams>) => void;
  setMasterPreset: (name: string) => void;
  setDensity: (v: number) => void;
  setChaos: (v: number) => void;
  setMotion: (v: number) => void;
  setDrift: (v: number) => void;
  setTension: (v: number) => void;
  setFreeze: (v: boolean) => void;
  toggleFreeze: () => void;
  setViewSection: (section: TrackSection) => void;
  setMidiOutDeviceId: (id: string | null) => void;
  setTrackSource: (trackId: string, source: TrackSource) => void;
  applyPreset: (presetId: string) => void;
  initProject: () => void;
  fireAllProgramChanges: () => void;
  setTrackMidi: (trackId: string, patch: Partial<TrackMidi>) => void;
  fireTrackProgram: (trackId: string) => void;
  setEditMode: (mode: EditMode) => void;
  selectedStep: StepSelection | null;
  setSelectedStep: (sel: StepSelection | null) => void;
  tieAnchor: StepSelection | null;
  setTieAnchor: (sel: StepSelection | null) => void;
  setLFODepth: (id: number, depth: number) => void;
  toggleLFODestination: (id: number, destination: LFODestination) => void;
  clearLFODestinations: (id: number) => void;
  setSelectingLFO: (id: number | null) => void;
  setBpm: (bpm: number) => void;
  setRootNote: (midi: number) => void;
  setScale: (scale: Scale) => void;
  toggleStep: (trackId: string, index: number) => void;
  setStepPitch: (trackId: string, index: number, pitch: number) => void;
  setStepVelocity: (trackId: string, index: number, velocity: number) => void;
  setStepProbability: (trackId: string, index: number, probability: number) => void;
  setStepRatchet: (trackId: string, index: number, ratchet: number) => void;
  setStepMicroTiming: (trackId: string, index: number, microTiming: number) => void;
  setStepGate: (trackId: string, index: number, gate: number) => void;
  setStepTie: (trackId: string, index: number, tied: boolean) => void;
  setStepChordVoicing: (trackId: string, index: number, voicing: ChordVoicing | undefined) => void;
  setTrackDefaultChordVoicing: (trackId: string, voicing: ChordVoicing) => void;
  setTrackPitchInterp: (trackId: string, pitchInterp: PitchInterp) => void;
  setTrackOctave: (trackId: string, octave: number) => void;
  setTrackMutation: (trackId: string, mutation: number) => void;
  setTrackGain: (trackId: string, gain: number) => void;
  setTrackFxSend: (trackId: string, fxSend: number) => void;
  setTrackPan: (trackId: string, pan: number) => void;
  setTrackFilterCutoff: (trackId: string, cutoff: number) => void;
  setTrackFilterResonance: (trackId: string, resonance: number) => void;
  setTrackRate: (trackId: string, rate: StepRate) => void;
  setTrackLockTiming: (trackId: string, lock: boolean) => void;
  setTrackRowRatchet: (trackId: string, rowRatchet: number) => void;
  setTrackArpOn: (trackId: string, on: boolean) => void;
  setTrackOutput: (trackId: string, output: TrackOutput) => void;
  clearTrack: (trackId: string) => void;
  commitMutationOverlay: () => void;
  setTrackMute: (trackId: string, mute: boolean) => void;
  setTrackSolo: (trackId: string, solo: boolean) => void;
  setTrackLength: (trackId: string, length: number) => void;
  setTrackPage: (trackId: string, page: number) => void;
  setTrackEuclidean: (trackId: string, partial: Partial<EuclideanParams>) => void;
  setGlobalStep: (step: number) => void;
  setPlaying: (playing: boolean) => void;
  banks: (BankSlot | null)[];
  activeBank: number | null;
  pendingBank: number | null;
  snapBank: (i: number) => void;
  queueBank: (i: number) => void;
  clearBank: (i: number) => void;
  moveBank: (from: number, to: number) => void;
  startBlankBank: (i: number) => void;
  setBankDwell: (i: number, bars: number | null) => void;
  // atGlobalStep is the scheduler's currentStep at swap time. Caller passes
  // the scheduler globalStep parameter rather than letting the store read
  // its own (potentially-lagging audible-step) globalStep — the dispatch's
  // sceneStep math is keyed off the SCHEDULED step, not the audible step.
  commitPendingBank: (atGlobalStep: number) => void;
  // Composition layer — list of Scenes plus the active scene index.
  // Scene swap loads everything per-scene fresh (tracks/banks/macros/
  // sceneGraph) while keeping master FX + tempo + scale truly global.
  composition: Composition;
  snapScene: (i: number) => void;
  loadScene: (i: number) => void;
  clearScene: (i: number) => void;
  commitPendingScene: (atGlobalStep: number) => void;
  moveScene: (from: number, to: number) => void;
  setCompositionEndsAfterLast: (v: boolean) => void;
  // Insert a Scene snapshot (typically built via parseSceneFromSeq from
  // an external `.seq` file) into the next empty composition slot.
  // Returns the assigned slot index, or null when all slots are full.
  importScene: (scene: Scene) => number | null;
  // Performance layer — slots of Songs (full compositions). Click load
  // queues a swap that lands after the configured tail-out gap; the
  // entire piece (tracks + banks + scenes + bpm + key + scale + LFOs)
  // swaps atomically when the gap elapses.
  performance: Performance;
  snapSong: (i: number) => void;
  loadSong: (i: number) => void;
  clearSong: (i: number) => void;
  moveSong: (from: number, to: number) => void;
  commitPendingSong: (atGlobalStep: number) => void;
  tickPerformanceTailOut: () => void;
  setPerformanceTailOutBars: (bars: number) => void;
  importSong: (song: Song) => number | null;
  // Replace the entire performance container (used when loading a
  // `.seqset` file). Caller passes an already-hydrated Performance —
  // hydration logic lives in persist.ts to keep store free of JSON
  // parsing concerns.
  replacePerformance: (performance: Performance) => void;
  // Ghost — persisted config + transient display state. Display fields
  // (`ghostBarsRemaining`, `ghostTargetBars`) are written by the
  // ghost module each bar; not part of saved state.
  sceneGraph: SceneGraphConfig;
  ghostBarsRemaining: number;
  ghostTargetBars: number;
  // Composition-level step reference for shape phase. Unlike sceneStartStep
  // (which resets on every bank swap), this persists across swaps so the
  // arc/build/decay phase counts up over the full phaseLength. Reset to
  // current globalStep when transport restarts or ghost is re-enabled.
  ghostCompositionStartStep: number;
  // Pick-rationale ring buffer (newest last). GhostDebug renders the tail
  // as a datafeed. Cleared on resetGhost.
  ghostPickLog: GhostPickLogEntry[];
  setSceneGraphEnabled: (enabled: boolean) => void;
  setSceneGraphMinBars: (bars: number) => void;
  setSceneGraphMaxBars: (bars: number) => void;
  setSceneGraphTransitionBars: (bars: number) => void;
  setSceneGraphShape: (shape: SceneShape) => void;
  setSceneGraphPhaseLength: (bars: number) => void;
  setSceneGraphBankOrderMode: (mode: BankOrderMode) => void;
  setGhostDisplay: (remaining: number, target: number) => void;
  setGhostCompositionStart: (step: number) => void;
  pushGhostPickEvent: (entry: GhostPickLogEntry) => void;
  setDwellOnLastBankChange: (slot: number, dwellBars: number) => void;
  clearGhostPickLog: () => void;
  toasts: Toast[];
  pushToast: (t: Omit<Toast, 'id' | 'createdAt'>) => void;
  dismissToast: (id: string) => void;
  setMacros: (m: Partial<BankMacros>) => void;
}

export const MAX_STEPS = 64;
export const DEFAULT_LENGTH = 16;

function emptySteps(): Step[] {
  return Array.from({ length: MAX_STEPS }, () => ({
    on: false,
    velocity: 1,
    pitch: 0,
    probability: 100,
    ratchet: 1,
    microTiming: 0,
    gate: 1,
    tieToNext: false,
  }));
}

// Apply a partial update to active tracks AND every saved bank's tracks
// for the matching trackId. Used by GLOBAL per-track knobs (gain / fxSend
// / pan / filterCutoff / filterResonance / octave) so user-adjusted mix
// settings persist across bank swaps. Pattern fields (steps / length /
// mutation / etc) deliberately do NOT use this — those stay per-bank so
// each pattern can have its own rhythmic state.
function propagateTrackUpdate(
  state: SequencerState,
  trackId: string,
  updates: Partial<Track>,
): { tracks: Track[]; banks: (BankSlot | null)[] } {
  return {
    tracks: state.tracks.map((t) =>
      t.id === trackId ? { ...t, ...updates } : t
    ),
    banks: state.banks.map((bank) => {
      if (!bank) return bank;
      if (!bank.tracks.some((t) => t.id === trackId)) return bank;
      return {
        ...bank,
        tracks: bank.tracks.map((t) =>
          t.id === trackId ? { ...t, ...updates } : t
        ),
      };
    }),
  };
}

// Voice-update logic shared between active-track and bank-snapshot updates
// inside setTrackSource. Each per-bank track gets evaluated independently —
// addingMelodic / sameInstrument / sameVoice checks compare against THAT
// bank's prior source, so banks already on the new voice keep their custom
// edits (sameVoice short-circuits the trackDefaults wipe) while banks on a
// different voice receive the fresh defaults.
function updateTrackVoice(t: Track, source: TrackSource): Track {
  const sameInstrument =
    source.kind === 'instrument' &&
    t.source.kind === 'instrument' &&
    t.source.id === source.id;
  const midi =
    source.kind === 'instrument' && !sameInstrument
      ? snapshotInstrumentMidi(source.id)
      : t.midi;
  // Empty → melodic transition resets pitchInterp to 'semitones' (UI
  // label: "ignore"). Without this, a previously-empty row inherits
  // whatever follower mode the preset slot was last in (often
  // chord-tone), which makes "add a new melodic channel" surprising.
  const addingMelodic = t.source.kind === 'empty' && sourceIsMelodic(source);
  const pitchInterp = addingMelodic ? 'semitones' : t.pitchInterp;
  // Voice-specific track-mix defaults (cutoff / fxSend / gain / etc).
  // Applied only when switching TO a different voice — same-voice
  // re-selection preserves user edits. Mirrors the sameInstrument
  // midi-reset logic above.
  const sameVoice =
    source.kind === 'voice' &&
    t.source.kind === 'voice' &&
    t.source.id === source.id;
  const voiceDefs =
    source.kind === 'voice' && !sameVoice
      ? voiceTrackDefaults(source.id)
      : undefined;
  return { ...t, source, midi, pitchInterp, ...(voiceDefs ?? {}) };
}

export function cloneTrack(t: Track): Track {
  return {
    ...t,
    source: { ...t.source } as TrackSource,
    midi: { ...t.midi },
    euclidean: { ...t.euclidean },
    defaultChordVoicing: { ...t.defaultChordVoicing },
    steps: t.steps.map((s) => ({
      ...s,
      chordVoicing: s.chordVoicing ? { ...s.chordVoicing } : undefined,
    })),
  };
}

// Pad-slot indices 14 and 15 are the last two on the 1×16 pad row. Newly
// snapped banks at those slots default to 'transition' kind so the user's
// "transition pattern" convention requires no extra UI gesture.
export const TRANSITION_SLOT_START = 14;

function snapshotBank(
  state: {
    tracks: Track[];
    density: number;
    chaos: number;
    motion: number;
    drift: number;
    tension: number;
  },
  slotIndex: number
): BankSlot {
  const slot: BankSlot = {
    tracks: state.tracks.map(cloneTrack),
    macros: {
      density: state.density,
      chaos: state.chaos,
      motion: state.motion,
      drift: state.drift,
      tension: state.tension,
    },
    kind: slotIndex >= TRANSITION_SLOT_START ? 'transition' : 'scene',
  };
  slot.entropy = bankEntropyTotal(slot);
  return slot;
}

const rawPresetTracks = defaultPreset.tracks as Array<Partial<Track> & { id: string }>;
const presetTracks = applyPositionalRoleDefaults(
  ensureBothSections(rawPresetTracks.map(hydrateTrack)),
  rawPresetTracks
);
// Seed the chord context against the preset's scene root + scale so the very
// first follower-row trigger (before the chord master has played a step)
// harmonizes against the preset's intended key rather than the chord-context
// module's hardcoded C-major fallback.
resetChordContext(defaultPreset.rootNote, defaultPreset.scale as Scale);

function clamp01(v: unknown, fallback = 0.5): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.max(0, Math.min(1, v))
    : fallback;
}

const initialMacros: BankMacros = {
  density: clamp01((defaultPreset as { density?: unknown }).density),
  chaos: clamp01((defaultPreset as { chaos?: unknown }).chaos),
  motion: clamp01((defaultPreset as { motion?: unknown }).motion, 0.5),
  drift: clamp01((defaultPreset as { drift?: unknown }).drift, 1),
  tension: clamp01((defaultPreset as { tension?: unknown }).tension),
};

// Hydrate banks from the preset when provided. Fallback seeder runs when
// the preset has no `banks` field — preserves the legacy single-slot init.
const initialBanks: (BankSlot | null)[] = hydrateBanks(
  (defaultPreset as { banks?: unknown }).banks,
  () => ({
    tracks: presetTracks.map(cloneTrack),
    macros: { ...initialMacros },
  })
);

// Startup-sequence prefill for the GhostDebug event log. Rendered with the
// same hex-chunk styling as manual entries so the log surface isn't empty
// on first launch. Pure flavor — datafeed framing.
function bootNonce(): string {
  let s = '';
  while (s.length < 12) s += Math.random().toString(16).slice(2);
  return s.slice(0, 12).toUpperCase();
}
const STARTUP_LOG: GhostPickLogEntry[] = [
  { kind: 'system', globalStep: 0, label: 'boot', nonce: bootNonce() },
  { kind: 'system', globalStep: 0, label: 'palette', nonce: bootNonce() },
  { kind: 'system', globalStep: 0, label: 'entropy', nonce: bootNonce() },
  { kind: 'system', globalStep: 0, label: 'ghost idle', nonce: bootNonce() },
  { kind: 'system', globalStep: 0, label: 'ready', nonce: bootNonce() },
];

// Validate activeBank: must be a populated slot, else fall back to the first
// populated slot (or 0 if none).
const rawActiveBank = (defaultPreset as { activeBank?: unknown }).activeBank;
const requestedActive =
  typeof rawActiveBank === 'number' && Number.isFinite(rawActiveBank)
    ? Math.max(0, Math.min(BANK_SLOT_COUNT - 1, Math.floor(rawActiveBank)))
    : 0;
const initialActiveBank = initialBanks[requestedActive]
  ? requestedActive
  : initialBanks.findIndex((b) => b !== null) >= 0
    ? initialBanks.findIndex((b) => b !== null)
    : 0;

function fireTrackProgramChange(track: Track, fallbackId: string | null): void {
  if (track.source.kind !== 'instrument') return;
  const { channel, portName, program, bankMSB, bankLSB } = track.midi;
  if (program === null && bankMSB === null && bankLSB === null) return;
  const deviceId = resolveDeviceId(portName, fallbackId);
  if (!deviceId) return;
  sendPatchSelect(deviceId, channel, bankMSB, bankLSB, program);
}

export const useSequencerStore = create<SequencerState>((set) => ({
  bpm: defaultPreset.bpm,
  rootNote: defaultPreset.rootNote,
  scale: defaultPreset.scale as Scale,
  tracks: presetTracks,
  lfos: hydrateLFOs((defaultPreset as { lfos?: LFO[] }).lfos),
  selectingLFO: null,
  globalStep: 0,
  sceneStartStep: 0,
  playing: false,
  editMode: 'live',
  midiOutDeviceId: null,
  viewSection: 'drum',
  density: initialMacros.density,
  chaos: initialMacros.chaos,
  motion: initialMacros.motion,
  drift: initialMacros.drift,
  tension: initialMacros.tension,
  banks: initialBanks,
  activeBank: initialActiveBank,
  pendingBank: null,
  freeze: false,
  armed: false,
  setArmed: (v) => set({ armed: v }),
  toggleArmed: () => set((s) => ({ armed: !s.armed })),
  clickIn: false,
  setClickIn: (v) => set({ clickIn: v }),
  toggleClickIn: () => set((s) => ({ clickIn: !s.clickIn })),
  recordRaw: false,
  setRecordRaw: (v) => set({ recordRaw: v }),
  toggleRecordRaw: () => set((s) => ({ recordRaw: !s.recordRaw })),
  splits: false,
  setSplits: (v) => set({ splits: v }),
  toggleSplits: () => set((s) => ({ splits: !s.splits, multitrack: false })),
  multitrack: false,
  setMultitrack: (v) => set({ multitrack: v }),
  toggleMultitrack: () =>
    set((s) => {
      const next = !s.multitrack;
      return { multitrack: next, recordRaw: next, splits: next ? false : s.splits };
    }),
  sceneGraph: hydrateSceneGraph((defaultPreset as { sceneGraph?: unknown }).sceneGraph),
  ghostBarsRemaining: 0,
  ghostTargetBars: 0,
  ghostCompositionStartStep: 0,
  ghostPickLog: [...STARTUP_LOG],
  toasts: [],
  composition: {
    scenes: Array.from({ length: COMPOSITION_SLOT_COUNT }, () => null),
    activeScene: null,
    pendingScene: null,
    endsAfterLast: true,
  },
  performance: { ...DEFAULT_PERFORMANCE, songs: [...DEFAULT_PERFORMANCE.songs] },
  // FX param setters are pure state writes. The canonical store→worklet
  // bridge lives in `audio/fxModulation.ts` (RAF loop, started at first
  // play); it reads these slices each frame, applies LFO modulation, and
  // pushes resolved values to the worklets. Pre-first-play: knob moves
  // update store only — worklets get the current state at play time
  // via the explicit setXParams calls in `audio/transport.ts`.
  tape: hydrateTapeFromPreset((defaultPreset as { tape?: unknown }).tape),
  setTape: (patch) =>
    set((state) => ({ tape: { ...state.tape, ...patch } })),
  glitch: hydrateGlitchFromPreset((defaultPreset as { glitch?: unknown }).glitch),
  setGlitch: (patch) =>
    set((state) => ({ glitch: { ...state.glitch, ...patch } })),
  reverb: hydrateReverbFromPreset((defaultPreset as { reverb?: unknown }).reverb),
  setReverb: (patch) =>
    set((state) => ({ reverb: { ...state.reverb, ...patch } })),
  nativeMix: readPersistedNativeMix(),
  setNativeMix: (patch) =>
    set((state) => {
      const merged: NativeMix = { ...state.nativeMix, ...patch };
      // Merge fxOutput deeply since partial patches may carry just one
      // of its fields. The bool/scalar fields are flat-merged above.
      if (patch.fxOutput) {
        merged.fxOutput = { ...state.nativeMix.fxOutput, ...patch.fxOutput };
      }
      writePersistedNativeMix(merged);
      return { nativeMix: merged };
    }),
  saturation: hydrateSaturationFromPreset((defaultPreset as { saturation?: unknown }).saturation),
  setSaturation: (patch) =>
    set((state) => ({ saturation: { ...state.saturation, ...patch } })),
  master: hydrateMasterFromPreset((defaultPreset as { master?: unknown }).master),
  setMaster: (patch) =>
    set((state) => ({ master: { ...state.master, ...patch } })),
  setMasterPreset: (name) =>
    set(() => {
      const preset = MASTER_PRESETS[name];
      if (!preset) return {};
      return { master: { ...preset } };
    }),
  setDensity: (v) => {
    // Notify ghost that the user touched density so its per-frame smoother
    // backs off for ~2 bars (lets the user hold the knob at a value without
    // ghost immediately yanking it back).
    noteDensityUserInput();
    set({ density: clamp01(v) });
  },
  setChaos: (v) => set({ chaos: clamp01(v) }),
  setMotion: (v) => set({ motion: clamp01(v) }),
  setDrift: (v) => set({ drift: clamp01(v) }),
  setTension: (v) => set({ tension: clamp01(v) }),
  setFreeze: (v) => {
    if (v) freezeLFOs(useSequencerStore.getState().lfos);
    else unfreezeLFOs();
    set({ freeze: v });
  },
  toggleFreeze: () => {
    const next = !useSequencerStore.getState().freeze;
    if (next) freezeLFOs(useSequencerStore.getState().lfos);
    else unfreezeLFOs();
    set({ freeze: next });
  },
  setViewSection: (viewSection) => set({ viewSection }),
  setMidiOutDeviceId: (midiOutDeviceId) => set({ midiOutDeviceId }),
  setTrackSource: (trackId, source) => {
    // Voice changes propagate band-wide: active tracks AND every saved bank
    // get the same voice update applied to the matching trackId. Voice =
    // band identity (source + midi + pitchInterp + voice trackDefaults).
    // Pattern state (steps / length / mutation / etc.) stays per-bank since
    // that's "what the band is playing right now," not "who the band is."
    let nextTrack: Track | null = null;
    set((state) => {
      const newTracks = state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        nextTrack = updateTrackVoice(t, source);
        return nextTrack;
      });
      const newBanks = state.banks.map((bank) => {
        if (!bank) return bank;
        const bankHasTrack = bank.tracks.some((t) => t.id === trackId);
        if (!bankHasTrack) return bank;
        return {
          ...bank,
          tracks: bank.tracks.map((t) =>
            t.id === trackId ? updateTrackVoice(t, source) : t
          ),
        };
      });
      return { tracks: newTracks, banks: newBanks };
    });
    if (nextTrack) {
      const { midiOutDeviceId } = useSequencerStore.getState();
      fireTrackProgramChange(nextTrack, midiOutDeviceId);
    }
  },
  applyPreset: (presetId) => {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const firedTracks: Track[] = [];
    set((state) => {
      const visible = state.tracks.filter((t) => t.section === state.viewSection);
      return {
        tracks: state.tracks.map((t) => {
          const idx = visible.findIndex((v) => v.id === t.id);
          if (idx < 0) return t;
          const slot = preset.slots[idx];
          if (!slot || slot.kind === 'empty') return t;
          const next: TrackSource =
            slot.kind === 'voice'
              ? { kind: 'voice', id: slot.id }
              : { kind: 'instrument', id: slot.id };
          // snapshot midi when assigning a different instrument; same-id
          // reapply preserves user edits.
          const sameInstrument =
            next.kind === 'instrument' &&
            t.source.kind === 'instrument' &&
            t.source.id === next.id;
          const midi =
            next.kind === 'instrument' && !sameInstrument
              ? snapshotInstrumentMidi(next.id)
              : t.midi;
          const merged: Track = { ...t, source: next, midi };
          if (next.kind === 'instrument') firedTracks.push(merged);
          return merged;
        }),
      };
    });
    const { midiOutDeviceId } = useSequencerStore.getState();
    for (const t of firedTracks) fireTrackProgramChange(t, midiOutDeviceId);
  },
  initProject: () => {
    set((state) => ({
      tracks: state.tracks.map(blankTrack),
      lfos: defaultLFOs(),
      density: 0.5,
      chaos: 0.5,
      motion: 0.5,
      drift: 1,
      tension: 0.5,
      banks: Array.from({ length: BANK_SLOT_COUNT }, () => null),
      activeBank: 0,
      pendingBank: null,
      sceneStartStep: 0,
      sceneGraph: { ...DEFAULT_SCENE_GRAPH },
      ghostBarsRemaining: 0,
      ghostTargetBars: 0,
      ghostCompositionStartStep: 0,
      ghostPickLog: [...STARTUP_LOG],
      toasts: [],
      composition: {
        scenes: Array.from({ length: COMPOSITION_SLOT_COUNT }, () => null),
        activeScene: null,
        pendingScene: null,
        endsAfterLast: true,
      },
      performance: {
        ...state.performance,
        songs: Array.from({ length: PERFORMANCE_SLOT_COUNT }, () => null),
        activeSong: null,
        pendingSong: null,
        tailOutBarsRemaining: 0,
      },
    }));
  },
  fireAllProgramChanges: () => {
    const { tracks, midiOutDeviceId } = useSequencerStore.getState();
    for (const t of tracks) fireTrackProgramChange(t, midiOutDeviceId);
  },
  setTrackMidi: (trackId, patch) => {
    let nextTrack: Track | null = null;
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        nextTrack = { ...t, midi: { ...t.midi, ...patch } };
        return nextTrack;
      }),
    }));
    if (nextTrack) {
      const { midiOutDeviceId } = useSequencerStore.getState();
      fireTrackProgramChange(nextTrack, midiOutDeviceId);
    }
  },
  fireTrackProgram: (trackId) => {
    const state = useSequencerStore.getState();
    const track = state.tracks.find((t) => t.id === trackId);
    if (track) fireTrackProgramChange(track, state.midiOutDeviceId);
  },
  setEditMode: (editMode) => set({ editMode }),
  selectedStep: null,
  setSelectedStep: (selectedStep) => set({ selectedStep }),
  tieAnchor: null,
  setTieAnchor: (tieAnchor) => set({ tieAnchor }),
  setLFODepth: (id, depth) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(depth) ? depth : 0));
    set((state) => ({
      lfos: state.lfos.map((l) => (l.id === id ? { ...l, depth: clamped } : l)),
    }));
  },
  toggleLFODestination: (id, destination) =>
    set((state) => ({
      lfos: state.lfos.map((l) => {
        if (l.id !== id) return l;
        const exists = l.destinations.some(
          (d) => d.trackId === destination.trackId && d.knob === destination.knob
        );
        return {
          ...l,
          destinations: exists
            ? l.destinations.filter(
                (d) => !(d.trackId === destination.trackId && d.knob === destination.knob)
              )
            : [...l.destinations, destination],
        };
      }),
    })),
  clearLFODestinations: (id) =>
    set((state) => ({
      lfos: state.lfos.map((l) => (l.id === id ? { ...l, destinations: [] } : l)),
    })),
  setSelectingLFO: (id) => set({ selectingLFO: id }),
  setBpm: (bpm) => {
    const clamped = Math.max(40, Math.min(240, Number.isFinite(bpm) ? bpm : 120));
    set({ bpm: clamped });
  },
  setRootNote: (rootNote) => set({ rootNote }),
  setScale: (scale) => set({ scale }),
  toggleStep: (trackId, index) =>
    set((state) => {
      let turningOn = false;
      let velocity = 1;
      let trackIdx = -1;
      const tracks = state.tracks.map((t, ti) => {
        if (t.id !== trackId) return t;
        trackIdx = ti;
        const steps = t.steps.slice();
        const wasOn = steps[index].on;
        turningOn = !wasOn;
        if (turningOn) {
          steps[index] = { ...steps[index], on: true, pitch: t.lastPitch };
          velocity = steps[index].velocity;
        } else {
          // walk forward from this step clearing tieToNext until the chain
          // breaks, so removing the step also tears down its outgoing tie chain
          let cur = index;
          while (cur < t.length && steps[cur].tieToNext) {
            steps[cur] = { ...steps[cur], tieToNext: false };
            cur++;
          }
          steps[index] = { ...steps[index], on: false };
        }
        return { ...t, steps };
      });
      // Push a step-placement entry to the event log when turning ON.
      // Off-toggles are removals, not placements — skip.
      let log = state.ghostPickLog;
      if (turningOn && trackIdx >= 0) {
        const entry: GhostPickLogEntry = {
          kind: 'step',
          globalStep: state.globalStep,
          track: trackIdx,
          step: index,
          value: velocity,
        };
        log = state.ghostPickLog.concat(entry);
        if (log.length > GHOST_PICK_LOG_LIMIT) {
          log = log.slice(log.length - GHOST_PICK_LOG_LIMIT);
        }
      }
      return { tracks, ghostPickLog: log };
    }),
  setStepPitch: (trackId, index, pitch) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const steps = t.steps.slice();
        steps[index] = { ...steps[index], pitch };
        return { ...t, steps, lastPitch: pitch };
      }),
    })),
  setStepVelocity: (trackId, index, velocity) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const steps = t.steps.slice();
        steps[index] = { ...steps[index], velocity };
        return { ...t, steps };
      }),
    })),
  setStepProbability: (trackId, index, probability) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const steps = t.steps.slice();
        steps[index] = { ...steps[index], probability };
        return { ...t, steps };
      }),
    })),
  setStepRatchet: (trackId, index, ratchet) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const steps = t.steps.slice();
        steps[index] = { ...steps[index], ratchet };
        return { ...t, steps };
      }),
    })),
  setStepMicroTiming: (trackId, index, microTiming) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const steps = t.steps.slice();
        steps[index] = { ...steps[index], microTiming };
        return { ...t, steps };
      }),
    })),
  setStepGate: (trackId, index, gate) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const steps = t.steps.slice();
        steps[index] = { ...steps[index], gate };
        return { ...t, steps };
      }),
    })),
  setStepTie: (trackId, index, tied) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const steps = t.steps.slice();
        steps[index] = { ...steps[index], tieToNext: tied };
        return { ...t, steps };
      }),
    })),
  setStepChordVoicing: (trackId, index, voicing) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const steps = t.steps.slice();
        const cur = steps[index];
        // undefined → strip the plock; otherwise overwrite the existing voicing.
        const { chordVoicing: _omit, ...rest } = cur;
        steps[index] = voicing === undefined ? rest : { ...rest, chordVoicing: voicing };
        return { ...t, steps };
      }),
    })),
  setTrackDefaultChordVoicing: (trackId, voicing) =>
    set((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === trackId ? { ...t, defaultChordVoicing: voicing } : t
      ),
    })),
  setTrackPitchInterp: (trackId, pitchInterp) =>
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, pitchInterp } : t)),
    })),
  setTrackOctave: (trackId, octave) => {
    const clamped = Math.max(-4, Math.min(4, Math.round(octave)));
    set((state) => propagateTrackUpdate(state, trackId, { octave: clamped }));
  },
  setTrackMutation: (trackId, mutation) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(mutation) ? mutation : 0));
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, mutation: clamped } : t)),
    }));
  },
  setTrackGain: (trackId, gain) => {
    const clamped = Math.max(0, Math.min(2, Number.isFinite(gain) ? gain : 1));
    set((state) => propagateTrackUpdate(state, trackId, { gain: clamped }));
  },
  setTrackFxSend: (trackId, fxSend) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(fxSend) ? fxSend : 0));
    set((state) => propagateTrackUpdate(state, trackId, { fxSend: clamped }));
  },
  setTrackPan: (trackId, pan) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(pan) ? pan : 0.5));
    set((state) => propagateTrackUpdate(state, trackId, { pan: clamped }));
  },
  setTrackFilterCutoff: (trackId, cutoff) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(cutoff) ? cutoff : 1));
    set((state) => propagateTrackUpdate(state, trackId, { filterCutoff: clamped }));
  },
  setTrackFilterResonance: (trackId, resonance) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(resonance) ? resonance : 0));
    set((state) => propagateTrackUpdate(state, trackId, { filterResonance: clamped }));
  },
  setTrackRate: (trackId, rate) =>
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, rate } : t)),
    })),
  setTrackLockTiming: (trackId, lockTiming) =>
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, lockTiming } : t)),
    })),
  setTrackRowRatchet: (trackId, rowRatchet) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(rowRatchet) ? rowRatchet : 0));
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, rowRatchet: clamped } : t)),
    }));
  },
  setTrackArpOn: (trackId, on) =>
    set((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === trackId ? { ...t, arpConfig: { on } } : t
      ),
    })),
  setTrackOutput: (trackId, output) =>
    set((state) => propagateTrackUpdate(state, trackId, { output })),
  clearTrack: (trackId) =>
    set((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === trackId
          ? { ...t, steps: emptySteps(), euclidean: { hits: 0, rotation: 0 }, lastPitch: 0 }
          : t
      ),
    })),
  commitMutationOverlay: () => {
    set((state) => ({
      tracks: state.tracks.map((track) => {
        if (track.mutation === 0) return track;
        const steps = track.steps.map((step, i) => {
          const ov = getOverlay(track.id, i);
          if (!ov) return step;
          return { ...step, on: ov.on, velocity: ov.velocity, pitch: ov.pitch, gate: ov.gate };
        });
        return { ...track, steps, mutation: 0 };
      }),
    }));
    clearOverlay();
  },
  setTrackMute: (trackId, mute) =>
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, mute } : t)),
    })),
  setTrackSolo: (trackId, solo) =>
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, solo } : t)),
    })),
  setTrackLength: (trackId, length) => {
    const safe = Number.isFinite(length) ? Math.floor(length) : DEFAULT_LENGTH;
    const clamped = Math.max(1, Math.min(MAX_STEPS, safe));
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const maxPage = Math.max(0, Math.ceil(clamped / PAGE_SIZE) - 1);
        const eHits = Math.min(t.euclidean.hits, clamped);
        const eRotation = clamped > 0 ? t.euclidean.rotation % clamped : 0;
        return {
          ...t,
          length: clamped,
          viewPage: Math.min(t.viewPage, maxPage),
          euclidean: { hits: eHits, rotation: eRotation },
        };
      }),
    }));
  },
  setTrackPage: (trackId, page) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const maxPage = Math.max(0, Math.ceil(t.length / PAGE_SIZE) - 1);
        const clamped = Math.max(0, Math.min(maxPage, Math.floor(page)));
        return { ...t, viewPage: clamped };
      }),
    })),
  setTrackEuclidean: (trackId, partial) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const merged = { ...t.euclidean, ...partial };
        const len = t.length;
        const eHits = Math.max(
          0,
          Math.min(len, Number.isFinite(merged.hits) ? Math.floor(merged.hits) : 0)
        );
        const eRotation =
          len > 0
            ? (((Number.isFinite(merged.rotation) ? Math.floor(merged.rotation) : 0) % len) +
                len) %
              len
            : 0;
        const pattern = euclidean(len, eHits, eRotation);
        const newSteps = t.steps.map((s, i) =>
          i < len ? { ...s, on: pattern[i] ?? false } : s
        );
        return {
          ...t,
          euclidean: { hits: eHits, rotation: eRotation },
          steps: newSteps,
        };
      }),
    })),
  setGlobalStep: (globalStep) => set({ globalStep }),
  setPlaying: (playing) =>
    set((state) => ({
      playing,
      // queued bank swaps only make sense while transport is running.
      // Dropping pending on stop avoids a stale queue firing on next play.
      pendingBank: playing ? state.pendingBank : null,
      // On stop, reset the phase counters. The scheduler resets its own
      // currentStep to 0 on both stop and start (see scheduler.ts), but the
      // store's globalStep stops updating after stop and holds whatever
      // value it had. Without this reset, a bank swap while stopped captures
      // a stale globalStep as sceneStartStep, and the next play (scheduler
      // at currentStep=0) computes a negative sceneStep → negative localStep
      // → dispatch silently skips every step. Visible symptom: pattern
      // doesn't play after stop+bank-swap.
      ...(playing ? {} : { globalStep: 0, sceneStartStep: 0, ghostCompositionStartStep: 0 }),
      // Drop any queued scene swap on stop, matching pendingBank semantics.
      composition: playing
        ? state.composition
        : { ...state.composition, pendingScene: null },
    })),
  snapBank: (i) => {
    if (i < 0 || i >= BANK_SLOT_COUNT) return;
    set((state) => {
      const next = state.banks.slice();
      next[i] = snapshotBank(state, i);
      return { banks: next };
    });
  },
  queueBank: (i) => {
    if (i < 0 || i >= BANK_SLOT_COUNT) return;
    const state = useSequencerStore.getState();
    const slot = state.banks[i];
    if (!slot) return;
    if (i === state.activeBank) return;
    if (!state.playing) {
      // Stopped path: globalStep is 0 after setPlaying(false) reset, so
      // sceneStartStep also lands at 0. Next play tick: sceneStep = 0.
      applyBankSlot(set, i, slot, state.globalStep);
      return;
    }
    set({ pendingBank: i });
  },
  // Plain-click on an empty slot — materialize a blank pattern that
  // inherits band identity (track sources, mix knobs) from the currently
  // active state but clears all step authoring and resets pattern-shape
  // params. Unblocks "click into an empty pattern and start from there"
  // without forcing the user to author the whole bank first then shift-snap.
  startBlankBank: (i) => {
    if (i < 0 || i >= BANK_SLOT_COUNT) return;
    const state = useSequencerStore.getState();
    if (state.banks[i]) return;
    const blankTracks: Track[] = state.tracks.map((t) => ({
      ...t,
      steps: emptySteps(),
      length: DEFAULT_LENGTH,
      rate: '1/16',
      lockTiming: false,
      mutation: 0,
      rowRatchet: 0,
      viewPage: 0,
      euclidean: { hits: 0, rotation: 0 },
      lastPitch: 0,
    }));
    const blankMacros: BankMacros = {
      density: 0.5,
      chaos: 0.5,
      motion: 0.5,
      drift: 1,
      tension: 0.5,
    };
    const newSlot: BankSlot = {
      tracks: blankTracks,
      macros: blankMacros,
      kind: i >= TRANSITION_SLOT_START ? 'transition' : 'scene',
    };
    newSlot.entropy = bankEntropyTotal(newSlot);
    const banks = state.banks.slice();
    banks[i] = newSlot;
    if (!state.playing) {
      set({ banks });
      applyBankSlot(set, i, newSlot, state.globalStep);
    } else {
      set({ banks, pendingBank: i });
    }
  },
  clearBank: (i) => {
    if (i < 0 || i >= BANK_SLOT_COUNT) return;
    set((state) => {
      const next = state.banks.slice();
      next[i] = null;
      return {
        banks: next,
        pendingBank: state.pendingBank === i ? null : state.pendingBank,
      };
    });
  },
  setBankDwell: (i, bars) => {
    if (i < 0 || i >= BANK_SLOT_COUNT) return;
    set((state) => {
      const slot = state.banks[i];
      if (!slot) return {};
      const next = state.banks.slice();
      let updated: BankSlot;
      if (bars === null || !Number.isFinite(bars)) {
        const { dwellBars: _drop, ...rest } = slot;
        void _drop;
        updated = rest;
      } else {
        updated = { ...slot, dwellBars: Math.max(1, Math.min(1024, Math.floor(bars))) };
      }
      next[i] = updated;
      return { banks: next, ...mirrorBankSlotIntoActiveScene(state, i, updated) };
    });
  },
  // Insert-and-shift reorder within the scene-slot range (0..TRANSITION_SLOT_START).
  // Banks between `from` and `to` slide by one to fill the gap and create the
  // insertion point. activeBank and pendingBank follow the shift so the user's
  // queued / playing state stays consistent. Transition slots (14/15) are not
  // touched — they're a separate region for user-triggered breaks.
  moveBank: (from, to) => {
    set((state) => {
      if (from === to) return {};
      if (from < 0 || from >= TRANSITION_SLOT_START) return {};
      if (to < 0 || to >= TRANSITION_SLOT_START) return {};
      const moved = state.banks[from];
      if (!moved) return {};
      const banks = state.banks.slice();
      if (from < to) {
        // Moving right: pull items between left by one.
        for (let i = from; i < to; i++) banks[i] = banks[i + 1];
      } else {
        // Moving left: push items between right by one.
        for (let i = from; i > to; i--) banks[i] = banks[i - 1];
      }
      banks[to] = moved;

      const shiftIndex = (idx: number | null): number | null => {
        if (idx === null) return null;
        if (idx === from) return to;
        if (from < to && idx > from && idx <= to) return idx - 1;
        if (from > to && idx >= to && idx < from) return idx + 1;
        return idx;
      };

      return {
        banks,
        activeBank: shiftIndex(state.activeBank),
        pendingBank: shiftIndex(state.pendingBank),
      };
    });
  },
  commitPendingBank: (atGlobalStep) => {
    const state = useSequencerStore.getState();
    const i = state.pendingBank;
    if (i === null) return;
    const slot = state.banks[i];
    if (!slot) {
      set({ pendingBank: null });
      return;
    }
    applyBankSlot(set, i, slot, atGlobalStep);
  },
  snapScene: (i) => {
    if (i < 0 || i >= COMPOSITION_SLOT_COUNT) return;
    set((state) => {
      const scene: Scene = {
        tracks: state.tracks.map(cloneTrack),
        banks: state.banks.map((b) =>
          b
            ? { ...b, tracks: b.tracks.map(cloneTrack), macros: { ...b.macros } }
            : null,
        ),
        activeBank: state.activeBank,
        macros: {
          density: state.density,
          chaos: state.chaos,
          motion: state.motion,
          drift: state.drift,
          tension: state.tension,
        },
        sceneGraph: { ...state.sceneGraph },
      };
      const scenes = state.composition.scenes.slice();
      scenes[i] = scene;
      return { composition: { ...state.composition, scenes } };
    });
  },
  loadScene: (i) => {
    const state = useSequencerStore.getState();
    if (i < 0 || i >= COMPOSITION_SLOT_COUNT) return;
    const scene = state.composition.scenes[i];
    if (!scene) return;
    if (i === state.composition.activeScene) return;
    if (!state.playing) {
      // Stopped path: apply immediately, same convention as queueBank.
      applyScene(set, i, scene, state.globalStep);
      return;
    }
    // Playing: queue for next bar boundary so the swap lands atomically
    // alongside any bank commit at the same boundary.
    set((s) => ({
      composition: { ...s.composition, pendingScene: i },
    }));
  },
  commitPendingScene: (atGlobalStep) => {
    const state = useSequencerStore.getState();
    const i = state.composition.pendingScene;
    if (i === null) return;
    const scene = state.composition.scenes[i];
    if (!scene) {
      set((s) => ({ composition: { ...s.composition, pendingScene: null } }));
      return;
    }
    applyScene(set, i, scene, atGlobalStep);
  },
  clearScene: (i) =>
    set((state) => {
      if (i < 0 || i >= COMPOSITION_SLOT_COUNT) return {};
      const scenes = state.composition.scenes.slice();
      scenes[i] = null;
      return {
        composition: {
          ...state.composition,
          scenes,
          activeScene:
            state.composition.activeScene === i
              ? null
              : state.composition.activeScene,
        },
      };
    }),
  setCompositionEndsAfterLast: (v) =>
    set((state) => ({
      composition: { ...state.composition, endsAfterLast: v },
    })),
  importScene: (scene): number | null => {
    // Read + write in a single set() so the action doesn't reference
    // useSequencerStore.getState() inside the factory — that triggers a
    // circular type dependency through the SequencerState init.
    let idx: number | null = null;
    set((s) => {
      const found = s.composition.scenes.findIndex((sc) => sc === null);
      if (found === -1) return {};
      idx = found;
      const scenes = s.composition.scenes.slice();
      scenes[found] = scene;
      return { composition: { ...s.composition, scenes } };
    });
    return idx;
  },
  snapSong: (i) => {
    if (i < 0 || i >= PERFORMANCE_SLOT_COUNT) return;
    set((state) => {
      const song: Song = {
        tracks: state.tracks.map(cloneTrack),
        banks: state.banks.map((b) =>
          b
            ? { ...b, tracks: b.tracks.map(cloneTrack), macros: { ...b.macros } }
            : null,
        ),
        activeBank: state.activeBank,
        macros: {
          density: state.density,
          chaos: state.chaos,
          motion: state.motion,
          drift: state.drift,
          tension: state.tension,
        },
        sceneGraph: { ...state.sceneGraph },
        scenes: state.composition.scenes.map((sc) =>
          sc
            ? {
                ...sc,
                tracks: sc.tracks.map(cloneTrack),
                banks: sc.banks.map((b) =>
                  b
                    ? { ...b, tracks: b.tracks.map(cloneTrack), macros: { ...b.macros } }
                    : null,
                ),
                macros: { ...sc.macros },
                sceneGraph: { ...sc.sceneGraph },
              }
            : null,
        ),
        activeScene: state.composition.activeScene,
        endsAfterLast: state.composition.endsAfterLast,
        bpm: state.bpm,
        rootNote: state.rootNote,
        scale: state.scale,
        lfos: state.lfos.map((l) => ({ ...l, destinations: l.destinations.map((d) => ({ ...d })) })),
      };
      const songs = state.performance.songs.slice();
      songs[i] = song;
      return { performance: { ...state.performance, songs } };
    });
  },
  loadSong: (i) => {
    const state = useSequencerStore.getState();
    if (i < 0 || i >= PERFORMANCE_SLOT_COUNT) return;
    const song = state.performance.songs[i];
    if (!song) return;
    if (i === state.performance.activeSong && state.performance.pendingSong === null) return;
    if (!state.playing) {
      // Stopped: snap immediately. No tail-out needed since nothing's ringing.
      applySong(set, i, song, state.globalStep);
      return;
    }
    // Playing: queue the swap. tickPerformanceTailOut is driven from the
    // scheduler's bar-boundary callback and counts down before commit.
    set((s) => ({
      performance: {
        ...s.performance,
        pendingSong: i,
        tailOutBarsRemaining: Math.max(0, s.performance.tailOutBars),
      },
    }));
  },
  clearSong: (i) =>
    set((state) => {
      if (i < 0 || i >= PERFORMANCE_SLOT_COUNT) return {};
      const songs = state.performance.songs.slice();
      songs[i] = null;
      return {
        performance: {
          ...state.performance,
          songs,
          activeSong:
            state.performance.activeSong === i ? null : state.performance.activeSong,
          pendingSong:
            state.performance.pendingSong === i ? null : state.performance.pendingSong,
        },
      };
    }),
  moveSong: (from, to) => {
    set((state) => {
      if (from === to) return {};
      if (from < 0 || from >= PERFORMANCE_SLOT_COUNT) return {};
      if (to < 0 || to >= PERFORMANCE_SLOT_COUNT) return {};
      const moved = state.performance.songs[from];
      if (!moved) return {};
      const songs = state.performance.songs.slice();
      if (from < to) {
        for (let j = from; j < to; j++) songs[j] = songs[j + 1];
      } else {
        for (let j = from; j > to; j--) songs[j] = songs[j - 1];
      }
      songs[to] = moved;
      const shiftIndex = (idx: number | null): number | null => {
        if (idx === null) return null;
        if (idx === from) return to;
        if (from < to && idx > from && idx <= to) return idx - 1;
        if (from > to && idx >= to && idx < from) return idx + 1;
        return idx;
      };
      return {
        performance: {
          ...state.performance,
          songs,
          activeSong: shiftIndex(state.performance.activeSong),
          pendingSong: shiftIndex(state.performance.pendingSong),
        },
      };
    });
  },
  commitPendingSong: (atGlobalStep) => {
    const state = useSequencerStore.getState();
    const i = state.performance.pendingSong;
    if (i === null) return;
    const song = state.performance.songs[i];
    if (!song) {
      set((s) => ({
        performance: { ...s.performance, pendingSong: null, tailOutBarsRemaining: 0 },
      }));
      return;
    }
    applySong(set, i, song, atGlobalStep);
  },
  tickPerformanceTailOut: () => {
    set((s) => {
      if (s.performance.pendingSong === null) return {};
      if (s.performance.tailOutBarsRemaining <= 0) return {};
      return {
        performance: {
          ...s.performance,
          tailOutBarsRemaining: s.performance.tailOutBarsRemaining - 1,
        },
      };
    });
  },
  setPerformanceTailOutBars: (bars) =>
    set((state) => ({
      performance: {
        ...state.performance,
        tailOutBars: Math.max(0, Math.min(32, Math.floor(Number.isFinite(bars) ? bars : 0))),
      },
    })),
  importSong: (song): number | null => {
    let idx: number | null = null;
    set((s) => {
      const found = s.performance.songs.findIndex((x) => x === null);
      if (found === -1) return {};
      idx = found;
      const songs = s.performance.songs.slice();
      songs[found] = song;
      return { performance: { ...s.performance, songs } };
    });
    return idx;
  },
  replacePerformance: (next) =>
    set({
      performance: {
        ...next,
        pendingSong: null,
        tailOutBarsRemaining: 0,
      },
    }),
  // Insert-and-shift reorder for scenes — mirrors moveBank's semantics
  // exactly. Scenes between `from` and `to` slide one position to fill
  // the gap. activeScene + pendingScene follow the shift so the
  // playing / queued state stays consistent across the reorder.
  moveScene: (from, to) => {
    set((state) => {
      if (from === to) return {};
      if (from < 0 || from >= COMPOSITION_SLOT_COUNT) return {};
      if (to < 0 || to >= COMPOSITION_SLOT_COUNT) return {};
      const moved = state.composition.scenes[from];
      if (!moved) return {};
      const scenes = state.composition.scenes.slice();
      if (from < to) {
        for (let i = from; i < to; i++) scenes[i] = scenes[i + 1];
      } else {
        for (let i = from; i > to; i--) scenes[i] = scenes[i - 1];
      }
      scenes[to] = moved;
      const shiftIndex = (idx: number | null): number | null => {
        if (idx === null) return null;
        if (idx === from) return to;
        if (from < to && idx > from && idx <= to) return idx - 1;
        if (from > to && idx >= to && idx < from) return idx + 1;
        return idx;
      };
      return {
        composition: {
          ...state.composition,
          scenes,
          activeScene: shiftIndex(state.composition.activeScene),
          pendingScene: shiftIndex(state.composition.pendingScene),
        },
      };
    });
  },
  setSceneGraphEnabled: (enabled) =>
    set((state) => withSceneGraphPatch(state, { enabled })),
  setSceneGraphMinBars: (bars) =>
    set((state) => {
      const next = Math.max(1, Math.min(256, Math.floor(Number.isFinite(bars) ? bars : 1)));
      // Clamp max upward if user drags min past it — keeps the range valid
      // without forcing a separate "invalid" UI state.
      const max = Math.max(state.sceneGraph.maxBars, next);
      return withSceneGraphPatch(state, { minBars: next, maxBars: max });
    }),
  setSceneGraphMaxBars: (bars) =>
    set((state) => {
      const next = Math.max(1, Math.min(256, Math.floor(Number.isFinite(bars) ? bars : 1)));
      const min = Math.min(state.sceneGraph.minBars, next);
      return withSceneGraphPatch(state, { minBars: min, maxBars: next });
    }),
  setSceneGraphTransitionBars: (bars) =>
    set((state) => {
      const next = Math.max(0, Math.min(32, Math.floor(Number.isFinite(bars) ? bars : 0)));
      return withSceneGraphPatch(state, { transitionBars: next });
    }),
  setSceneGraphShape: (shape) =>
    set((state) => {
      if (!SCENE_SHAPES.includes(shape)) return {};
      return withSceneGraphPatch(state, { shape });
    }),
  setSceneGraphPhaseLength: (bars) =>
    set((state) => {
      const next = Math.max(1, Math.min(1024, Math.floor(Number.isFinite(bars) ? bars : 1)));
      return withSceneGraphPatch(state, { phaseLength: next });
    }),
  setSceneGraphBankOrderMode: (mode) =>
    set((state) => {
      if (mode !== 'entropy' && mode !== 'sequence') return {};
      return withSceneGraphPatch(state, { bankOrderMode: mode });
    }),
  setGhostDisplay: (remaining, target) =>
    set({ ghostBarsRemaining: remaining, ghostTargetBars: target }),
  setGhostCompositionStart: (step) =>
    set({ ghostCompositionStartStep: Math.max(0, Math.floor(step)) }),
  pushGhostPickEvent: (entry) =>
    set((s) => {
      const next = s.ghostPickLog.concat(entry);
      // Cap at GHOST_PICK_LOG_LIMIT — slice the head if we've crossed.
      if (next.length > GHOST_PICK_LOG_LIMIT) {
        next.splice(0, next.length - GHOST_PICK_LOG_LIMIT);
      }
      return { ghostPickLog: next };
    }),
  // Decorate the most-recent log entry with its dwell decision. tickBar
  // rolls the dwell AFTER applyBankSlot commits the swap, so the entry
  // for this slot was already pushed (by pickNextBank for auto, or by
  // applyBankSlot for manual). Slot match guards against a stray update
  // tagging an unrelated entry.
  setDwellOnLastBankChange: (slot, dwellBars) =>
    set((s) => {
      if (s.ghostPickLog.length === 0) return {};
      const last = s.ghostPickLog[s.ghostPickLog.length - 1];
      // Only bank-change entries carry a slot — skip meta entries (shape /
      // ghost / transport) that might be the most-recent push.
      if (last.kind !== 'auto' && last.kind !== 'manual') return {};
      if (last.slot !== slot) return {};
      const next = s.ghostPickLog.slice();
      next[next.length - 1] = { ...last, dwellBars };
      return { ghostPickLog: next };
    }),
  clearGhostPickLog: () => set({ ghostPickLog: [] }),
  pushToast: (t) =>
    set((s) => ({
      toasts: s.toasts.concat({
        ...t,
        id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        createdAt: Date.now(),
      }),
    })),
  dismissToast: (id) =>
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  // Batched partial macro write — single set() so subscribers fire once
  // regardless of how many fields the caller updates. Used by the ghost's
  // per-bar lerp (writes 4 — density excluded) and density drift (writes 1).
  // Manual UI knobs keep using the individual setDensity/setMotion/etc.
  // setters; this is ghost-side machinery.
  setMacros: (m) => {
    const next: Partial<Pick<SequencerState, 'density' | 'chaos' | 'motion' | 'drift' | 'tension'>> = {};
    if (m.density !== undefined) next.density = clamp01(m.density);
    if (m.chaos !== undefined) next.chaos = clamp01(m.chaos);
    if (m.motion !== undefined) next.motion = clamp01(m.motion, 0.5);
    if (m.drift !== undefined) next.drift = clamp01(m.drift, 1);
    if (m.tension !== undefined) next.tension = clamp01(m.tension);
    set(next);
  },
}));

function applyBankSlot(
  set: (
    partial:
      | Partial<SequencerState>
      | ((state: SequencerState) => Partial<SequencerState>)
  ) => void,
  i: number,
  slot: BankSlot,
  atGlobalStep: number
): void {
  // Atomic swap: tracks + macros + activeBank + pendingBank + freeze + the
  // scene phase reference all land in one set() so the scheduler's onStep
  // callback can never read mid-swap. sceneStartStep = scheduler's current
  // globalStep (passed in by caller, NOT read from store — the store's
  // globalStep is the AUDIBLE step which lags the scheduled step by the
  // lookahead). Each scene's tracks then start at their own step 0 from
  // this moment — necessary for polyrhythmic content (length 11/13/etc)
  // which otherwise picks up mid-cycle at swap moments.
  //
  // Global-knob preservation: per-track mix knobs (gain / fxSend / pan /
  // filterCutoff / filterResonance / octave) and hardware routing
  // (output) carry forward from the current active tracks onto the swap
  // target. The bank's stored values for those fields are ignored —
  // these are band-global identity, not per-pattern state. Pattern
  // fields (steps / length / mutation / rowRatchet / rate / lockTiming
  // / euclidean) come from the bank as before.
  const currentTracks = useSequencerStore.getState().tracks;
  const globalsById = new Map<string, Partial<Track>>();
  for (const t of currentTracks) {
    globalsById.set(t.id, {
      gain: t.gain,
      fxSend: t.fxSend,
      pan: t.pan,
      filterCutoff: t.filterCutoff,
      filterResonance: t.filterResonance,
      octave: t.octave,
      output: t.output,
    });
  }
  const mergedTracks = slot.tracks.map((bankTrack) => {
    const cloned = cloneTrack(bankTrack);
    const globals = globalsById.get(cloned.id);
    return globals ? { ...cloned, ...globals } : cloned;
  });
  set({
    tracks: mergedTracks,
    density: slot.macros.density,
    chaos: slot.macros.chaos,
    motion: slot.macros.motion,
    drift: slot.macros.drift,
    tension: slot.macros.tension,
    activeBank: i,
    pendingBank: null,
    freeze: false,
    sceneStartStep: atGlobalStep,
  });
  // Mutation overlay is keyed by trackId+index and would otherwise apply the
  // previous pattern's mutated outcomes to the new pattern's steps. Freeze
  // captures the same overlay — drop it for the same reason.
  clearOverlay();
  unfreezeLFOs();
  // Pad voicing-drift counters are keyed by trackId. Reset so a swapped-in
  // pattern's drift cadence starts fresh rather than mid-cycle from the
  // previous pattern's trigger count.
  resetPadDrift();
  // Per-track filter graphs intentionally KEEP across bank swaps. trackIds
  // are stable (compose / variant preserve t.id), and fxModulation's RAF
  // loop slews cutoff/resonance/fxSend to the new bank's per-track values
  // via setTargetAtTime — so a disconnect here would only buy us cutting
  // off in-flight sample tails for tracks that survive the swap. Project
  // import (persist.ts) DOES reset filters because trackIds change there.

  // Log this bank change for the GhostDebug datafeed. If the most recent
  // auto entry already points at this slot (ghost picker pushed it before
  // queueing), skip — that entry IS this commit. Otherwise log a manual
  // entry so user-driven swaps (clicks, blank-starts, etc.) appear in the
  // history. Dedupe window is 1 bar (32 globalSteps at 32nd resolution).
  const post = useSequencerStore.getState();
  const log = post.ghostPickLog;
  let alreadyLogged = false;
  for (let j = log.length - 1; j >= 0; j--) {
    const e = log[j];
    if (e.kind !== 'auto') continue;
    if (atGlobalStep - e.globalStep > 32) break;
    if (e.slot === i) {
      alreadyLogged = true;
      break;
    }
  }
  if (!alreadyLogged) {
    let nonce = '';
    while (nonce.length < 12) {
      nonce += Math.random().toString(16).slice(2);
    }
    nonce = nonce.slice(0, 12).toUpperCase();
    post.pushGhostPickEvent({
      kind: 'manual',
      globalStep: atGlobalStep,
      slot: i,
      nonce,
    });
  }
}

// Write-through helpers — scene-level edits (sceneGraph + per-bank dwell)
// live on both the working state and the active scene's snapshot, so
// switching scenes and returning preserves the user's authoring intent.
// No-op when no scene is active or the active slot is empty (edits still
// land in working state; user can shift-click to snap a new scene).
function withSceneGraphPatch(
  state: SequencerState,
  patch: Partial<SceneGraphConfig>
): Partial<SequencerState> {
  const sceneGraph = { ...state.sceneGraph, ...patch };
  const i = state.composition.activeScene;
  if (i === null) return { sceneGraph };
  const scene = state.composition.scenes[i];
  if (!scene) return { sceneGraph };
  const scenes = state.composition.scenes.slice();
  scenes[i] = { ...scene, sceneGraph: { ...sceneGraph } };
  return { sceneGraph, composition: { ...state.composition, scenes } };
}

function mirrorBankSlotIntoActiveScene(
  state: SequencerState,
  slotIdx: number,
  slot: BankSlot
): Partial<SequencerState> {
  const i = state.composition.activeScene;
  if (i === null) return {};
  const scene = state.composition.scenes[i];
  if (!scene) return {};
  const sceneSlot = scene.banks[slotIdx];
  if (!sceneSlot) return {};
  const sceneBanks = scene.banks.slice();
  // Only carry dwellBars across — the bank's tracks/macros/name belong to
  // the scene's own authoring history, not the live working banks.
  if (slot.dwellBars === undefined) {
    const { dwellBars: _drop, ...rest } = sceneSlot;
    void _drop;
    sceneBanks[slotIdx] = rest;
  } else {
    sceneBanks[slotIdx] = { ...sceneSlot, dwellBars: slot.dwellBars };
  }
  const scenes = state.composition.scenes.slice();
  scenes[i] = { ...scene, banks: sceneBanks };
  return { composition: { ...state.composition, scenes } };
}

// Atomic scene swap. Unlike bank swap (which preserves band identity for
// per-track mix knobs), scene swap loads EVERYTHING per-scene fresh:
// voice assignments, per-track mix, banks, macros, sceneGraph. Truly
// global state (bpm, scale, master FX, LFOs) is left untouched per the
// composition-layer design. Filter graphs stay connected — sample tails
// from the outgoing scene ring through naturally.
function applyScene(
  set: (
    partial:
      | Partial<SequencerState>
      | ((state: SequencerState) => Partial<SequencerState>)
  ) => void,
  i: number,
  scene: Scene,
  atGlobalStep: number
): void {
  set((state) => ({
    tracks: scene.tracks.map(cloneTrack),
    banks: scene.banks.map((b) =>
      b
        ? { ...b, tracks: b.tracks.map(cloneTrack), macros: { ...b.macros } }
        : null,
    ),
    activeBank: scene.activeBank,
    pendingBank: null,
    density: scene.macros.density,
    chaos: scene.macros.chaos,
    motion: scene.macros.motion,
    drift: scene.macros.drift,
    tension: scene.macros.tension,
    // Ghost enabled is a session-level toggle, not per-scene state — preserve
    // the user's current on/off choice across scene loads regardless of what
    // was captured in the scene's snapshot.
    sceneGraph: { ...scene.sceneGraph, enabled: state.sceneGraph.enabled },
    sceneStartStep: atGlobalStep,
    // Reset ghost arc clock — new scene starts a fresh shape phase
    ghostCompositionStartStep: atGlobalStep,
    freeze: false,
    composition: { ...state.composition, activeScene: i, pendingScene: null },
  }));
  // Mutation overlay keyed by trackId+index → outgoing scene's mutated
  // outcomes mustn't apply to the new scene's steps. Same rationale as
  // applyBankSlot's clearOverlay call.
  clearOverlay();
  unfreezeLFOs();
  resetPadDrift();
  useSequencerStore.getState().pushGhostPickEvent({
    kind: 'scene',
    globalStep: atGlobalStep,
    slot: i,
  });
}

// Atomic song swap. Replaces the entire piece: tracks, banks, scenes,
// macros, sceneGraph, bpm, root, scale, LFOs. Master FX + nativeMix +
// midiOutDeviceId stay global (rig-level identity). Used by the
// performance layer's loadSong + commitPendingSong.
function applySong(
  set: (
    partial:
      | Partial<SequencerState>
      | ((state: SequencerState) => Partial<SequencerState>)
  ) => void,
  i: number,
  song: Song,
  atGlobalStep: number,
): void {
  set((state) => ({
    tracks: song.tracks.map(cloneTrack),
    banks: song.banks.map((b) =>
      b
        ? { ...b, tracks: b.tracks.map(cloneTrack), macros: { ...b.macros } }
        : null,
    ),
    activeBank: song.activeBank,
    pendingBank: null,
    density: song.macros.density,
    chaos: song.macros.chaos,
    motion: song.macros.motion,
    drift: song.macros.drift,
    tension: song.macros.tension,
    // Ghost enabled is session-level, not per-song — preserve the user's
    // current on/off choice across song loads.
    sceneGraph: { ...song.sceneGraph, enabled: state.sceneGraph.enabled },
    sceneStartStep: atGlobalStep,
    ghostCompositionStartStep: atGlobalStep,
    freeze: false,
    bpm: song.bpm,
    rootNote: song.rootNote,
    scale: song.scale,
    lfos: song.lfos.map((l) => ({ ...l, destinations: l.destinations.map((d) => ({ ...d })) })),
    composition: {
      scenes: song.scenes.map((sc) =>
        sc
          ? {
              ...sc,
              tracks: sc.tracks.map(cloneTrack),
              banks: sc.banks.map((b) =>
                b
                  ? { ...b, tracks: b.tracks.map(cloneTrack), macros: { ...b.macros } }
                  : null,
              ),
              macros: { ...sc.macros },
              sceneGraph: { ...sc.sceneGraph },
            }
          : null,
      ),
      activeScene: song.activeScene,
      pendingScene: null,
      endsAfterLast: song.endsAfterLast,
    },
    performance: {
      ...state.performance,
      activeSong: i,
      pendingSong: null,
      tailOutBarsRemaining: 0,
    },
  }));
  clearOverlay();
  unfreezeLFOs();
  resetPadDrift();
  // Re-seed chord context against the new song's root + scale so root/
  // chord-tone followers latch onto the new key immediately rather than
  // carrying the prior song's harmony until the chord master plays its
  // next step.
  resetChordContext(song.rootNote, song.scale);
}
