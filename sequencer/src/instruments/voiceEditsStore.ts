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
import { getRegisteredKits } from './manifestRegistry';

const LS_VOICE_EDITS = 'newspeech.sequencer.voiceedits';

// Sample playback loop mode. Codes 0-3 map 1:1 to the `.pti` playmode subset and
// to the native engine's loop_mode code (off 0 · fwd 1 · bwd 2 · pingpong 3).
// `rev` (code 4) is an app-only extension: a reverse ONE-SHOT — reads the window
// backward once, then stops (unlike `bwd`, which loops backward forever). It has
// no `.pti` equivalent, so exportPti clamps it back to OneShot.
export type LoopMode = 'off' | 'fwd' | 'bwd' | 'pingpong' | 'rev';

export const LOOP_MODE_CODE: Record<LoopMode, number> = {
  off: 0,
  fwd: 1,
  bwd: 2,
  pingpong: 3,
  rev: 4,
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

// One LFO cycle per this note value, in BARS (4/4: '1' = a bar = 4 beats,
// '1/4' = one beat). The full set mirrors the Tracker's LFO_SPEED enum 1:1
// (128 … 1 … 1/64, including the dotted/triplet 3/2·3/4·3/8·3/16 and triplet
// 1/3·1/6·1/12·1/24), so the synced rate transfers to `.pti` by name on export.
// '1/1' is kept as a legacy alias of '1' (older stored edits); it's not offered
// in the UI list. Beats-per-cycle drives the local Hz derivation.
export type LfoDivision =
  | '128' | '96' | '64' | '48' | '32' | '24' | '16' | '12' | '8' | '6'
  | '4' | '3' | '2' | '3/2' | '1' | '3/4' | '1/2' | '3/8' | '1/3' | '1/4'
  | '3/16' | '1/6' | '1/8' | '1/12' | '1/16' | '1/24' | '1/32' | '1/48' | '1/64'
  | '1/1';

// UI order: slowest → fastest. '1/1' alias omitted (use '1').
export const LFO_DIVISIONS: LfoDivision[] = [
  '128', '96', '64', '48', '32', '24', '16', '12', '8', '6',
  '4', '3', '2', '3/2', '1', '3/4', '1/2', '3/8', '1/3', '1/4',
  '3/16', '1/6', '1/8', '1/12', '1/16', '1/24', '1/32', '1/48', '1/64',
];

const LFO_DIVISION_BEATS: Record<LfoDivision, number> = {
  '128': 512, '96': 384, '64': 256, '48': 192, '32': 128, '24': 96,
  '16': 64, '12': 48, '8': 32, '6': 24, '4': 16, '3': 12, '2': 8,
  '3/2': 6, '1': 4, '1/1': 4, '3/4': 3, '1/2': 2, '3/8': 1.5,
  '1/3': 4 / 3, '1/4': 1, '3/16': 0.75, '1/6': 2 / 3, '1/8': 0.5,
  '1/12': 1 / 3, '1/16': 0.25, '1/24': 1 / 6, '1/32': 0.125,
  '1/48': 1 / 12, '1/64': 0.0625,
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

// Playback mode (editor "playmode" selector). Mirrors the .pti
// InstrumentPlayMode subset. 'sample' is the normal sample player (one-shot or
// looped via `loopMode`); 'granular' is the single windowed read-head engine
// (Phase C). 'slice' / 'wavetable' are scaffolded for later phases. The code
// map below targets the .pti playmode field on export — but note 'sample' maps
// to OneShot/ForwardLoop/etc. THROUGH `loopMode` (see exportPti), so PLAYMODE_CODE
// only carries the non-'sample' modes' direct .pti values.
export type Playmode = 'sample' | 'slice' | 'wavetable' | 'granular';

// Per-instrument granular (editor Phase C). The Tracker granular engine is
// single-grain: one windowed read of `grainMs` from `position`, shaped by
// `shape`, read in `direction`, repeating to sustain. position is swept by the
// granular-position automation (granPosLfo / granPosEnv → .pti automations[4]).
export type GrainShape = 'square' | 'triangle' | 'gauss'; // .pti shape 0/1/2
export type GrainDir = 'fwd' | 'bwd' | 'pingpong'; // .pti type 0/1/2

export const GRAIN_SHAPE_CODE: Record<GrainShape, number> = {
  square: 0,
  triangle: 1,
  gauss: 2,
};

export const GRAIN_DIR_CODE: Record<GrainDir, number> = {
  fwd: 0,
  bwd: 1,
  pingpong: 2,
};

export interface GranularEdit {
  grainMs: number; // grain length, 1..1000 ms (.pti grainLength 44..44100 samples)
  position: number; // 0..1 into the sample (.pti currentPosition 0..65535)
  shape: GrainShape; // grain window
  direction: GrainDir; // read direction
  // Per-grain start scatter (0..1 of the sample): each grain re-triggers from a
  // random offset ± this around the position, so the read "jumps around" the
  // point instead of tracking one forward span — the hardware-like grain cloud.
  // LOCAL audition only (the .pti has no spray field; the hardware applies its
  // own inherent scatter), so it shapes the design-monitor feel, not the export.
  spray: number;
}

export const DEFAULT_GRANULAR: GranularEdit = {
  grainMs: 80,
  position: 0.25,
  shape: 'gauss',
  direction: 'fwd',
  spray: 0.19,
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
  granPosLfo: 6, // granular read position (.pti automations[4]); granular mode only
  granPosEnv: 7,
} as const;

export interface VoiceEdit {
  gain?: number; // multiplier on the manifest gain; default 1 (unchanged)
  tune?: number; // coarse pitch, semitones -24..24; default 0
  finetune?: number; // fine pitch, cents -100..100; default 0. Sub-semitone trim for
                     // correcting a recorded sample toward its intended pitch — maps
                     // to the .pti `finetune` field (the Tracker's separate Finetune
                     // control), composes with `tune` on the audio path.
  start?: number; // sample start, fraction 0..1; default 0
  end?: number; // sample end, fraction 0..1; default 1
  loopMode?: LoopMode; // playback loop; default 'off' (one-shot)
  filterType?: FilterType; // per-instrument filter; default 'off'
  cutoff?: number; // filter cutoff, normalized 0..1; default 1 (fully open)
  resonance?: number; // filter resonance, normalized 0..1; default 0
  saturation?: number; // per-voice drive 0..1; default 0 (bypass). Applied
                       // post-filter in the engine (a cranked resonance
                       // screams INTO the shaper — that's the point); same
                       // tanh curve as the mangler-bus pre-drive. Maps to
                       // the .pti `overdrive` (0-100) on export.
  bitDepth?: number; // per-voice bit crush, integer 4..16; default 16
                     // (bypass). Applied after saturation (drive → crush),
                     // matching the .pti `bitdepth` range 1:1 on export.
  reverbSend?: number; // additive send to the global reverb return, 0..1; default 0
                       // (Volume/Tune/Rev Send/Delay Send mirror the .pti instrument set)
  delaySend?: number; // send to the delay aux, 0..1; default 0. Stored, exported
                      // to .pti, and audible in-app via the native delay aux
                      // (shipped 0.8.2 alongside the reverb send).
  filterLfo?: FilterLfoEdit; // cutoff LFO (special — bespoke engine path)
  ampEnv?: AmpEnvEdit; // volume envelope (special — overrides manifest env)
  // Generic-mod grid:
  volLfo?: LfoMod; // tremolo
  panEnv?: EnvMod;
  panLfo?: LfoMod;
  cutoffEnv?: EnvMod;
  pitchEnv?: EnvMod; // depth in semitones
  pitchLfo?: LfoMod; // depth in semitones (vibrato)
  // Granular (Phase C):
  playmode?: Playmode; // default 'sample'
  granular?: GranularEdit; // grain params (only used when playmode === 'granular')
  granPosLfo?: LfoMod; // sweeps granular read position; depth in sample fraction
  granPosEnv?: EnvMod; // depth in sample fraction
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
  const e = resolvedVoiceEdit(voiceId);
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
  // Granular-position automation only matters in granular mode (it sweeps the
  // grain read position). Skip the slots otherwise so non-granular voices carry
  // no extra modulators.
  if ((e.playmode ?? 'sample') === 'granular') {
    out.push(lfoSpec(MOD_SLOT.granPosLfo, e.granPosLfo, bpm));
    out.push(envSpec(MOD_SLOT.granPosEnv, e.granPosEnv));
  }
  return out.filter((m): m is ModSpec => m !== null);
}

// Granular params resolved for the audio path. `on` gates the single
// windowed read-head engine; the rest mirror GranularEdit (shape/direction as
// the native/.pti codes, position 0..1, grain length in ms). Off (and default
// params) when the voice isn't in granular mode.
export function voiceGranular(voiceId: string): {
  on: boolean;
  grainMs: number;
  position: number;
  shape: number;
  direction: number;
  spray: number;
} {
  const e = resolvedVoiceEdit(voiceId);
  const on = (e?.playmode ?? 'sample') === 'granular';
  const g = e?.granular ?? DEFAULT_GRANULAR;
  return {
    on,
    grainMs: g.grainMs,
    position: g.position,
    shape: GRAIN_SHAPE_CODE[g.shape],
    direction: GRAIN_DIR_CODE[g.direction],
    spray: g.spray ?? DEFAULT_GRANULAR.spray,
  };
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
  const e = resolvedVoiceEdit(voiceId)?.ampEnv;
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

// SAVED editable params baked into the voice's manifest entry (the committed
// truth) — found by scanning the registered kits for the voiceId.
function manifestEdit(voiceId: string): VoiceEdit | undefined {
  for (const kit of getRegisteredKits()) {
    const v = kit.manifest.voices[voiceId];
    if (v) return v.edits;
  }
  return undefined;
}

// Effective edit for a voice = the SAVED manifest edits overlaid by the UNSAVED
// working edit (localStorage); the working layer wins per-field. Undefined when
// neither exists (stock instrument). Every audio-path accessor + the .pti export
// reads through this, so playback / preview / export all honor saved +
// in-progress edits identically.
export function resolvedVoiceEdit(voiceId: string): VoiceEdit | undefined {
  const working = useVoiceEditsStore.getState().voiceEdits[voiceId];
  const saved = manifestEdit(voiceId);
  if (!working && !saved) return undefined;
  return { ...(saved ?? {}), ...(working ?? {}) };
}

// True when a voice has an unsaved working edit (drives the editor's "unsaved"
// indicator + Revert). Cleared by Save, which flushes the working layer into
// the manifest.
export function hasUnsavedVoiceEdit(voiceId: string): boolean {
  return useVoiceEditsStore.getState().voiceEdits[voiceId] !== undefined;
}

// Non-React accessors for the audio path (samplePlayer.pickNativeSample).
export function voiceGainOverride(voiceId: string): number {
  const e = resolvedVoiceEdit(voiceId);
  return e?.gain ?? 1;
}

export function voiceTune(voiceId: string): number {
  const e = resolvedVoiceEdit(voiceId);
  return e?.tune ?? 0;
}

// Per-instrument fine pitch trim in cents (-100..100). Composes with voiceTune on
// the audio path — total shift = 2^((tune + finetune/100) / 12) — and exports to
// the .pti `finetune` field. Default 0 = no trim.
export function voiceFinetune(voiceId: string): number {
  const e = resolvedVoiceEdit(voiceId);
  return e?.finetune ?? 0;
}

// Per-instrument reverb send (0..1), resolved for the audio path. Default 0 =
// dry. Pushed to the native track's reverb_send so the additive aux carries
// this instrument into the shared reverb return.
export function voiceReverbSend(voiceId: string): number {
  const e = resolvedVoiceEdit(voiceId);
  return e?.reverbSend ?? 0;
}

// Per-instrument delay send (0..1). Stored + exported to .pti and audible via the
// native delay aux (shipped 0.8.2, same additive-aux shape as the reverb send).
export function voiceDelaySend(voiceId: string): number {
  const e = resolvedVoiceEdit(voiceId);
  return e?.delaySend ?? 0;
}

// Sample window + loop, resolved for the audio path. start/end are 0..1
// fractions of the sample; loop is the native loop_mode code. Defaults
// (0 / 1 / off) make the trigger behave exactly as an untrimmed one-shot.
export function voiceTrim(voiceId: string): {
  start: number;
  end: number;
  loop: number;
} {
  const e = resolvedVoiceEdit(voiceId);
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
  const e = resolvedVoiceEdit(voiceId);
  return {
    type: FILTER_TYPE_CODE[e?.filterType ?? 'off'],
    cutoff: e?.cutoff ?? 1,
    resonance: e?.resonance ?? 0,
  };
}

// Per-instrument saturation drive, resolved for the audio path. 0 = bypass.
export function voiceSaturation(voiceId: string): number {
  const e = resolvedVoiceEdit(voiceId);
  return Math.max(0, Math.min(1, e?.saturation ?? 0));
}

// Per-instrument bit depth, resolved for the audio path. 16 = bypass.
export function voiceBitDepth(voiceId: string): number {
  const e = resolvedVoiceEdit(voiceId);
  return Math.max(4, Math.min(16, Math.round(e?.bitDepth ?? 16)));
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
  const e = resolvedVoiceEdit(voiceId);
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
