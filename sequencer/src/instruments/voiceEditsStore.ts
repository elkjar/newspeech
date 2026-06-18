// Per-voice instrument edits — the editable param layer over the manifest
// defaults. App-only (the native engine is the target; the web build is a
// relic). localStorage-backed and rig-wide like userInstrumentsStore: edits are
// GLOBAL (apply to the voice everywhere), matching the global-expression-layer
// philosophy. `.seq` files reference voices by id; a machine without these edits
// just hears the stock instrument.
//
// Phase A slice 1 = volume + tune. Both fold into the single native chokepoint
// `samplePlayer.pickNativeSample` (gain ×, pitch ×2^(tune/12)), so every native
// trigger — playback dispatch (App.tsx) AND preview (monitor.ts) — honors them.
// Later slices extend VoiceEdit with start/end, loop mode, filter, granular.

import { create } from 'zustand';

const LS_VOICE_EDITS = 'newspeech.sequencer.voiceedits';

export interface VoiceEdit {
  gain?: number; // multiplier on the manifest gain; default 1 (unchanged)
  tune?: number; // semitones, -24..24; default 0
}

interface VoiceEditsState {
  voiceEdits: Record<string, VoiceEdit>;
  setVoiceEdit: (voiceId: string, patch: Partial<VoiceEdit>) => void;
  resetVoiceEdit: (voiceId: string) => void;
}

function persist(map: Record<string, VoiceEdit>): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_VOICE_EDITS, JSON.stringify(map));
    }
  } catch {
    /* best-effort */
  }
}

function load(): Record<string, VoiceEdit> {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(LS_VOICE_EDITS);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, VoiceEdit>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export const useVoiceEditsStore = create<VoiceEditsState>((set) => ({
  voiceEdits: load(),
  setVoiceEdit: (voiceId, patch) =>
    set((state) => {
      const next = {
        ...state.voiceEdits,
        [voiceId]: { ...state.voiceEdits[voiceId], ...patch },
      };
      persist(next);
      return { voiceEdits: next };
    }),
  resetVoiceEdit: (voiceId) =>
    set((state) => {
      if (!state.voiceEdits[voiceId]) return state;
      const next = { ...state.voiceEdits };
      delete next[voiceId];
      persist(next);
      return { voiceEdits: next };
    }),
}));

// Non-React accessors for the audio path (samplePlayer.pickNativeSample).
export function voiceGainOverride(voiceId: string): number {
  const e = useVoiceEditsStore.getState().voiceEdits[voiceId];
  return e?.gain ?? 1;
}

export function voiceTune(voiceId: string): number {
  const e = useVoiceEditsStore.getState().voiceEdits[voiceId];
  return e?.tune ?? 0;
}
