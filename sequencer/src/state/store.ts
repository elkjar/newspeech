import { create } from 'zustand';
import type { Scale } from '../audio/scale';
import { euclidean } from '../audio/euclidean';
import { getOverlay, clearOverlay } from '../audio/mutationOverlay';
import { resetPadDrift } from '../audio/padState';
import { resetTrackFilters } from '../audio/trackFilter';
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
import { ensureBothSections, hydrateTrack, hydrateLFOs, applyPositionalRoleDefaults, hydrateBanks, blankTrack } from './hydrate';
import {
  hydrateTape as hydrateTapeFromPreset,
  hydrateGlitch as hydrateGlitchFromPreset,
  hydrateReverb as hydrateReverbFromPreset,
  hydrateSaturation as hydrateSaturationFromPreset,
  hydrateMaster as hydrateMasterFromPreset,
} from './persist';
import defaultPreset from './defaultPreset.json';
import { setTapeParams as applyTapeParams, type TapeParams } from '../audio/tape';
import { setGlitchParams as applyGlitchParams, type GlitchParams } from '../audio/glitch';
import { setReverbParams as applyReverbParams, type ReverbParams } from '../audio/reverb';
import { setSaturationParams as applySaturationParams, type SaturationParams } from '../audio/saturation';
import { MASTER_PRESETS, setMasterParams as applyMasterParams, type MasterParams } from '../audio/master';
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

export interface BankSlot {
  tracks: Track[];
  macros: BankMacros;
}

interface SequencerState {
  bpm: number;
  rootNote: number;
  scale: Scale;
  tracks: Track[];
  lfos: LFO[];
  selectingLFO: number | null;
  globalStep: number;
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
  commitPendingBank: () => void;
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

function snapshotBank(state: {
  tracks: Track[];
  density: number;
  chaos: number;
  motion: number;
  drift: number;
  tension: number;
}): BankSlot {
  return {
    tracks: state.tracks.map(cloneTrack),
    macros: {
      density: state.density,
      chaos: state.chaos,
      motion: state.motion,
      drift: state.drift,
      tension: state.tension,
    },
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
  tape: hydrateTapeFromPreset((defaultPreset as { tape?: unknown }).tape),
  setTape: (patch) =>
    set((state) => {
      const next = { ...state.tape, ...patch };
      applyTapeParams(next);
      return { tape: next };
    }),
  glitch: hydrateGlitchFromPreset((defaultPreset as { glitch?: unknown }).glitch),
  setGlitch: (patch) =>
    set((state) => {
      const next = { ...state.glitch, ...patch };
      applyGlitchParams(next);
      return { glitch: next };
    }),
  reverb: hydrateReverbFromPreset((defaultPreset as { reverb?: unknown }).reverb),
  setReverb: (patch) =>
    set((state) => {
      const next = { ...state.reverb, ...patch };
      applyReverbParams(next);
      return { reverb: next };
    }),
  saturation: hydrateSaturationFromPreset((defaultPreset as { saturation?: unknown }).saturation),
  setSaturation: (patch) =>
    set((state) => {
      const next = { ...state.saturation, ...patch };
      applySaturationParams(next);
      return { saturation: next };
    }),
  master: hydrateMasterFromPreset((defaultPreset as { master?: unknown }).master),
  setMaster: (patch) =>
    set((state) => {
      const next = { ...state.master, ...patch };
      applyMasterParams(next);
      return { master: next };
    }),
  setMasterPreset: (name) =>
    set(() => {
      const preset = MASTER_PRESETS[name];
      if (!preset) return {};
      const next = { ...preset };
      applyMasterParams(next);
      return { master: next };
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
    let nextTrack: Track | null = null;
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        // snapshot factory midi defaults when assigning a different instrument
        // (or switching from voice/empty to instrument). Same instrument id =
        // preserve user edits.
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
        // chord-tone), which makes "add a new melodic channel" surprising
        // — the row auto-harmonizes against the chord master without the
        // user opting in. Resetting to 'semitones' makes new channels
        // independent by default; users opt into following via the
        // RowPanel interp dropdown.
        const addingMelodic =
          t.source.kind === 'empty' && sourceIsMelodic(source);
        const pitchInterp = addingMelodic ? 'semitones' : t.pitchInterp;
        nextTrack = { ...t, source, midi, pitchInterp };
        return nextTrack;
      }),
    }));
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
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, octave: clamped } : t)),
    }));
  },
  setTrackMutation: (trackId, mutation) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(mutation) ? mutation : 0));
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, mutation: clamped } : t)),
    }));
  },
  setTrackGain: (trackId, gain) => {
    const clamped = Math.max(0, Math.min(2, Number.isFinite(gain) ? gain : 1));
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, gain: clamped } : t)),
    }));
  },
  setTrackFxSend: (trackId, fxSend) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(fxSend) ? fxSend : 0));
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, fxSend: clamped } : t)),
    }));
  },
  setTrackPan: (trackId, pan) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(pan) ? pan : 0.5));
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, pan: clamped } : t)),
    }));
  },
  setTrackFilterCutoff: (trackId, cutoff) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(cutoff) ? cutoff : 1));
    set((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === trackId ? { ...t, filterCutoff: clamped } : t
      ),
    }));
  },
  setTrackFilterResonance: (trackId, resonance) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(resonance) ? resonance : 0));
    set((state) => ({
      tracks: state.tracks.map((t) =>
        t.id === trackId ? { ...t, filterResonance: clamped } : t
      ),
    }));
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
    })),
  snapBank: (i) => {
    if (i < 0 || i >= BANK_SLOT_COUNT) return;
    set((state) => {
      const next = state.banks.slice();
      next[i] = snapshotBank(state);
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
      applyBankSlot(set, i, slot);
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
  commitPendingBank: () => {
    const state = useSequencerStore.getState();
    const i = state.pendingBank;
    if (i === null) return;
    const slot = state.banks[i];
    if (!slot) {
      set({ pendingBank: null });
      return;
    }
    applyBankSlot(set, i, slot);
  },
}));

function applyBankSlot(
  set: (
    partial:
      | Partial<SequencerState>
      | ((state: SequencerState) => Partial<SequencerState>)
  ) => void,
  i: number,
  slot: BankSlot
): void {
  // Atomic swap: tracks + macros + activeBank + pendingBank + freeze all land
  // in one set() so the scheduler's onStep callback can never read mid-swap.
  set({
    tracks: slot.tracks.map(cloneTrack),
    density: slot.macros.density,
    chaos: slot.macros.chaos,
    motion: slot.macros.motion,
    drift: slot.macros.drift,
    tension: slot.macros.tension,
    activeBank: i,
    pendingBank: null,
    freeze: false,
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
  // Per-track filter graphs are keyed by trackId and would otherwise keep
  // ringing the previous pattern's filter state (high-res self-oscillation
  // tail, etc.) into the new pattern. Disconnect + clear so each pattern
  // recall starts with a fresh filter.
  resetTrackFilters();
}
