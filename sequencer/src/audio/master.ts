// Master stage — final-pass tone-shaping unit at the chain end, modeled on
// the OTO BOUM. Param shape, defaults, presets, and label math only; the
// DSP lives in Rust (audio.rs master stages), pushed via
// nativeEngine.setMasterFilters / setMasterComp / setMasterDist / setMasterGate.

export interface MasterParams {
  // 0..1 → −12..+18 dB
  input: number;
  // 0=Flat, 1=75 Hz, 2=150 Hz, 3=300 Hz (12 dB/oct highpass)
  loCut: number;
  // 0..1 — one-knob compressor amount (threshold + ratio + makeup, with
  // negative ratio past 0.9 — louder input → quieter output)
  comp: number;
  // 0..5 — index into COMP_ATTACK_MS
  compAttack: number;
  // 0..5 — index into COMP_RELEASE_MS
  compRelease: number;
  // 0=Boost, 1=Tube, 2=Fuzz, 3=Square
  mode: number;
  // 0..1 — maps to a per-mode drive curve inside the engine
  drive: number;
  // 0..0.2 — bias offset (only audible on asymmetric modes: Tube, Fuzz)
  bias: number;
  // 0..1 — dry/wet crossfade across the distortion stage only
  // (comp/lo-cut/hi-cut/trim always engaged)
  mix: number;
  // 0..1 → 10..20000 Hz, log curve
  hiCut: number;
  // 0..1 → −24..0 dB
  trim: number;
  // Noise gate / chopper toggle
  gateEnabled: boolean;
  // 0..1 → −60..0 dB. Higher = more chopping (more of the signal gets gated).
  gateThreshold: number;
  // Full-unit bypass; dry tap with no processing
  bypass: boolean;
}

// Defaults cooked from Chris's tuned session (2026-05-11). The chain
// runs ~3.6 dB input gain → comp at 0.80 with slow attack/long release
// → Boost mode at light drive, 66% wet → light hi-cut → −6.6 dB output
// trim. Reverb sits at 15% mix; glitch fires on ~14% of beats. Gate is
// off by default but pre-tuned to −6 dB for one-toggle chopper use.
export const DEFAULT_MASTER_PARAMS: MasterParams = {
  input: 0.52,        // +3.6 dB
  loCut: 1,           // 75 Hz
  comp: 0.80,
  compAttack: 4,      // 10 ms
  compRelease: 5,     // 10 s
  mode: 0,            // boost
  drive: 0.34,
  bias: 0.082,
  mix: 0.66,
  hiCut: 0.97,        // 15.92 kHz
  trim: 0.725,        // −6.6 dB
  gateEnabled: false,
  gateThreshold: 0.80, // −6 dB
  bypass: false,
};

// Index 0 (Flat) is rendered as a near-DC highpass that's effectively
// transparent — keeps the filter in-path so toggling doesn't reconnect stages.
const LO_CUT_FREQS: readonly number[] = [1, 75, 150, 300] as const;
const MODE_NAMES: readonly string[] = ['boost', 'tube', 'fuzz', 'square'] as const;
const COMP_ATTACK_MS: readonly number[] = [0.1, 0.3, 1, 3, 10, 30] as const;
const COMP_RELEASE_MS: readonly number[] = [30, 100, 300, 1000, 3000, 10000] as const;

function hiCutFreq(v: number): number {
  return 10 * Math.pow(2000, Math.max(0, Math.min(1, v)));
}

function loCutIndex(v: number): number {
  const idx = Math.round(v);
  return Math.max(0, Math.min(LO_CUT_FREQS.length - 1, idx));
}

function modeIndex(v: number): number {
  const idx = Math.round(v);
  return Math.max(0, Math.min(MODE_NAMES.length - 1, idx));
}

function compAttackIndex(v: number): number {
  const idx = Math.round(v);
  return Math.max(0, Math.min(COMP_ATTACK_MS.length - 1, idx));
}

function compReleaseIndex(v: number): number {
  const idx = Math.round(v);
  return Math.max(0, Math.min(COMP_RELEASE_MS.length - 1, idx));
}

// Threshold knob maps to -30..0 dB rather than the full -60..0 the engine
// allows. Reasoning: master-bus signal post-comp-and-makeup sits in the
// −10..−3 dB range typically. With the full -60..0 mapping, the useful
// zone of the knob was the top 25%; -30..0 spreads the useful zone across
// the whole knob. For deeper noise suppression, the engine still accepts
// down to −60 if anyone ever wants to widen the range later.
function gateThresholdDb(v: number): number {
  return -30 + Math.max(0, Math.min(1, v)) * 30;
}

// Label helpers for the FX panel — keep formatting alongside the math.
export function inputDbLabel(v: number): string {
  const db = -12 + Math.max(0, Math.min(1, v)) * 30;
  return `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB`;
}

export function trimDbLabel(v: number): string {
  const db = -24 + Math.max(0, Math.min(1, v)) * 24;
  return `${db.toFixed(1)} dB`;
}

export function hiCutLabel(v: number): string {
  const hz = hiCutFreq(v);
  if (hz >= 1000) return `${(hz / 1000).toFixed(2)} kHz`;
  return `${Math.round(hz)} Hz`;
}

export function loCutLabel(v: number): string {
  const idx = loCutIndex(v);
  return idx === 0 ? 'flat' : `${LO_CUT_FREQS[idx]} Hz`;
}

export function modeLabel(v: number): string {
  return MODE_NAMES[modeIndex(v)];
}

export function compAttackLabel(v: number): string {
  return `${COMP_ATTACK_MS[compAttackIndex(v)]} ms`;
}

export function compReleaseLabel(v: number): string {
  const ms = COMP_RELEASE_MS[compReleaseIndex(v)];
  return ms >= 1000 ? `${(ms / 1000).toFixed(0)} s` : `${ms} ms`;
}

export function gateThresholdLabel(v: number): string {
  return `${gateThresholdDb(v).toFixed(0)} dB`;
}

export const LO_CUT_POSITIONS = LO_CUT_FREQS.length;
export const MODE_COUNT = MODE_NAMES.length;
export const COMP_ATTACK_COUNT = COMP_ATTACK_MS.length;
export const COMP_RELEASE_COUNT = COMP_RELEASE_MS.length;

// Named master-section presets. `default` matches DEFAULT_MASTER_PARAMS
// exactly. Apply via the store's `setMasterPreset(name)` action; more can
// be added by appending to this object (the FXPanel dropdown reads
// `MASTER_PRESET_NAMES` and renders one option per key).
export const MASTER_PRESETS: Record<string, MasterParams> = {
  default: { ...DEFAULT_MASTER_PARAMS },
  // Square mode at drive=0 — the 1-bit gated character. Only loud signals
  // cross the threshold and become square; quieter passages drop to silence.
  // Tuned 2026-05-11: hot input (+7.5 dB) drives more material above the
  // comparator threshold, comp at 0.6 evens out dynamics before the gate,
  // unity trim keeps the slammed output bright on the bus.
  'square glitch': {
    input: 0.65,         // +7.5 dB
    loCut: 1,            // 75 Hz
    comp: 0.60,
    compAttack: 4,       // 10 ms
    compRelease: 5,      // 10 s
    mode: 3,             // square
    drive: 0,
    bias: 0.074,
    mix: 1.0,
    hiCut: 0.97,         // 15.92 kHz
    trim: 1.0,           // 0 dB
    gateEnabled: false,
    gateThreshold: 0.80, // −6 dB
    bypass: false,
  },
};

export const MASTER_PRESET_NAMES = Object.keys(MASTER_PRESETS);

// Returns the preset name whose values exactly match the given params, or
// null if no preset matches (e.g., user has tweaked knobs after loading).
// Used by the UI to keep the preset dropdown in sync with the actual state.
export function findActivePreset(current: MasterParams): string | null {
  for (const [name, preset] of Object.entries(MASTER_PRESETS)) {
    let matches = true;
    for (const k of Object.keys(preset) as (keyof MasterParams)[]) {
      if (preset[k] !== current[k]) {
        matches = false;
        break;
      }
    }
    if (matches) return name;
  }
  return null;
}
