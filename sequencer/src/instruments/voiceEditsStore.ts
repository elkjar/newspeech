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
import { voiceEnvelope } from '../audio/voices';
import { useSequencerStore } from '../state/store';

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

// Per-instrument amplitude envelope (editor B2). An ADSR. Times are seconds
// for our engine; the .pti export converts to integer ms. `on` gates it: when
// true it OVERRIDES the manifest envelope, when false the voice keeps its
// manifest/flat behavior (values retained so toggling off doesn't lose the
// shape). (A pre-attack `delay` stage was tried but removed 2026-06-18 — the
// Tracker firmware ignores the .pti delay field, so it had no hardware use.)
export interface AmpEnvEdit {
  on: boolean;
  attack: number; // seconds
  decay: number; // seconds
  sustain: number; // 0..1 fraction of peak
  release: number; // seconds
}

// `on: false` — these defaults are what a control shows for an UNCONFIGURED
// instrument (no stored edit), so it must read as off. Toggling the section on
// sets `on: true` explicitly (merged over these defaults), which is what
// actually creates/activates the edit.
export const DEFAULT_AMP_ENV: AmpEnvEdit = {
  on: false,
  attack: 0.005,
  decay: 0.12,
  sustain: 0.7,
  release: 0.15,
};

// Per-instrument filter LFO (editor B2). Tempo-synced cyclic modulation of the
// instrument filter cutoff: the rate is a musical division (one cycle per that
// note value), so it locks to the transport — matching the Tracker's synced
// LFO. The engine still takes a plain Hz rate; we derive it from BPM × division
// at trigger time (phase resets per note). shape codes match `.pti` LFO_SHAPE.
export type LfoShape = 'revsaw' | 'saw' | 'tri' | 'square' | 'random';

export const LFO_SHAPE_CODE: Record<LfoShape, number> = {
  revsaw: 0,
  saw: 1,
  tri: 2,
  square: 3,
  random: 4,
};

// One LFO cycle per this note value. Maps by name to the `.pti` LFO_SPEED
// divisions on export (exact, no Hz guess). Beats-per-cycle drives the local
// Hz derivation (4/4 assumed: a 1/4 = one beat).
export type LfoDivision = '1/1' | '1/2' | '1/4' | '1/8' | '1/16' | '1/32';

export const LFO_DIVISIONS: LfoDivision[] = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32'];

const LFO_DIVISION_BEATS: Record<LfoDivision, number> = {
  '1/1': 4,
  '1/2': 2,
  '1/4': 1,
  '1/8': 0.5,
  '1/16': 0.25,
  '1/32': 0.125,
};

// Hz for a division at a given tempo, clamped to a sane engine range.
export function lfoDivisionToHz(division: LfoDivision, bpm: number): number {
  const beats = LFO_DIVISION_BEATS[division] ?? 1;
  const hz = bpm / 60 / beats;
  return Math.max(0.01, Math.min(40, hz));
}

export interface FilterLfoEdit {
  on: boolean;
  shape: LfoShape;
  division: LfoDivision; // tempo-synced rate (one cycle per this note value)
  depth: number; // 0..1, bipolar sweep of cutoff around its base
}

export const DEFAULT_FILTER_LFO: FilterLfoEdit = {
  on: false,
  shape: 'tri',
  division: '1/4',
  depth: 0.4,
};

// Generic modulators (editor B2 full grid). Each modulation TARGET (volume,
// pan, cutoff, pitch) can carry an envelope and/or an LFO; they sum onto the
// target's base value in the engine. Two existing specials are NOT folded in
// here: the volume ENVELOPE is the amp envelope (`ampEnv` — it overrides the
// manifest env + drives the engine's amplitude ADSR), and the cutoff LFO is
// `filterLfo`. Everything else flows through these generic mods + the engine's
// fixed `MOD_SLOT` roles. depth meaning is per-target (see voiceMods).
export interface EnvMod {
  on: boolean;
  attack: number; // seconds
  decay: number; // seconds
  sustain: number; // 0..1
  release: number; // seconds
  depth: number; // target-scaled amount (see voiceMods)
}

export interface LfoMod {
  on: boolean;
  shape: LfoShape;
  division: LfoDivision; // tempo-synced
  depth: number; // target-scaled amount (see voiceMods)
}

export const DEFAULT_ENV_MOD: EnvMod = {
  on: false,
  attack: 0.01,
  decay: 0.2,
  sustain: 0.5,
  release: 0.2,
  depth: 0.5,
};

export const DEFAULT_LFO_MOD: LfoMod = {
  on: false,
  shape: 'tri',
  division: '1/4',
  depth: 0.5,
};

// Fixed engine slot roles for the generic `mods` array. JS + Rust agree on
// these indices. (Vol-env = ampEnv and cutoff-lfo = filterLfo are handled
// separately, so they're absent here.)
export const MOD_SLOT = {
  volLfo: 0, // tremolo (amplitude)
  panEnv: 1,
  panLfo: 2,
  cutoffEnv: 3,
  pitchEnv: 4,
  pitchLfo: 5,
} as const;

export interface VoiceEdit {
  gain?: number; // multiplier on the manifest gain; default 1 (unchanged)
  tune?: number; // semitones, -24..24; default 0
  start?: number; // sample start, fraction 0..1; default 0
  end?: number; // sample end, fraction 0..1; default 1
  loopMode?: LoopMode; // playback loop; default 'off' (one-shot)
  filterType?: FilterType; // per-instrument filter; default 'off'
  cutoff?: number; // filter cutoff, normalized 0..1; default 1 (fully open)
  resonance?: number; // filter resonance, normalized 0..1; default 0
  filterLfo?: FilterLfoEdit; // cutoff LFO (special — bespoke engine path)
  ampEnv?: AmpEnvEdit; // volume envelope (special — overrides manifest env)
  // Generic-mod grid:
  volLfo?: LfoMod; // tremolo
  panEnv?: EnvMod;
  panLfo?: LfoMod;
  cutoffEnv?: EnvMod;
  pitchEnv?: EnvMod; // depth in semitones
  pitchLfo?: LfoMod; // depth in semitones (vibrato)
}

// One modulator, resolved for the audio path. slot = MOD_SLOT role; isLfo
// picks env vs lfo params; rateHz is derived from the division at the current
// BPM (lfo only). Sent to the engine as the `mods` trigger array.
export interface ModSpec {
  slot: number;
  isLfo: boolean;
  depth: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  shape: number;
  rateHz: number;
}

function envSpec(slot: number, m: EnvMod | undefined): ModSpec | null {
  if (!m?.on) return null;
  return {
    slot,
    isLfo: false,
    depth: m.depth,
    attack: m.attack,
    decay: m.decay,
    sustain: m.sustain,
    release: m.release,
    shape: 0,
    rateHz: 0,
  };
}

function lfoSpec(slot: number, m: LfoMod | undefined, bpm: number): ModSpec | null {
  if (!m?.on) return null;
  return {
    slot,
    isLfo: true,
    depth: m.depth,
    attack: 0,
    decay: 0,
    sustain: 0,
    release: 0,
    shape: LFO_SHAPE_CODE[m.shape],
    rateHz: lfoDivisionToHz(m.division, bpm),
  };
}

// All active generic modulators for a voice, ready for the trigger. Empty when
// none are on (the engine then does no extra modulation).
export function voiceMods(voiceId: string): ModSpec[] {
  const e = useVoiceEditsStore.getState().voiceEdits[voiceId];
  if (!e) return [];
  const bpm = useSequencerStore.getState().bpm || 120;
  const out: (ModSpec | null)[] = [
    lfoSpec(MOD_SLOT.volLfo, e.volLfo, bpm),
    envSpec(MOD_SLOT.panEnv, e.panEnv),
    lfoSpec(MOD_SLOT.panLfo, e.panLfo, bpm),
    envSpec(MOD_SLOT.cutoffEnv, e.cutoffEnv),
    envSpec(MOD_SLOT.pitchEnv, e.pitchEnv),
    lfoSpec(MOD_SLOT.pitchLfo, e.pitchLfo, bpm),
  ];
  return out.filter((m): m is ModSpec => m !== null);
}

// Resolved amplitude envelope for a voice: the authored edit (when enabled)
// overrides the manifest envelope; otherwise the manifest value passes through
// with delay 0. Undefined = no envelope at all (flat-gain voice, e.g. a drum
// with no authored env) — the engine then plays at flat gain as before.
export interface ResolvedEnvelope {
  attack: number;
  decay?: number;
  sustain?: number;
  release: number;
}

export function resolveVoiceEnvelope(voiceId: string): ResolvedEnvelope | undefined {
  const e = useVoiceEditsStore.getState().voiceEdits[voiceId]?.ampEnv;
  if (e?.on) {
    return { attack: e.attack, decay: e.decay, sustain: e.sustain, release: e.release };
  }
  const m = voiceEnvelope(voiceId);
  if (!m) return undefined;
  return { attack: m.attack, decay: m.decay, sustain: m.sustain, release: m.release };
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

// Cutoff LFO, resolved for the audio path. Only active when the filter itself
// is on (it has nothing to modulate otherwise). shape is the native/.pti code;
// rateHz free-running; depth 0..1. Returns off (depth 0) when disabled.
export function voiceFilterLfo(voiceId: string): {
  shape: number;
  rateHz: number;
  depth: number;
  division: LfoDivision;
} {
  const e = useVoiceEditsStore.getState().voiceEdits[voiceId];
  const lfo = e?.filterLfo;
  const filterOn = (e?.filterType ?? 'off') !== 'off';
  const division = lfo?.division ?? '1/4';
  if (!lfo?.on || !filterOn) return { shape: 0, rateHz: 0, depth: 0, division };
  const bpm = useSequencerStore.getState().bpm || 120;
  return {
    shape: LFO_SHAPE_CODE[lfo.shape],
    rateHz: lfoDivisionToHz(division, bpm),
    depth: Math.max(0, Math.min(1, lfo.depth)),
    division,
  };
}
