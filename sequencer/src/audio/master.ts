// Master stage — final-pass tone-shaping unit at the chain end, modeled on
// the OTO BOUM. Sits between mixBus and destination as the master-of-everything
// (FX-routed signal + per-track dry legs both flow through mixBus into here).
//
// Slice 1: input gain → DC blocker → lo-cut → hi-cut → output trim (native nodes)
// Slice 2: pre-emphasis → distortion worklet → de-emphasis with dry/wet around
//          it, inserted between lo-cut and hi-cut. 4 modes (Boost/Tube/Fuzz/Square).
// Slice 3: compressor worklet between lo-cut and pre-emphasis. One-knob
//          amount mapping, 6×6 attack/release selectors, program-dependent
//          release, negative-ratio mode past amount=0.9.
// Slice 4: noise gate worklet between hi-cut and trim. Threshold up to 0 dB
//          so it doubles as a chopper effect, not just noise suppression.
// Drift LFO, oversampling, stereo mismatch are deferred to Slice 5.

import { getAudioContext, getMixBus, getOutputRouter } from './audioContext';

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
  // 0..1 — maps to a per-mode drive curve inside the worklet
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
// transparent — keeps the filter in-path so toggling doesn't reconnect nodes.
const LO_CUT_FREQS: readonly number[] = [1, 75, 150, 300] as const;
const MODE_NAMES: readonly string[] = ['boost', 'tube', 'fuzz', 'square'] as const;
const COMP_ATTACK_MS: readonly number[] = [0.1, 0.3, 1, 3, 10, 30] as const;
const COMP_RELEASE_MS: readonly number[] = [30, 100, 300, 1000, 3000, 10000] as const;
const PARAM_RAMP = 0.05;
// Always-on tonal EQ at the master tail. Gentle low-mid scoop carves the
// "boxiness" zone around 450 Hz so the bus reads cleaner without sounding
// EQ'd. Wide Q so the dip is felt across the low-mids (~200..1000 Hz) rather
// than as a notch. Not user-configurable — structural identity, same shape
// as `dcBlock`.
const TAIL_EQ_HZ = 450;
const TAIL_EQ_Q = 0.7;
const TAIL_EQ_GAIN_DB = -1;

let initialized = false;
let initializing: Promise<void> | null = null;

let inputNode: GainNode | null = null;       // upstream entry; fans wet + dry
let inputGain: GainNode | null = null;       // wet: input gain stage
let dcBlock: BiquadFilterNode | null = null; // 5 Hz HPF, always on, no UI
let loCut: BiquadFilterNode | null = null;
let compressor: AudioWorkletNode | null = null;
let preEmphasis: BiquadFilterNode | null = null;
let distortion: AudioWorkletNode | null = null;
let deEmphasis: BiquadFilterNode | null = null;
let distDryGain: GainNode | null = null;     // dry side of distortion crossfade
let distWetGain: GainNode | null = null;     // wet side of distortion crossfade
let distSum: GainNode | null = null;         // sum point after dist mix
let hiCut: BiquadFilterNode | null = null;
let gate: AudioWorkletNode | null = null;
let trim: GainNode | null = null;            // output trim
let tailEq: BiquadFilterNode | null = null;  // final-tail tonal EQ (always on, peaking)
let wetMix: GainNode | null = null;          // bypass crossfade — wet side
let dryMix: GainNode | null = null;          // bypass crossfade — dry side
let outNode: GainNode | null = null;

let params: MasterParams = { ...DEFAULT_MASTER_PARAMS };

function inputGainLinear(v: number): number {
  const db = -12 + Math.max(0, Math.min(1, v)) * 30;
  return Math.pow(10, db / 20);
}

function trimGainLinear(v: number): number {
  const db = -24 + Math.max(0, Math.min(1, v)) * 24;
  return Math.pow(10, db / 20);
}

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

// Threshold knob maps to -30..0 dB rather than the full -60..0 the worklet
// allows. Reasoning: master-bus signal post-comp-and-makeup sits in the
// −10..−3 dB range typically. With the full -60..0 mapping, the useful
// zone of the knob was the top 25%; -30..0 spreads the useful zone across
// the whole knob. For deeper noise suppression, the worklet still accepts
// down to −60 if anyone ever wants to widen the range later.
function gateThresholdDb(v: number): number {
  return -30 + Math.max(0, Math.min(1, v)) * 30;
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

// Equal-power crossfade pair for the distortion dry/wet mix. At mix=0.5
// each side sits at ~0.707, summing to ~unity for correlated signals.
function distMixGains(mix: number): { wet: number; dry: number } {
  const m = clamp01(mix);
  return {
    wet: Math.sin((m * Math.PI) / 2),
    dry: Math.cos((m * Math.PI) / 2),
  };
}

export async function initMaster(): Promise<void> {
  if (initialized) return;
  if (initializing) return initializing;

  initializing = (async () => {
    const ctx = getAudioContext();

    const distUrl = `${import.meta.env.BASE_URL}worklets/master-distortion.js`;
    const compUrl = `${import.meta.env.BASE_URL}worklets/master-compressor.js`;
    const gateUrl = `${import.meta.env.BASE_URL}worklets/master-gate.js`;
    await Promise.all([
      ctx.audioWorklet.addModule(distUrl),
      ctx.audioWorklet.addModule(compUrl),
      ctx.audioWorklet.addModule(gateUrl),
    ]);

    inputNode = ctx.createGain();
    inputNode.gain.value = 1;

    inputGain = ctx.createGain();
    inputGain.gain.value = inputGainLinear(params.input);

    dcBlock = ctx.createBiquadFilter();
    dcBlock.type = 'highpass';
    dcBlock.frequency.value = 5;
    dcBlock.Q.value = 0.7;

    loCut = ctx.createBiquadFilter();
    loCut.type = 'highpass';
    loCut.frequency.value = LO_CUT_FREQS[loCutIndex(params.loCut)];
    loCut.Q.value = 0.7;

    compressor = new AudioWorkletNode(ctx, 'master-compressor', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });

    preEmphasis = ctx.createBiquadFilter();
    preEmphasis.type = 'highshelf';
    preEmphasis.frequency.value = 3000;
    preEmphasis.gain.value = 4;

    distortion = new AudioWorkletNode(ctx, 'master-distortion', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });

    deEmphasis = ctx.createBiquadFilter();
    deEmphasis.type = 'highshelf';
    deEmphasis.frequency.value = 3000;
    deEmphasis.gain.value = -4;

    const { wet: wetG, dry: dryG } = distMixGains(params.mix);
    distDryGain = ctx.createGain();
    distDryGain.gain.value = dryG;
    distWetGain = ctx.createGain();
    distWetGain.gain.value = wetG;
    distSum = ctx.createGain();
    distSum.gain.value = 1;

    hiCut = ctx.createBiquadFilter();
    hiCut.type = 'lowpass';
    hiCut.frequency.value = hiCutFreq(params.hiCut);
    hiCut.Q.value = 0.7;

    gate = new AudioWorkletNode(ctx, 'master-gate', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });

    trim = ctx.createGain();
    trim.gain.value = trimGainLinear(params.trim);

    tailEq = ctx.createBiquadFilter();
    tailEq.type = 'peaking';
    tailEq.frequency.value = TAIL_EQ_HZ;
    tailEq.Q.value = TAIL_EQ_Q;
    tailEq.gain.value = TAIL_EQ_GAIN_DB;

    wetMix = ctx.createGain();
    wetMix.gain.value = params.bypass ? 0 : 1;

    dryMix = ctx.createGain();
    dryMix.gain.value = params.bypass ? 1 : 0;

    outNode = ctx.createGain();
    outNode.gain.value = 1;

    // Wet path:
    //   inputNode → inputGain → dcBlock → loCut → compressor → [split]
    //     ├─► preEmphasis → distortion → deEmphasis → distWetGain ─┐
    //     └─► distDryGain ─────────────────────────────────────────┴─► distSum
    //   distSum → hiCut → trim → gate → tailEq → wetMix → outNode
    //
    // Gate is post-trim so its threshold (-30..0 dB) is referenced to the
    // actual output level — matches what the ear hears rather than the
    // pre-trim hot signal.
    //
    // tailEq sits AFTER gate and BEFORE wetMix so full-unit bypass cleanly
    // skips it (the dry tap routes inputNode → dryMix → outNode, around
    // everything). Always-on peaking cut at 450 Hz.
    inputNode.connect(inputGain);
    inputGain.connect(dcBlock);
    dcBlock.connect(loCut);
    loCut.connect(compressor);

    compressor.connect(preEmphasis);
    preEmphasis.connect(distortion);
    distortion.connect(deEmphasis);
    deEmphasis.connect(distWetGain);
    distWetGain.connect(distSum);

    compressor.connect(distDryGain);
    distDryGain.connect(distSum);

    distSum.connect(hiCut);
    hiCut.connect(trim);
    trim.connect(gate);
    gate.connect(tailEq);
    tailEq.connect(wetMix);
    wetMix.connect(outNode);

    // Dry bypass
    inputNode.connect(dryMix);
    dryMix.connect(outNode);

    // Apply initial worklet param values
    const t = ctx.currentTime;
    const modeP = distortion.parameters.get('mode');
    const driveP = distortion.parameters.get('drive');
    const biasP = distortion.parameters.get('bias');
    if (modeP) modeP.setValueAtTime(modeIndex(params.mode), t);
    if (driveP) driveP.setValueAtTime(clamp01(params.drive), t);
    if (biasP) biasP.setValueAtTime(Math.max(0, Math.min(0.2, params.bias)), t);

    const compAmtP = compressor.parameters.get('amount');
    const compAtkP = compressor.parameters.get('attackMs');
    const compRelP = compressor.parameters.get('releaseMs');
    if (compAmtP) compAmtP.setValueAtTime(clamp01(params.comp), t);
    if (compAtkP) {
      compAtkP.setValueAtTime(COMP_ATTACK_MS[compAttackIndex(params.compAttack)], t);
    }
    if (compRelP) {
      compRelP.setValueAtTime(COMP_RELEASE_MS[compReleaseIndex(params.compRelease)], t);
    }

    const gateEnP = gate.parameters.get('enabled');
    const gateThrP = gate.parameters.get('threshold');
    if (gateEnP) gateEnP.setValueAtTime(params.gateEnabled ? 1 : 0, t);
    if (gateThrP) gateThrP.setValueAtTime(gateThresholdDb(params.gateThreshold), t);

    // Splice between mixBus and the output router. Pre-master, mixBus
    // connects directly into the router; master inserts itself in front
    // and re-routes the final hop through outNode.
    const router = getOutputRouter();
    const mix = getMixBus();
    try {
      mix.disconnect(router);
    } catch {
      // ignore — possibly never connected directly to router
    }
    mix.connect(inputNode);
    outNode.connect(router);

    initialized = true;
  })();

  return initializing;
}

export function setMasterParams(patch: Partial<MasterParams>): void {
  params = { ...params, ...patch };
  if (!initialized) return;
  const ctx = getAudioContext();
  const t = ctx.currentTime;

  if (inputGain) {
    inputGain.gain.setTargetAtTime(inputGainLinear(params.input), t, PARAM_RAMP);
  }
  if (loCut) {
    loCut.frequency.setTargetAtTime(
      LO_CUT_FREQS[loCutIndex(params.loCut)],
      t,
      PARAM_RAMP,
    );
  }
  if (distortion) {
    const modeP = distortion.parameters.get('mode');
    const driveP = distortion.parameters.get('drive');
    const biasP = distortion.parameters.get('bias');
    // Mode is k-rate enum — set hard at current time. Brief click on switch
    // is acceptable for an explicit gesture; smooth crossfade comes later
    // if the click bites in practice.
    if (modeP) modeP.setValueAtTime(modeIndex(params.mode), t);
    if (driveP) driveP.setTargetAtTime(clamp01(params.drive), t, PARAM_RAMP);
    if (biasP) {
      biasP.setTargetAtTime(
        Math.max(0, Math.min(0.2, params.bias)),
        t,
        PARAM_RAMP,
      );
    }
  }
  if (compressor) {
    const compAmtP = compressor.parameters.get('amount');
    const compAtkP = compressor.parameters.get('attackMs');
    const compRelP = compressor.parameters.get('releaseMs');
    if (compAmtP) compAmtP.setTargetAtTime(clamp01(params.comp), t, PARAM_RAMP);
    // Attack/release are discrete selectors — set hard. The values jump
    // between fixed time-constants, no need to smooth.
    if (compAtkP) {
      compAtkP.setValueAtTime(
        COMP_ATTACK_MS[compAttackIndex(params.compAttack)],
        t,
      );
    }
    if (compRelP) {
      compRelP.setValueAtTime(
        COMP_RELEASE_MS[compReleaseIndex(params.compRelease)],
        t,
      );
    }
  }
  if (gate) {
    const gateEnP = gate.parameters.get('enabled');
    const gateThrP = gate.parameters.get('threshold');
    if (gateEnP) gateEnP.setValueAtTime(params.gateEnabled ? 1 : 0, t);
    if (gateThrP) {
      gateThrP.setTargetAtTime(gateThresholdDb(params.gateThreshold), t, PARAM_RAMP);
    }
  }
  if (distWetGain && distDryGain) {
    const { wet, dry } = distMixGains(params.mix);
    distWetGain.gain.setTargetAtTime(wet, t, PARAM_RAMP);
    distDryGain.gain.setTargetAtTime(dry, t, PARAM_RAMP);
  }
  if (hiCut) {
    hiCut.frequency.setTargetAtTime(hiCutFreq(params.hiCut), t, PARAM_RAMP);
  }
  if (trim) {
    trim.gain.setTargetAtTime(trimGainLinear(params.trim), t, PARAM_RAMP);
  }
  if (wetMix && dryMix) {
    wetMix.gain.setTargetAtTime(params.bypass ? 0 : 1, t, PARAM_RAMP);
    dryMix.gain.setTargetAtTime(params.bypass ? 1 : 0, t, PARAM_RAMP);
  }
}

export function getMasterParams(): MasterParams {
  return params;
}

// Splice the master chain out of mixBus → outputRouter so the next
// initMaster() can wire a fresh chain in. Without this every HMR reload
// stacks an entire master chain in parallel — both feeding the router.
export function disposeMaster(): void {
  if (inputNode) {
    try {
      getMixBus().disconnect(inputNode);
    } catch {
      /* ignore */
    }
  }
  if (outNode) {
    try {
      outNode.disconnect();
    } catch {
      /* ignore */
    }
  }
  const nodes: (AudioNode | null)[] = [
    inputNode, inputGain, dcBlock, loCut, compressor, preEmphasis, distortion,
    deEmphasis, distDryGain, distWetGain, distSum, hiCut, gate, trim, tailEq,
    wetMix, dryMix,
  ];
  for (const n of nodes) {
    if (!n) continue;
    try {
      n.disconnect();
    } catch {
      /* ignore */
    }
  }
  inputNode = null;
  inputGain = null;
  dcBlock = null;
  loCut = null;
  compressor = null;
  preEmphasis = null;
  distortion = null;
  deEmphasis = null;
  distDryGain = null;
  distWetGain = null;
  distSum = null;
  hiCut = null;
  gate = null;
  trim = null;
  tailEq = null;
  wetMix = null;
  dryMix = null;
  outNode = null;
  initialized = false;
  initializing = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(disposeMaster);
}

// Tap point for downstream consumers (the recorder, future broadcasters).
// Connects `target` to the master's final output node — after every tone-
// shaping stage and the bypass crossfade — so the tap captures exactly what
// reaches `ctx.destination`. No-op if master hasn't initialized yet; caller
// should `await initMaster()` first.
export function tapMasterOutput(target: AudioNode): void {
  if (outNode) outNode.connect(target);
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
