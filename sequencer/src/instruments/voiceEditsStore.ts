// Per-voice instrument edits — the editable param layer over the manifest
// defaults. App-only (the native engine is the target; the web build is a
// relic). localStorage-backed and rig-wide like userInstrumentsStore: edits are
// GLOBAL (apply to the voice everywhere), matching the global-expression-layer
// philosophy. `.seq` files reference voices by id; a machine without these edits
// just hears the stock instrument.
//
// Phase A slice 1 = volume + tune. Slice A3 = sample start/end trim + loop mode.
// All fold into the single native chokepoint `samplePlayer.pickNativeSample`
// (gain ×, pitch ×2^(tune/12), start/end/loop passed to the trigger), so every
// native trigger — playback dispatch (App.tsx) AND preview (monitor.ts) — honors
// them. Later slices extend VoiceEdit with filter, granular.

import { create } from 'zustand';

const LS_VOICE_EDITS = 'newspeech.sequencer.voiceedits';

// Sample playback loop mode. Maps 1:1 to the `.pti` playmode subset and to the
// native engine's loop_mode code (off 0 · fwd 1 · bwd 2 · pingpong 3).
export type LoopMode = 'off' | 'fwd' | 'bwd' | 'pingpong';

export const LOOP_MODE_CODE: Record<LoopMode, number> = {
  off: 0,
  fwd: 1,
  bwd: 2,
  pingpong: 3,
};

// Per-instrument filter. 'off' bypasses; lp/hp/bp map to the native filter
// codes and to the `.pti` InstrumentFilterType (LowPass 0 · HighPass 1 ·
// BandPass 2) via FILTER_TYPE_CODE. Distinct from the per-track mixer ladder.
export type FilterType = 'off' | 'lp' | 'hp' | 'bp';

export const FILTER_TYPE_CODE: Record<FilterType, number> = {
  off: 0,
  lp: 1,
  hp: 2,
  bp: 3,
};

export interface VoiceEdit {
  gain?: number; // multiplier on the manifest gain; default 1 (unchanged)
  tune?: number; // semitones, -24..24; default 0
  start?: number; // sample start, fraction 0..1; default 0
  end?: number; // sample end, fraction 0..1; default 1
  loopMode?: LoopMode; // playback loop; default 'off' (one-shot)
  filterType?: FilterType; // per-instrument filter; default 'off'
  cutoff?: number; // filter cutoff, normalized 0..1; default 1 (fully open)
  resonance?: number; // filter resonance, normalized 0..1; default 0
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

// Sample window + loop, resolved for the audio path. start/end are 0..1
// fractions of the sample; loop is the native loop_mode code. Defaults
// (0 / 1 / off) make the trigger behave exactly as an untrimmed one-shot.
export function voiceTrim(voiceId: string): {
  start: number;
  end: number;
  loop: number;
} {
  const e = useVoiceEditsStore.getState().voiceEdits[voiceId];
  const start = e?.start ?? 0;
  const end = e?.end ?? 1;
  return {
    start,
    end,
    loop: LOOP_MODE_CODE[e?.loopMode ?? 'off'],
  };
}

// Per-instrument filter, resolved for the audio path. type is the native
// filter code (0 off · 1 lp · 2 hp · 3 bp); cutoff/resonance are 0..1.
// Defaults (off / 1 / 0) bypass the filter entirely.
export function voiceFilter(voiceId: string): {
  type: number;
  cutoff: number;
  resonance: number;
} {
  const e = useVoiceEditsStore.getState().voiceEdits[voiceId];
  return {
    type: FILTER_TYPE_CODE[e?.filterType ?? 'off'],
    cutoff: e?.cutoff ?? 1,
    resonance: e?.resonance ?? 0,
  };
}
