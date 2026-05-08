import { create } from 'zustand';
import type { Scale } from '../audio/scale';
import { euclidean } from '../audio/euclidean';
import { getOverlay, clearOverlay } from '../audio/mutationOverlay';
import { defaultLFOs, type LFO, type LFODestination } from '../audio/lfo';
import { hydrateTrack } from './hydrate';
import defaultPreset from './defaultPreset.json';

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
  tieToNext: boolean;
}

export interface EuclideanParams {
  hits: number;
  rotation: number;
}

export interface Track {
  id: string;
  voice: string;
  mute: boolean;
  solo: boolean;
  length: number;
  lastPitch: number;
  viewPage: number;
  mutation: number;
  rowChance: number;
  rowRatchet: number;
  morph: number;
  slotA: Step[] | null;
  slotB: Step[] | null;
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
  lfos: LFO[];
  selectingLFO: number | null;
  globalStep: number;
  playing: boolean;
  editMode: EditMode;
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
  setTrackVoice: (trackId: string, voice: string) => void;
  setTrackMutation: (trackId: string, mutation: number) => void;
  setTrackRowChance: (trackId: string, rowChance: number) => void;
  setTrackRowRatchet: (trackId: string, rowRatchet: number) => void;
  setTrackMorph: (trackId: string, morph: number) => void;
  snapTrackSlot: (trackId: string, slot: 'A' | 'B', clear?: boolean) => void;
  recallTrackSlot: (trackId: string, slot: 'A' | 'B') => void;
  clearTrack: (trackId: string) => void;
  commitMutationOverlay: () => void;
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
    tieToNext: false,
  }));
}

const presetTracks = (defaultPreset.tracks as Array<Partial<Track> & { id: string }>).map(
  hydrateTrack
);

export const useSequencerStore = create<SequencerState>((set) => ({
  bpm: defaultPreset.bpm,
  rootNote: defaultPreset.rootNote,
  scale: defaultPreset.scale as Scale,
  tracks: presetTracks,
  lfos: defaultLFOs(),
  selectingLFO: null,
  globalStep: 0,
  playing: false,
  editMode: 'note',
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
  setStepTie: (trackId, index, tied) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const steps = t.steps.slice();
        steps[index] = { ...steps[index], tieToNext: tied };
        return { ...t, steps };
      }),
    })),
  setTrackVoice: (trackId, voice) =>
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, voice } : t)),
    })),
  setTrackMutation: (trackId, mutation) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(mutation) ? mutation : 0));
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, mutation: clamped } : t)),
    }));
  },
  setTrackRowChance: (trackId, rowChance) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(rowChance) ? rowChance : 0));
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, rowChance: clamped } : t)),
    }));
  },
  setTrackRowRatchet: (trackId, rowRatchet) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(rowRatchet) ? rowRatchet : 0));
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, rowRatchet: clamped } : t)),
    }));
  },
  setTrackMorph: (trackId, morph) => {
    const clamped = Math.max(0, Math.min(1, Number.isFinite(morph) ? morph : 0));
    set((state) => ({
      tracks: state.tracks.map((t) => (t.id === trackId ? { ...t, morph: clamped } : t)),
    }));
  },
  snapTrackSlot: (trackId, slot, clear = false) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const snapshot = clear ? null : t.steps.map((s) => ({ ...s }));
        return slot === 'A' ? { ...t, slotA: snapshot } : { ...t, slotB: snapshot };
      }),
    })),
  recallTrackSlot: (trackId, slot) =>
    set((state) => ({
      tracks: state.tracks.map((t) => {
        if (t.id !== trackId) return t;
        const snap = slot === 'A' ? t.slotA : t.slotB;
        if (!snap) return t;
        return { ...t, steps: snap.map((s) => ({ ...s })) };
      }),
    })),
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
  setPlaying: (playing) => set({ playing }),
}));
