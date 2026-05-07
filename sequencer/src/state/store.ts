import { create } from 'zustand';
import type { Scale } from '../audio/scale';
import { euclidean } from '../audio/euclidean';

export type TrackType = 'drum' | 'melodic';
export type EditMode = 'note' | 'velocity' | 'chance' | 'ratchet' | 'timing' | 'gate';

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
}

export interface EuclideanParams {
  hits: number;
  rotation: number;
}

export interface Track {
  id: string;
  name: string;
  type: TrackType;
  voice: string;
  mute: boolean;
  solo: boolean;
  length: number;
  lastPitch: number;
  viewPage: number;
  euclidean: EuclideanParams;
  steps: Step[];
}

export const PAGE_SIZE = 16;
export const NUM_PAGES = 4;

interface SequencerState {
  bpm: number;
  rootNote: number;
  scale: Scale;
  tracks: Track[];
  globalStep: number;
  playing: boolean;
  editMode: EditMode;
  setEditMode: (mode: EditMode) => void;
  selectedStep: StepSelection | null;
  setSelectedStep: (sel: StepSelection | null) => void;
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
  setTrackType: (trackId: string, type: TrackType) => void;
  setTrackMute: (trackId: string, mute: boolean) => void;
  setTrackSolo: (trackId: string, solo: boolean) => void;
  setTrackLength: (trackId: string, length: number) => void;
  setTrackPage: (trackId: string, page: number) => void;
  setTrackEuclidean: (trackId: string, partial: Partial<EuclideanParams>) => void;
  setGlobalStep: (step: number) => void;
  setPlaying: (playing: boolean) => void;
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
  }));
}

function patternedSteps(
  onIndices: number[],
  pitches: Record<number, number> = {},
  velocity = 1
): Step[] {
  return Array.from({ length: MAX_STEPS }, (_, i) => ({
    on: onIndices.includes(i),
    velocity,
    pitch: pitches[i] ?? 0,
    probability: 100,
    ratchet: 1,
    microTiming: 0,
    gate: 1,
  }));
}

const initialTracks: Track[] = [
  {
    id: 't1',
    name: 'kick',
    type: 'drum',
    voice: 'kick',
    mute: false,
    solo: false,
    length: DEFAULT_LENGTH,
    lastPitch: 0,
    viewPage: 0,
    euclidean: { hits: 0, rotation: 0 },
    steps: patternedSteps([0, 4, 8, 12], {}, 1),
  },
  {
    id: 't2',
    name: 'snare',
    type: 'drum',
    voice: 'snare',
    mute: false,
    solo: false,
    length: DEFAULT_LENGTH,
    lastPitch: 0,
    viewPage: 0,
    euclidean: { hits: 0, rotation: 0 },
    steps: patternedSteps([4, 12], {}, 0.9),
  },
  {
    id: 't3',
    name: 'hat-c',
    type: 'drum',
    voice: 'hat-c',
    mute: false,
    solo: false,
    length: DEFAULT_LENGTH,
    lastPitch: 0,
    viewPage: 0,
    euclidean: { hits: 0, rotation: 0 },
    steps: patternedSteps([0, 2, 4, 8, 10, 12], {}, 0.7),
  },
  {
    id: 't4',
    name: 'hat-o',
    type: 'drum',
    voice: 'hat-o',
    mute: false,
    solo: false,
    length: DEFAULT_LENGTH,
    lastPitch: 0,
    viewPage: 0,
    euclidean: { hits: 0, rotation: 0 },
    steps: patternedSteps([6, 14], {}, 0.6),
  },
  {
    id: 't5',
    name: 'lead',
    type: 'melodic',
    voice: 'synth',
    mute: false,
    solo: false,
    length: DEFAULT_LENGTH,
    lastPitch: 0,
    viewPage: 0,
    euclidean: { hits: 0, rotation: 0 },
    steps: patternedSteps([0, 4, 8, 12], { 0: 0, 4: 2, 8: 4, 12: 0 }, 0.8),
  },
  {
    id: 't6',
    name: 'lead 2',
    type: 'melodic',
    voice: 'synth',
    mute: false,
    solo: false,
    length: DEFAULT_LENGTH,
    lastPitch: 0,
    viewPage: 0,
    euclidean: { hits: 0, rotation: 0 },
    steps: emptySteps(),
  },
  {
    id: 't7',
    name: 'bass',
    type: 'melodic',
    voice: 'synth',
    mute: false,
    solo: false,
    length: DEFAULT_LENGTH,
    lastPitch: 0,
    viewPage: 0,
    euclidean: { hits: 0, rotation: 0 },
    steps: emptySteps(),
  },
  {
    id: 't8',
    name: 'pad',
    type: 'melodic',
    voice: 'synth',
    mute: false,
    solo: false,
    length: DEFAULT_LENGTH,
    lastPitch: 0,
    viewPage: 0,
    euclidean: { hits: 0, rotation: 0 },
    steps: emptySteps(),
  },
];

export const useSequencerStore = create<SequencerState>((set) => ({
  bpm: 120,
  rootNote: 60,
  scale: 'major',
  tracks: initialTracks,
  globalStep: 0,
  playing: false,
  editMode: 'note',
  setEditMode: (editMode) => set({ editMode }),
  selectedStep: null,
  setSelectedStep: (selectedStep) => set({ selectedStep }),
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
        steps[index] = {
          ...steps[index],
          on: turningOn,
          pitch: turningOn ? t.lastPitch : steps[index].pitch,
        };
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
  setTrackType: (trackId, type) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        let voice = t.voice;
        if (type === 'melodic') voice = 'synth';
        else if (type === 'drum' && t.voice === 'synth') voice = 'kick';
        return { ...t, type, voice };
      }),
    })),
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
  setPlaying: (playing) => set({ playing }),
}));
