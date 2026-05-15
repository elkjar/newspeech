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
  // contribution into the FX bus (0..1). 0 (default) = signal goes straight
  // to destination, bypassing tape/glitch/reverb/sat. 1 = full FX chain.
  // Per-trigger snapshot — LFO modulation steps per trigger, not glides.
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
// by the conductor's global min/max); transition banks are 1–2 bar inserts
// (drum-mute turnarounds, breakdowns, etc.) that the conductor exits fast.
// Last two pad slots (14, 15) default to 'transition' on new snapshots;
// kind is the authority once set so a user can still snap a scene to those
// slots if they want.
export type BankKind = 'scene' | 'transition';

export interface BankSlot {
  tracks: Track[];
  macros: BankMacros;
  kind: BankKind;
  // The compose recipe that generated this bank — used by the conductor for
  // per-recipe dwell ranges and same-recipe avoidance. Optional: user-saved
  // banks (snapBank) don't have a recipe, in which case the conductor falls
  // back to its global dwell range and any pick is valid.
  recipe?: string;
}

// Conductor scene-graph config. v0 is single-global-dwell + uniform-random
// walk across populated banks (excluding current) — per-bank durations and
// weighted transitions arrive in the next pass. transitionBars lerps the 5
// global macros from the previous bank's effective values to the new bank's
// saved values over N bars at the start of each scene; 0 = atomic snap.
export interface SceneGraphConfig {
  enabled: boolean;
  minBars: number;
  maxBars: number;
  transitionBars: number;
}

export const DEFAULT_SCENE_GRAPH: SceneGraphConfig = {
  enabled: false,
  minBars: 8,
  maxBars: 24,
  transitionBars: 4,
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
  // Stems toggle. When true, a take produces two WAVs (rhythm + melody)
  // instead of one combined. Forces sample-bus tap territory; `recordRaw`
  // becomes a no-op while stems is on. Count-in clicks land in both stems
  // for DAW alignment.
  stems: boolean;
  setStems: (v: boolean) => void;
  toggleStems: () => void;
  tape: TapeParams;
  setTape: (patch: Partial<TapeParams>) => void;
  glitch: GlitchParams;
  setGlitch: (patch: Partial<GlitchParams>) => void;
  reverb: ReverbParams;
  setReverb: (patch: Partial<ReverbParams>) => void;
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
  // atGlobalStep is the scheduler's currentStep at swap time. Caller passes
  // the scheduler globalStep parameter rather than letting the store read
  // its own (potentially-lagging audible-step) globalStep — the dispatch's
  // sceneStep math is keyed off the SCHEDULED step, not the audible step.
  commitPendingBank: (atGlobalStep: number) => void;
  // Conductor — persisted config + transient display state. Display fields
  // (`conductorBarsRemaining`, `conductorTargetBars`) are written by the
  // conductor module each bar; not part of saved state.
  sceneGraph: SceneGraphConfig;
  conductorBarsRemaining: number;
  conductorTargetBars: number;
  setSceneGraphEnabled: (enabled: boolean) => void;
  setSceneGraphMinBars: (bars: number) => void;
  setSceneGraphMaxBars: (bars: number) => void;
  setSceneGraphTransitionBars: (bars: number) => void;
  setConductorDisplay: (remaining: number, target: number) => void;
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
  return {
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
  stems: false,
  setStems: (v) => set({ stems: v }),
  toggleStems: () => set((s) => ({ stems: !s.stems })),
  sceneGraph: hydrateSceneGraph((defaultPreset as { sceneGraph?: unknown }).sceneGraph),
  conductorBarsRemaining: 0,
  conductorTargetBars: 0,
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
  setDensity: (v) => set({ density: clamp01(v) }),
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
      conductorBarsRemaining: 0,
      conductorTargetBars: 0,
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
  setBpm: (bpm) => set({ bpm }),
  setRootNote: (rootNote) => set({ rootNote }),
  setScale: (scale) => set({ scale }),
  toggleStep: (trackId, index) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const steps = t.steps.slice();
        const wasOn = steps[index].on;
        const turningOn = !wasOn;
        if (turningOn) {
          steps[index] = { ...steps[index], on: true, pitch: t.lastPitch };
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
      }),
    })),
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
      ...(playing ? {} : { globalStep: 0, sceneStartStep: 0 }),
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
  setSceneGraphEnabled: (enabled) =>
    set((state) => ({ sceneGraph: { ...state.sceneGraph, enabled } })),
  setSceneGraphMinBars: (bars) =>
    set((state) => {
      const next = Math.max(1, Math.min(256, Math.floor(Number.isFinite(bars) ? bars : 1)));
      // Clamp max upward if user drags min past it — keeps the range valid
      // without forcing a separate "invalid" UI state.
      const max = Math.max(state.sceneGraph.maxBars, next);
      return { sceneGraph: { ...state.sceneGraph, minBars: next, maxBars: max } };
    }),
  setSceneGraphMaxBars: (bars) =>
    set((state) => {
      const next = Math.max(1, Math.min(256, Math.floor(Number.isFinite(bars) ? bars : 1)));
      const min = Math.min(state.sceneGraph.minBars, next);
      return { sceneGraph: { ...state.sceneGraph, minBars: min, maxBars: next } };
    }),
  setSceneGraphTransitionBars: (bars) =>
    set((state) => {
      const next = Math.max(0, Math.min(32, Math.floor(Number.isFinite(bars) ? bars : 0)));
      return { sceneGraph: { ...state.sceneGraph, transitionBars: next } };
    }),
  setConductorDisplay: (remaining, target) =>
    set({ conductorBarsRemaining: remaining, conductorTargetBars: target }),
  // Batched partial macro write — single set() so subscribers fire once
  // regardless of how many fields the caller updates. Used by the conductor's
  // per-bar lerp (writes 4 — density excluded) and density drift (writes 1).
  // Manual UI knobs keep using the individual setDensity/setMotion/etc.
  // setters; this is conductor-side machinery.
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
  // filterCutoff / filterResonance / octave) carry forward from the current
  // active tracks onto the swap target. The bank's stored values for those
  // fields are ignored — knobs are band-global identity, not per-pattern
  // state. Pattern fields (steps / length / mutation / rowRatchet / rate /
  // lockTiming / euclidean) come from the bank as before.
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
}
