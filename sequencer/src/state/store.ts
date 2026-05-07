import { create } from 'zustand';
import type { Scale } from '../audio/scale';

export type TrackType = 'drum' | 'melodic';

export interface Step {
  on: boolean;
  velocity: number;
  pitch: number;
}

export interface Track {
  id: string;
  name: string;
  type: TrackType;
  voice: string;
  mute: boolean;
  solo: boolean;
  volume: number;
  steps: Step[];
}

interface SequencerState {
  bpm: number;
  rootNote: number;
  scale: Scale;
  tracks: Track[];
  currentStep: number;
  playing: boolean;
  setBpm: (bpm: number) => void;
  setRootNote: (midi: number) => void;
  setScale: (scale: Scale) => void;
  toggleStep: (trackId: string, index: number) => void;
  setStepPitch: (trackId: string, index: number, pitch: number) => void;
  setTrackType: (trackId: string, type: TrackType) => void;
  setTrackMute: (trackId: string, mute: boolean) => void;
  setTrackSolo: (trackId: string, solo: boolean) => void;
  setTrackVolume: (trackId: string, volume: number) => void;
  setCurrentStep: (index: number) => void;
  setPlaying: (playing: boolean) => void;
}

export const NUM_STEPS = 16;

function emptySteps(): Step[] {
  return Array.from({ length: NUM_STEPS }, () => ({ on: false, velocity: 1, pitch: 0 }));
}

function patternedSteps(onIndices: number[], pitches: Record<number, number> = {}): Step[] {
  return Array.from({ length: NUM_STEPS }, (_, i) => ({
    on: onIndices.includes(i),
    velocity: 1,
    pitch: pitches[i] ?? 0,
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
    volume: 1,
    steps: patternedSteps([0, 4, 8, 12]),
  },
  {
    id: 't2',
    name: 'snare',
    type: 'drum',
    voice: 'snare',
    mute: false,
    solo: false,
    volume: 0.9,
    steps: patternedSteps([4, 12]),
  },
  {
    id: 't3',
    name: 'hat-c',
    type: 'drum',
    voice: 'hat-c',
    mute: false,
    solo: false,
    volume: 0.7,
    steps: patternedSteps([0, 2, 4, 6, 8, 10, 12, 14]),
  },
  {
    id: 't4',
    name: 'hat-o',
    type: 'drum',
    voice: 'hat-o',
    mute: false,
    solo: false,
    volume: 0.6,
    steps: patternedSteps([6, 14]),
  },
  {
    id: 't5',
    name: 'lead',
    type: 'melodic',
    voice: 'synth',
    mute: false,
    solo: false,
    volume: 0.8,
    steps: patternedSteps([0, 4, 8, 12], { 0: 0, 4: 2, 8: 4, 12: 0 }),
  },
  {
    id: 't6',
    name: 'lead 2',
    type: 'melodic',
    voice: 'synth',
    mute: false,
    solo: false,
    volume: 0.8,
    steps: emptySteps(),
  },
  {
    id: 't7',
    name: 'bass',
    type: 'melodic',
    voice: 'synth',
    mute: false,
    solo: false,
    volume: 0.85,
    steps: emptySteps(),
  },
  {
    id: 't8',
    name: 'pad',
    type: 'melodic',
    voice: 'synth',
    mute: false,
    solo: false,
    volume: 0.7,
    steps: emptySteps(),
  },
];

export const useSequencerStore = create<SequencerState>((set) => ({
  bpm: 120,
  rootNote: 60,
  scale: 'major',
  tracks: initialTracks,
  currentStep: 0,
  playing: false,
  setBpm: (bpm) => set({ bpm }),
  setRootNote: (rootNote) => set({ rootNote }),
  setScale: (scale) => set({ scale }),
  toggleStep: (trackId, index) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const steps = t.steps.slice();
        steps[index] = { ...steps[index], on: !steps[index].on };
        return { ...t, steps };
      }),
    })),
  setStepPitch: (trackId, index, pitch) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const steps = t.steps.slice();
        steps[index] = { ...steps[index], pitch };
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
  setTrackVolume: (trackId, volume) =>
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, volume } : t)),
    })),
  setCurrentStep: (currentStep) => set({ currentStep }),
  setPlaying: (playing) => set({ playing }),
}));
