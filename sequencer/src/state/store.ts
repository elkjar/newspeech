import { create } from 'zustand';

export interface Step {
  on: boolean;
  velocity: number;
}

interface SequencerState {
  bpm: number;
  steps: Step[];
  currentStep: number;
  playing: boolean;
  setBpm: (bpm: number) => void;
  toggleStep: (index: number) => void;
  setCurrentStep: (index: number) => void;
  setPlaying: (playing: boolean) => void;
}

export const NUM_STEPS = 16;

const initialSteps: Step[] = Array.from({ length: NUM_STEPS }, (_, i) => ({
  on: i % 4 === 0,
  velocity: 1,
}));

export const useSequencerStore = create<SequencerState>((set) => ({
  bpm: 120,
  steps: initialSteps,
  currentStep: 0,
  playing: false,
  setBpm: (bpm) => set({ bpm }),
  toggleStep: (index) =>
    set((state) => {
      const steps = state.steps.slice();
      steps[index] = { ...steps[index], on: !steps[index].on };
      return { steps };
    }),
  setCurrentStep: (currentStep) => set({ currentStep }),
  setPlaying: (playing) => set({ playing }),
}));
