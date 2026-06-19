import { create } from 'zustand';
import type { Scale } from '../audio/scale';
import { emitStreamEvent } from '../stream/streamEvents';
import { euclidean } from '../audio/euclidean';
import { getOverlay, clearOverlay } from '../audio/mutationOverlay';
import { resetPadDrift } from '../audio/padState';
import { resetBranchWalk } from '../audio/treeState';
import { resetStepAccumulators, type AccumulatorCfg } from '../audio/accumulator';
import {
  defaultLFOs,
  freezeLFOs,
  unfreezeLFOs,
  markManualOverride,
  GLOBAL_TRACK_ID,
  type LFO,
  type LFOShape,
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

// Which view the top multi-mode screen is showing. Ephemeral UI state (not
// persisted) — mirrors editMode. ROLL = focused-channel piano roll (default),
// LFO/FX/MASTER = the relocated control panels, PARAMS/AUTOMATION = the
// focused voice's instrument editor (the two halves of the old modal editor).
export type ScreenMode = 'roll' | 'lfo' | 'fx' | 'master' | 'params' | 'automation';

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
  // Optional per-step accumulator: a deterministic pitch ladder that climbs by
  // `step` scale-degrees each time this step fires (see audio/accumulator.ts).
  // Undefined → no climb. Sparse plock, same shape as chordVoicing.
  accumulator?: AccumulatorCfg;
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
  // Runtime-only: true when this track is armed for MIDI input recording.
  // Only one track is armed at a time (setTrackInputArmed auto-disarms
  // others). Stripped on bank snapshot (cloneTrack zeroes it) so banks
  // never carry arm state — arming is purely a transient UI gesture.
  inputArmed?: boolean;
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
  // Where the metronome click lands when multiOut is ON (folds to 1-2 when
  // OFF, like every other voice). Defaults to mono — a click cue is typically
  // a single dedicated channel (e.g. a performer's monitor send), not a pair.
  metronomeOutput: TrackOutput;
}

export const DEFAULT_NATIVE_MIX: NativeMix = {
  multiOut: false,
  fxOutput: { firstChannel: 0, stereo: true },
  fxBypass: false,
  metronomeOutput: { firstChannel: 0, stereo: false },
};

const LS_NATIVE_MIX = 'newspeech.sequencer.nativeMix';

function readPersistedNativeMix(): NativeMix {
  if (typeof localStorage === 'undefined') return { ...DEFAULT_NATIVE_MIX };
  try {
    const raw = localStorage.getItem(LS_NATIVE_MIX);
    if (!raw) return { ...DEFAULT_NATIVE_MIX };
    const v = JSON.parse(raw) as Partial<NativeMix>;
    const sanitizeOut = (
      o: Partial<TrackOutput> | undefined,
      fallback: TrackOutput,
    ): TrackOutput => {
      const src = o && typeof o === 'object' ? o : fallback;
      return {
        firstChannel:
          typeof src.firstChannel === 'number' && src.firstChannel >= 0
            ? Math.floor(src.firstChannel)
            : fallback.firstChannel,
        stereo: typeof src.stereo === 'boolean' ? src.stereo : fallback.stereo,
      };
    };
    return {
      multiOut: typeof v.multiOut === 'boolean' ? v.multiOut : DEFAULT_NATIVE_MIX.multiOut,
      fxOutput: sanitizeOut(v.fxOutput, DEFAULT_NATIVE_MIX.fxOutput),
      fxBypass: typeof v.fxBypass === 'boolean' ? v.fxBypass : DEFAULT_NATIVE_MIX.fxBypass,
      metronomeOutput: sanitizeOut(v.metronomeOutput, DEFAULT_NATIVE_MIX.metronomeOutput),
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

// Clock-out port is rig routing (which interface receives the master clock),
// so it persists across launches independently of any project — same
// reasoning as the native-mix config above.
const LS_MIDI_CLOCK_OUT = 'newspeech.sequencer.midiClockOutPort';

// Stored as a JSON array of destination port names/ids: Sequence broadcasts the
// master clock to EVERY listed port (e.g. Mutant Brain for the rack + Bluebox
// for record-sync). Reads migrate the pre-multi single-string value forward to
// a one-element list so existing installs keep their clock route.
function readPersistedClockOut(): string[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(LS_MIDI_CLOCK_OUT);
    if (!raw) return [];
    if (raw.startsWith('[')) {
      const arr: unknown = JSON.parse(raw);
      return Array.isArray(arr) ? arr.filter((v): v is string => typeof v === 'string') : [];
    }
    return [raw]; // legacy single-port value
  } catch {
    return [];
  }
}

function writePersistedClockOut(v: string[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (v.length) localStorage.setItem(LS_MIDI_CLOCK_OUT, JSON.stringify(v));
    else localStorage.removeItem(LS_MIDI_CLOCK_OUT);
  } catch {
    /* quota / private mode — silent */
  }
}

// The MIDI output the XL3 mixer page emits Bluebox CC to (one device, one port).
// Rig routing like the clock-out port: persisted across launches, not in .seq.
const LS_BLUEBOX_PORT = 'newspeech.sequencer.blueboxPort';

function readPersistedBlueboxPort(): string | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return localStorage.getItem(LS_BLUEBOX_PORT) || null;
  } catch {
    return null;
  }
}

function writePersistedBlueboxPort(v: string | null): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (v) localStorage.setItem(LS_BLUEBOX_PORT, v);
    else localStorage.removeItem(LS_BLUEBOX_PORT);
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
  // Global chord-voicing openness (0..1). 0 = authored voicing untouched;
  // higher opens/inverts the chord then stacks diatonic color tones. See
  // applyVoicingMacro in audio/chords.ts.
  voicing: number;
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
  name?: string;
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
  // Bank-change logging is two-stage. `auto` / `manual` are QUEUE-stage
  // entries pushed when pendingBank is set; `commit` is the COMMIT-stage
  // entry pushed by applyBankSlot when the bank actually swaps audibly.
  // For an auto pick: auto → commit (rich rationale at queue, "active"
  // at commit). For a manual click while playing: manual → commit. For a
  // manual click while stopped: just commit (queueBank → applyBankSlot
  // fires inline, no queue stage to log).
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
    }
  | {
      kind: 'manual';
      globalStep: number;
      slot: number;
      // 12-char hex nonce, generated at push time. Split into three 4-char
      // chunks at render time so manual rows fill the same visual column
      // width as auto rows. Purely cosmetic — datafeed framing.
      nonce: string;
    }
  | {
      kind: 'commit';
      globalStep: number;
      slot: number;
      // 'auto' if a recent auto entry queued this swap, else 'manual'.
      trigger: 'auto' | 'manual';
      // Filled by tickBar AFTER the dwell roll lands. Indicates how many
      // bars ghost will hold this bank before considering the next pick.
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

// Each bank swap now produces TWO log entries (queue stage + commit
// stage), so the limit was raised from 16 → 24 to keep the GhostDebug
// overlay showing the same effective number of swaps.
export const GHOST_PICK_LOG_LIMIT = 24;

function ghostPickLabel(entry: GhostPickLogEntry): string {
  switch (entry.kind) {
    case 'auto':
      return `ghost · pattern ${entry.slot} · ent ${entry.pickedEntropy.toFixed(2)}`;
    case 'manual':
      return `pattern ${entry.slot} · queued`;
    case 'commit':
      return `pattern ${entry.slot} · active`;
    case 'shape':
      return `shape ${entry.from} → ${entry.to}`;
    case 'ghost':
      return `ghost ${entry.enabled ? 'on' : 'off'}`;
    case 'transport':
      return `transport ${entry.playing ? 'play' : 'stop'}`;
    case 'system':
      return entry.label;
    case 'step':
      return `place t${entry.track} s${entry.step} v${entry.value.toFixed(2)}`;
    case 'scene':
      return `scene ${entry.slot}`;
  }
}

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

export interface SequencerState {
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
  screenMode: ScreenMode;
  midiOutDeviceId: string | null;
  // MIDI clock-out destinations (Sequence is the rig clock master). The app
  // emits 24-PPQN clock + Start/Stop to EVERY listed output port; empty =
  // clock off. Multiple destinations let one Start downbeat drive the rack
  // (Mutant Brain) and arm the Bluebox record-sync at once. Persisted to
  // localStorage as rig routing that survives launches — deliberately NOT
  // baked into .seq files, which carry musical content, not interface config.
  midiClockOutPorts: string[];
  setMidiClockOutPorts: (ports: string[]) => void;
  // MIDI output the XL3 mixer page sends Bluebox mixer CC to; null = unset.
  blueboxPort: string | null;
  setBlueboxPort: (port: string | null) => void;
  viewSection: TrackSection;
  density: number;
  chaos: number;
  motion: number;
  drift: number;
  tension: number;
  voicing: number;
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
  // Universal metronome toggle. When true, the scheduler plays the same click
  // voice as the count-in on every beat (accented on the bar downbeat) for as
  // long as transport runs. Native path uses SECTION_NONE so it stays OUT of
  // recordings (unlike the count-in). Session-only; not persisted to .seq.
  metronome: boolean;
  setMetronome: (v: boolean) => void;
  toggleMetronome: () => void;
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
  setVoicing: (v: number) => void;
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
  setScreenMode: (mode: ScreenMode) => void;
  selectedStep: StepSelection | null;
  setSelectedStep: (sel: StepSelection | null) => void;
  tieAnchor: StepSelection | null;
  setTieAnchor: (sel: StepSelection | null) => void;
  // The step the mouse is currently over (hover-capable devices only). Drives
  // the MIDI-keyboard WRITE target while stopped: a played note lands on the
  // hovered step. Cursor off the grid → null → monitor-only (no write). Kept
  // separate from selectedStep/tieAnchor on purpose — hover must NOT move the
  // inspector/roll focus or change the monitored channel.
  hoveredStep: StepSelection | null;
  setHoveredStep: (sel: StepSelection | null) => void;
  // Sticky channel focus for the ROLL screen — the track the piano roll
  // follows. Set when a step is selected/pinned (below); held when nothing is
  // hovered so the roll doesn't snap away. null → fall back to first melodic.
  focusedTrackId: string | null;
  setFocusedTrackId: (id: string | null) => void;
  setLFODepth: (id: number, depth: number) => void;
  setLFOShape: (id: number, shape: LFOShape) => void;
  toggleLFODestination: (id: number, destination: LFODestination) => void;
  clearLFODestinations: (id: number) => void;
  setSelectingLFO: (id: number | null) => void;
  setBpm: (bpm: number) => void;
  setRootNote: (midi: number) => void;
  setScale: (scale: Scale) => void;
  toggleStep: (trackId: string, index: number) => void;
  setStepPitch: (trackId: string, index: number, pitch: number) => void;
  setStepVelocity: (trackId: string, index: number, velocity: number) => void;
  setStepOn: (trackId: string, index: number, on: boolean) => void;
  setStepProbability: (trackId: string, index: number, probability: number) => void;
  setStepRatchet: (trackId: string, index: number, ratchet: number) => void;
  setStepMicroTiming: (trackId: string, index: number, microTiming: number) => void;
  setStepGate: (trackId: string, index: number, gate: number) => void;
  setStepTie: (trackId: string, index: number, tied: boolean) => void;
  setStepChordVoicing: (trackId: string, index: number, voicing: ChordVoicing | undefined) => void;
  setStepAccumulator: (trackId: string, index: number, cfg: AccumulatorCfg | undefined) => void;
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
  // MIDI recording — `inputArmed` is per-track. Melodic arm is single-target
  // (the MIDI keyboard records one melodic track); drum arm is multi (the
  // Launchpad drum page records many channels at once). Armed + playing
  // records-while-monitoring; armed + stopped monitors only (so play-along
  // without recording = arm + don't run transport). Monitoring also comes from
  // the Launchpad keyboard page, which tracks the selected step's voice —
  // that's why the old monitor-only `inputLive` toggle was dropped. The drum
  // page's top-row arms drive this same flag, so the per-track record dot in the
  // app UI lights up. midiRecInputPort gates which device's note-on messages
  // reach the recorder; null = recording off entirely.
  setTrackInputArmed: (trackId: string, armed: boolean) => void;
  midiRecInputPort: string | null;
  setMidiRecInputPort: (port: string | null) => void;
  setTrackLength: (trackId: string, length: number) => void;
  setTrackPage: (trackId: string, page: number) => void;
  setTrackEuclidean: (trackId: string, partial: Partial<EuclideanParams>) => void;
  setGlobalStep: (step: number) => void;
  setPlaying: (playing: boolean) => void;
  banks: (BankSlot | null)[];
  activeBank: number | null;
  pendingBank: number | null;
  snapBank: (i: number) => void;
  // source='auto' when called by the ghost picker — suppresses the
  // manual queue-stage log entry (ghost has already pushed its own
  // richer 'auto' entry with rationale).
  queueBank: (i: number, source?: 'auto' | 'manual') => void;
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
  // source='ghost' skips the auto-save snap-back of the outgoing scene
  // (used by the autonomous advance so a performance doesn't bake runtime
  // mutations into the saved composition). Defaults to 'manual'.
  loadScene: (i: number, source?: 'manual' | 'ghost') => void;
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
  // Immediate atomic song swap while playing — no tail-out gap. Used by
  // the ghost's autonomous set advance so song N hands directly to N+1
  // on the bar boundary (the outgoing song's texture voices fade over
  // the new song via a separate fadeTextures call). atGlobalStep is the
  // scheduler's scheduled step (not the lagging store globalStep).
  swapSongImmediate: (i: number, atGlobalStep: number) => void;
  clearSong: (i: number) => void;
  moveSong: (from: number, to: number) => void;
  commitPendingSong: (atGlobalStep: number) => void;
  tickPerformanceTailOut: () => void;
  setPerformanceTailOutBars: (bars: number) => void;
  setPerformanceName: (name: string) => void;
  setSongName: (i: number, name: string) => void;
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
    // Runtime UI state — never round-tripped through bank snapshots.
    inputArmed: false,
  };
}

// The MIDI record arm (`inputArmed`) is GLOBAL rig state, not per-pattern: a
// performer arms a track once and expects it to stay armed across bank/scene/
// song swaps. But every swap rebuilds `tracks` via cloneTrack (which clears the
// flag so it never bakes into snapshots/saves), so the arm would be lost on each
// pattern change. This carries the arm forward onto the swap target, matched by
// stable trackId. No-op when nothing is armed, or when the armed track has no
// counterpart in the incoming set.
function withInputArm(prevTracks: Track[], newTracks: Track[]): Track[] {
  const armedIds = new Set(prevTracks.filter((t) => t.inputArmed).map((t) => t.id));
  if (armedIds.size === 0) return newTracks;
  return newTracks.map((t) => (armedIds.has(t.id) ? { ...t, inputArmed: true } : t));
}

// On a fresh load (.seq / .seqcomp / .seqset) we reset every scene to its
// first bank (bank 1) and the live state lands on scene 1 / bank 1 — a loaded
// piece always starts from the top, not wherever it happened to be saved. This
// resets a single scene's snapshot: active bank → 0 and its live tracks →
// bank 0's content (so navigating to it later lands on bank 1, coherently).
export function resetSceneToFirstBank(scene: Scene | null): Scene | null {
  if (!scene) return scene;
  const bank0 = scene.banks[0];
  if (!bank0) return scene; // empty first slot — leave the scene untouched
  return { ...scene, activeBank: 0, tracks: bank0.tracks.map(cloneTrack) };
}

// Reset a whole song to its top: every scene → bank 1, and the song's own live
// state (the scene it loads with) → scene 1 / bank 1. Used on .seqset load so
// EVERY song in the set starts from the top, not just the active one — when
// you later switch to song N it lands on its scene 1 / bank 1.
export function resetSongToFirstSceneBank(song: Song | null): Song | null {
  if (!song) return song;
  const scenes = song.scenes.map(resetSceneToFirstBank);
  const scene0 = scenes[0];
  if (scene0) {
    return {
      ...song,
      scenes,
      activeScene: 0,
      activeBank: 0,
      tracks: scene0.tracks.map(cloneTrack), // scene 1 / bank 1 content
      banks: scene0.banks,
    };
  }
  // No scenes — at least reset the song's own active bank to bank 1.
  const bank0 = song.banks[0];
  if (bank0) return { ...song, scenes, activeBank: 0, tracks: bank0.tracks.map(cloneTrack) };
  return { ...song, scenes };
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
    voicing: number;
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
      voicing: state.voicing,
    },
    kind: slotIndex >= TRANSITION_SLOT_START ? 'transition' : 'scene',
  };
  slot.entropy = bankEntropyTotal(slot);
  return slot;
}

// Returns the banks array with the ACTIVE bank slot folded from the live
// working pattern (s.tracks + macros). The active bank is edited via the
// live state; its stored slot goes stale the moment a step changes. Used
// by capture/serialize paths so the active bank reflects current edits
// (auto-save). Per-bank metadata (dwellBars / recipe) is carried over —
// it isn't part of the live pattern. No-op when no active bank.
export function banksWithLiveActiveBank(
  state: SequencerState
): (BankSlot | null)[] {
  const { activeBank } = state;
  if (activeBank === null) return state.banks;
  const prev = state.banks[activeBank];
  if (!prev) return state.banks;
  const fresh = snapshotBank(state, activeBank);
  if (prev.dwellBars !== undefined) fresh.dwellBars = prev.dwellBars;
  if (prev.recipe !== undefined) fresh.recipe = prev.recipe;
  const banks = state.banks.slice();
  banks[activeBank] = fresh;
  return banks;
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
  voicing: clamp01((defaultPreset as { voicing?: unknown }).voicing),
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
  lfos: hydrateLFOs((defaultPreset as unknown as { lfos?: LFO[] }).lfos),
  selectingLFO: null,
  globalStep: 0,
  sceneStartStep: 0,
  playing: false,
  editMode: 'live',
  screenMode: 'roll',
  focusedTrackId: null,
  midiOutDeviceId: null,
  midiClockOutPorts: readPersistedClockOut(),
  blueboxPort: readPersistedBlueboxPort(),
  midiRecInputPort: null,
  viewSection: 'drum',
  density: initialMacros.density,
  chaos: initialMacros.chaos,
  motion: initialMacros.motion,
  drift: initialMacros.drift,
  tension: initialMacros.tension,
  voicing: initialMacros.voicing,
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
  metronome: false,
  setMetronome: (v) => set({ metronome: v }),
  toggleMetronome: () => set((s) => ({ metronome: !s.metronome })),
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
      // Merge nested outputs deeply since partial patches may carry just one
      // of their fields. The bool/scalar fields are flat-merged above.
      if (patch.fxOutput) {
        merged.fxOutput = { ...state.nativeMix.fxOutput, ...patch.fxOutput };
      }
      if (patch.metronomeOutput) {
        merged.metronomeOutput = { ...state.nativeMix.metronomeOutput, ...patch.metronomeOutput };
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
    // ghost immediately yanking it back). markManualOverride does the same for
    // any LFO routed to density — the hand wins.
    noteDensityUserInput();
    markManualOverride(GLOBAL_TRACK_ID, 'density');
    set({ density: clamp01(v) });
  },
  setChaos: (v) => {
    markManualOverride(GLOBAL_TRACK_ID, 'chaos');
    set({ chaos: clamp01(v) });
  },
  setMotion: (v) => {
    markManualOverride(GLOBAL_TRACK_ID, 'motion');
    set({ motion: clamp01(v) });
  },
  setDrift: (v) => {
    markManualOverride(GLOBAL_TRACK_ID, 'drift');
    set({ drift: clamp01(v) });
  },
  setTension: (v) => {
    markManualOverride(GLOBAL_TRACK_ID, 'tension');
    set({ tension: clamp01(v) });
  },
  setVoicing: (v) => {
    markManualOverride(GLOBAL_TRACK_ID, 'voicing');
    set({ voicing: clamp01(v) });
  },
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
  setMidiClockOutPorts: (midiClockOutPorts) => {
    writePersistedClockOut(midiClockOutPorts);
    set({ midiClockOutPorts });
  },
  setBlueboxPort: (blueboxPort) => {
    writePersistedBlueboxPort(blueboxPort);
    set({ blueboxPort });
  },
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
      voicing: 0,
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
  setScreenMode: (screenMode) => set({ screenMode }),
  selectedStep: null,
  // Selecting a step (click-driven now, not hover) focuses its channel, so the
  // ROLL screen + StepInspector stay locked to the same channel.
  setSelectedStep: (selectedStep) =>
    set(
      selectedStep
        ? { selectedStep, focusedTrackId: selectedStep.trackId }
        : { selectedStep },
    ),
  tieAnchor: null,
  setTieAnchor: (tieAnchor) =>
    set(tieAnchor ? { tieAnchor, focusedTrackId: tieAnchor.trackId } : { tieAnchor }),
  // Hover does NOT touch focusedTrackId — purely the write target.
  hoveredStep: null,
  setHoveredStep: (hoveredStep) => set({ hoveredStep }),
  setFocusedTrackId: (focusedTrackId) => set({ focusedTrackId }),
  setLFODepth: (id, depth) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(depth) ? depth : 0));
    set((state) => ({
      lfos: state.lfos.map((l) => (l.id === id ? { ...l, depth: clamped } : l)),
    }));
  },
  setLFOShape: (id, shape) =>
    set((state) => ({
      lfos: state.lfos.map((l) => (l.id === id ? { ...l, shape } : l)),
    })),
  toggleLFODestination: (id, destination) => {
    // Capture add-vs-remove before the set so the stream label can show
    // which way the toggle went without diffing destinations arrays.
    const lfoBefore = useSequencerStore.getState().lfos.find((l) => l.id === id);
    const existed =
      lfoBefore?.destinations.some(
        (d) => d.trackId === destination.trackId && d.knob === destination.knob
      ) ?? false;
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
    }));
    const trackLabel = destination.trackId ? ` ${destination.trackId}` : '';
    emitStreamEvent({
      kind: 'param',
      label: `LFO${id} ${existed ? '✕' : '→'} ${destination.knob}${trackLabel}`,
    });
  },
  clearLFODestinations: (id) => {
    set((state) => ({
      lfos: state.lfos.map((l) => (l.id === id ? { ...l, destinations: [] } : l)),
    }));
    emitStreamEvent({ kind: 'param', label: `LFO${id} · clear` });
  },
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
  setStepOn: (trackId, index, on) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const steps = t.steps.slice();
        steps[index] = { ...steps[index], on };
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
  setStepAccumulator: (trackId, index, cfg) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const steps = t.steps.slice();
        const cur = steps[index];
        // undefined → strip the plock; otherwise overwrite.
        const { accumulator: _omit, ...rest } = cur;
        steps[index] = cfg === undefined ? rest : { ...rest, accumulator: cfg };
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
    markManualOverride(trackId, 'mutation');
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, mutation: clamped } : t)),
    }));
  },
  setTrackGain: (trackId, gain) => {
    const clamped = Math.max(0, Math.min(2, Number.isFinite(gain) ? gain : 1));
    markManualOverride(trackId, 'gain');
    set((state) => propagateTrackUpdate(state, trackId, { gain: clamped }));
  },
  setTrackFxSend: (trackId, fxSend) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(fxSend) ? fxSend : 0));
    markManualOverride(trackId, 'fxSend');
    set((state) => propagateTrackUpdate(state, trackId, { fxSend: clamped }));
  },
  setTrackPan: (trackId, pan) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(pan) ? pan : 0.5));
    markManualOverride(trackId, 'pan');
    set((state) => propagateTrackUpdate(state, trackId, { pan: clamped }));
  },
  setTrackFilterCutoff: (trackId, cutoff) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(cutoff) ? cutoff : 1));
    markManualOverride(trackId, 'filterCutoff');
    set((state) => propagateTrackUpdate(state, trackId, { filterCutoff: clamped }));
  },
  setTrackFilterResonance: (trackId, resonance) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(resonance) ? resonance : 0));
    markManualOverride(trackId, 'filterResonance');
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
    markManualOverride(trackId, 'rowRatchet');
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
  setTrackInputArmed: (trackId, armed) =>
    set((state) => {
      const section = state.tracks.find((t) => t.id === trackId)?.section;
      return {
        tracks: state.tracks.map((t) => {
          if (t.id === trackId) return { ...t, inputArmed: armed };
          // Melodic arm is SINGLE-target — the MIDI keyboard records one melodic
          // track, so arming one disarms the other melodic tracks. Drum arm is
          // MULTI — the Launchpad drum page finger-drums many channels at once,
          // so arming a drum leaves other drums alone. The two sections never
          // interfere with each other's arm state.
          if (armed && section === 'melodic' && t.section === 'melodic') {
            return t.inputArmed ? { ...t, inputArmed: false } : t;
          }
          return t;
        }),
      };
    }),
  setMidiRecInputPort: (port) => set({ midiRecInputPort: port }),
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
      const prev = state.banks[i];
      const next = state.banks.slice();
      const fresh = snapshotBank(state, i);
      // snapshotBank rebuilds the slot from the live pattern (tracks +
      // macros + entropy) and drops per-bank METADATA that isn't part of
      // the pattern: the user's dwell-length override and the recipe tag.
      // Carry them over so re-snapping a bank to save step edits doesn't
      // reset its pattern-length override back to 'auto'.
      if (prev?.dwellBars !== undefined) fresh.dwellBars = prev.dwellBars;
      if (prev?.recipe !== undefined) fresh.recipe = prev.recipe;
      next[i] = fresh;
      return { banks: next };
    });
  },
  queueBank: (i, source = 'manual') => {
    if (i < 0 || i >= BANK_SLOT_COUNT) return;
    const state = useSequencerStore.getState();
    const slot = state.banks[i];
    if (!slot) return;
    if (i === state.activeBank) return;
    // Auto-save: a user-initiated bank switch commits the outgoing bank's
    // live step edits back into its slot first (snapBank preserves the
    // dwell/recipe metadata), so authoring across banks never loses work.
    // Ghost auto-picks pass source='auto' to SKIP this — baking the
    // performance's bank rotation / runtime state into saved patterns
    // would permanently drift the authored banks.
    const outgoing = state.activeBank;
    if (source === 'manual' && outgoing !== null && outgoing !== i) {
      useSequencerStore.getState().snapBank(outgoing);
    }
    if (!state.playing) {
      // Stopped path: globalStep is 0 after setPlaying(false) reset, so
      // sceneStartStep also lands at 0. Next play tick: sceneStep = 0.
      // No queue-stage log entry — the commit entry covers it.
      applyBankSlot(set, i, slot, state.globalStep);
      return;
    }
    set({ pendingBank: i });
    if (source === 'manual') {
      let nonce = '';
      while (nonce.length < 12) {
        nonce += Math.random().toString(16).slice(2);
      }
      nonce = nonce.slice(0, 12).toUpperCase();
      useSequencerStore.getState().pushGhostPickEvent({
        kind: 'manual',
        globalStep: state.globalStep,
        slot: i,
        nonce,
      });
    }
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
      voicing: 0,
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
        // Fold the live pattern into the active bank slot so the snapped
        // scene captures current on-screen step edits (auto-save).
        banks: banksWithLiveActiveBank(state).map((b) =>
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
          voicing: state.voicing,
        },
        sceneGraph: { ...state.sceneGraph },
      };
      const scenes = state.composition.scenes.slice();
      scenes[i] = scene;
      return { composition: { ...state.composition, scenes } };
    });
  },
  loadScene: (i, source = 'manual') => {
    const state = useSequencerStore.getState();
    if (i < 0 || i >= COMPOSITION_SLOT_COUNT) return;
    const scene = state.composition.scenes[i];
    if (!scene) return;
    if (i === state.composition.activeScene) return;
    // Auto-save: a user-initiated switch commits the outgoing scene's live
    // edits back into its slot first, so authoring across scenes never
    // loses work (no manual snap needed). Ghost auto-advance passes
    // source='ghost' to SKIP this — baking runtime mutations / density
    // fills into the saved scenes would let a performance permanently
    // drift the authored composition.
    const outgoing = state.composition.activeScene;
    if (source === 'manual' && outgoing !== null && outgoing !== i) {
      useSequencerStore.getState().snapScene(outgoing);
    }
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
      // Fold the live working state into the active scene so the captured
      // song reflects current on-screen edits, not the stale snapshot for
      // the scene being edited (auto-save — see loadScene). Other scenes
      // capture as-is.
      const liveScenes = composeLiveActiveScene(state);
      const song: Song = {
        // Preserve the slot's user-assigned title — it's slot metadata,
        // not live state, so re-snapping (incl. the loadSong auto-save
        // snap-back) must carry it over or the title gets wiped.
        name: state.performance.songs[i]?.name,
        tracks: state.tracks.map(cloneTrack),
        banks: banksWithLiveActiveBank(state).map((b) =>
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
          voicing: state.voicing,
        },
        sceneGraph: { ...state.sceneGraph },
        scenes: liveScenes.map((sc) =>
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
    // Auto-save: commit the outgoing song's live edits back into its slot
    // before switching, so authoring across songs never loses work (same
    // rationale as loadScene). Manual switches only — the ghost set
    // advance uses swapSongImmediate, which intentionally skips this so a
    // performance doesn't bake runtime drift into the saved songs.
    const outgoing = state.performance.activeSong;
    if (outgoing !== null && outgoing !== i) {
      useSequencerStore.getState().snapSong(outgoing);
    }
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
  swapSongImmediate: (i, atGlobalStep) => {
    const state = useSequencerStore.getState();
    if (i < 0 || i >= PERFORMANCE_SLOT_COUNT) return;
    const song = state.performance.songs[i];
    if (!song) return;
    // Atomic swap right now — clears any queued pendingSong/tail-out so a
    // half-counted manual queue doesn't fight the autonomous advance.
    applySong(set, i, song, atGlobalStep);
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
  setPerformanceName: (name) =>
    set((state) => ({
      performance: {
        ...state.performance,
        name: name.trim() ? name : undefined,
      },
    })),
  setSongName: (i, name) =>
    set((state) => {
      if (i < 0 || i >= PERFORMANCE_SLOT_COUNT) return {};
      const song = state.performance.songs[i];
      if (!song) return {};
      const songs = state.performance.songs.slice();
      songs[i] = { ...song, name: name.trim() ? name : undefined };
      return { performance: { ...state.performance, songs } };
    }),
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
  replacePerformance: (next) => {
    // Install the new performance slots.
    set({
      performance: { ...next, pendingSong: null, tailOutBarsRemaining: 0 },
    });
    // Load the active song (or the first populated slot) into the live working
    // state — without this, loading a .seqset never populated its first song.
    // Saves serialize everything at scene 1 / bank 1 (see persist.ts), so a
    // freshly-saved set lands at the top with no load-time reset needed.
    let i = next.activeSong;
    if (i === null || i < 0 || i >= next.songs.length || !next.songs[i]) {
      i = next.songs.findIndex((s) => s !== null);
    }
    const song = i >= 0 ? next.songs[i] : null;
    if (song) {
      applySong(set, i, song, useSequencerStore.getState().globalStep);
      // Fresh trackIds from the file → rebuild per-track filter graphs, same
      // as importProject does on a .seq load (persist.ts).
      void import('../audio/trackFilter')
        .then((m) => m.resetTrackFilters())
        .catch(() => {});
    }
  },
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
  pushGhostPickEvent: (entry) => {
    set((s) => {
      const next = s.ghostPickLog.concat(entry);
      // Cap at GHOST_PICK_LOG_LIMIT — slice the head if we've crossed.
      if (next.length > GHOST_PICK_LOG_LIMIT) {
        next.splice(0, next.length - GHOST_PICK_LOG_LIMIT);
      }
      return { ghostPickLog: next };
    });
    emitStreamEvent({
      kind: 'ghost',
      label: ghostPickLabel(entry),
      subkind: entry.kind,
    });
  },
  // Decorate the most-recent commit log entry with its dwell decision.
  // tickBar rolls the dwell AFTER applyBankSlot commits the swap, so the
  // 'commit' entry for this slot is the most-recent push. Slot match
  // guards against a stray update tagging an unrelated entry.
  setDwellOnLastBankChange: (slot, dwellBars) =>
    set((s) => {
      if (s.ghostPickLog.length === 0) return {};
      const last = s.ghostPickLog[s.ghostPickLog.length - 1];
      if (last.kind !== 'commit') return {};
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
    const next: Partial<Pick<SequencerState, 'density' | 'chaos' | 'motion' | 'drift' | 'tension' | 'voicing'>> = {};
    if (m.density !== undefined) next.density = clamp01(m.density);
    if (m.chaos !== undefined) next.chaos = clamp01(m.chaos);
    if (m.motion !== undefined) next.motion = clamp01(m.motion, 0.5);
    if (m.drift !== undefined) next.drift = clamp01(m.drift, 1);
    if (m.tension !== undefined) next.tension = clamp01(m.tension);
    if (m.voicing !== undefined) next.voicing = clamp01(m.voicing);
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
  // Atomic swap: tracks + activeBank + pendingBank + freeze + the scene phase
  // reference all land in one set() so the scheduler's onStep callback can
  // never read mid-swap. (Macros are NOT swapped — they're global, see below.)
  // sceneStartStep = scheduler's current
  // globalStep (passed in by caller, NOT read from store — the store's
  // globalStep is the AUDIBLE step which lags the scheduled step by the
  // lookahead). Each scene's tracks then start at their own step 0 from
  // this moment — necessary for polyrhythmic content (length 11/13/etc)
  // which otherwise picks up mid-cycle at swap moments.
  //
  // Global-knob preservation: per-track mix knobs (gain / fxSend / pan /
  // filterCutoff / filterResonance / octave), hardware routing (output),
  // AND mutation carry forward from the current active tracks onto the swap
  // target. The bank's stored values for those fields are ignored — these are
  // band-global identity / live expression, not per-pattern state. mutation
  // joined this set 2026-05-29: it's a global live control (rideable via the
  // XL3 + the reworked mutation engine), not authored per pattern. Remaining
  // pattern fields (steps / length / rowRatchet / rate / lockTiming /
  // euclidean) come from the bank as before.
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
      mutation: t.mutation,
    });
  }
  const mergedTracks = slot.tracks.map((bankTrack) => {
    const cloned = cloneTrack(bankTrack);
    const globals = globalsById.get(cloned.id);
    return globals ? { ...cloned, ...globals } : cloned;
  });
  set({
    tracks: withInputArm(currentTracks, mergedTracks),
    // Macros (density/chaos/motion/drift/tension) are GLOBAL live controls —
    // NOT restored from the bank on swap (2026-05-29). Patterns are authored
    // at their intended density; the macros are the runtime expression layer
    // the user (XL3) and Ghost ride, so they persist across bank swaps. The
    // bank still stores a macros snapshot for save-compat, but it's vestigial:
    // never read back here, and bank entropy is step-based (entropy.ts), not
    // macro-based. (Scenes/songs DO still load their macros — a scene/song is
    // a deliberate composed section/piece, not a pattern swap.)
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
  resetBranchWalk();
  resetStepAccumulators();
  // Per-track filter graphs intentionally KEEP across bank swaps. trackIds
  // are stable (compose / variant preserve t.id), and fxModulation's RAF
  // loop slews cutoff/resonance/fxSend to the new bank's per-track values
  // via setTargetAtTime — so a disconnect here would only buy us cutting
  // off in-flight sample tails for tracks that survive the swap. Project
  // import (persist.ts) DOES reset filters because trackIds change there.

  // Commit-stage log entry. The matching queue-stage entry (auto or
  // manual) was pushed earlier by pickNextBank or queueBank; this is the
  // "pattern N · active" pair that confirms the audible swap. Determine
  // trigger by walking back to the most-recent queue-stage entry for this
  // slot within the 1-bar window (32 globalSteps).
  const post = useSequencerStore.getState();
  const log = post.ghostPickLog;
  let trigger: 'auto' | 'manual' = 'manual';
  for (let j = log.length - 1; j >= 0; j--) {
    const e = log[j];
    if (atGlobalStep - e.globalStep > 32) break;
    if ((e.kind === 'auto' || e.kind === 'manual') && e.slot === i) {
      trigger = e.kind;
      break;
    }
  }
  post.pushGhostPickEvent({
    kind: 'commit',
    globalStep: atGlobalStep,
    slot: i,
    trigger,
  });
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
    tracks: withInputArm(state.tracks, scene.tracks.map(cloneTrack)),
    banks: scene.banks.map((b) =>
      b
        ? { ...b, tracks: b.tracks.map(cloneTrack), macros: { ...b.macros } }
        : null,
    ),
    activeBank: scene.activeBank,
    pendingBank: null,
    // Macros are GLOBAL — NOT restored on scene swap (2026-05-29), same as
    // bank swap (applyBankSlot). The live macro layer (density/chaos/motion/
    // drift/tension) persists across scenes; the scene's stored macros are
    // vestigial save-compat data. Loading a project restores macros from the
    // top-level persisted value (exportProject/importProject), not per-scene.
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
  resetBranchWalk();
  resetStepAccumulators();
  useSequencerStore.getState().pushGhostPickEvent({
    kind: 'scene',
    globalStep: atGlobalStep,
    slot: i,
  });
}

// Returns the composition's scenes with the ACTIVE scene replaced by a
// fresh snapshot of the live working state. The active scene is edited
// in place via the live state; its stored snapshot goes stale the moment
// anything changes. Callers that capture/serialize a composition use this
// so the active scene reflects current edits (auto-save). Returns shallow
// references — callers that need deep clones (snapSong) clone downstream.
function composeLiveActiveScene(state: SequencerState): (Scene | null)[] {
  const { composition } = state;
  if (composition.activeScene === null) return composition.scenes;
  const scenes = composition.scenes.slice();
  scenes[composition.activeScene] = {
    tracks: state.tracks,
    banks: banksWithLiveActiveBank(state),
    activeBank: state.activeBank,
    macros: {
      density: state.density,
      chaos: state.chaos,
      motion: state.motion,
      drift: state.drift,
      tension: state.tension,
      voicing: state.voicing,
    },
    sceneGraph: state.sceneGraph,
  };
  return scenes;
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
    tracks: withInputArm(state.tracks, song.tracks.map(cloneTrack)),
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
    voicing: song.macros.voicing ?? 0,
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
  resetBranchWalk();
  resetStepAccumulators();
  // Re-seed chord context against the new song's root + scale so root/
  // chord-tone followers latch onto the new key immediately rather than
  // carrying the prior song's harmony until the chord master plays its
  // next step.
  resetChordContext(song.rootNote, song.scale);
}
