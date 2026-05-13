// Reverb — Faust-compiled Griesinger/Dattorro plate (Clouds-flavoured),
// shared source-of-truth with the GlitchFX VST/AU at vst/glitch/dsp/reverb.dsp.
// Compiled to WASM by `npm run build-faust`; runtime instantiates the
// emitted `reverb-module.wasm` + `reverb-meta.json` via @grame/faustwasm
// (no libfaust at runtime).
//
// Insertion order in the FX chain is unchanged: tape → glitch → reverb →
// mixBus. initReverb() reroutes glitchNode (or fxBus as a fallback) through
// the new node.
import { FaustMonoDspGenerator } from '@grame/faustwasm';
import { getAudioContext, getFxBus, getMixBus } from './audioContext';
import { getGlitchNode } from './glitch';

export interface ReverbParams {
  // 0..1 → tank feedback (krt) 0.30..0.92
  size: number;
  // wet/dry crossfade
  mix: number;
  // 0..0.85 — allpass coefficient across input diffusers + tank APs.
  // Higher = thicker smear, more late-reflection density.
  diffusion: number;
  // 0..1 — HF rolloff in the feedback path. 0 = bright, 1 = dark.
  damping: number;
}

export const DEFAULT_REVERB_PARAMS: ReverbParams = {
  size: 0.5,
  mix: 0.15,
  // 0.735 here = 0.625 inside the .dsp (its native default; range 0..0.85).
  diffusion: 0.735,
  damping: 0.4,
};

const PARAM_RAMP = 0.05;

// Faust emits AudioParams keyed by their full UI path. The .dsp wraps the
// hsliders in `declare name "Reverb"`, so the addresses are /Reverb/<label>.
const PARAM_PATH = {
  size: '/Reverb/size',
  mix: '/Reverb/mix',
  diffusion: '/Reverb/diffusion',
  damping: '/Reverb/damping',
} as const;

let initialized = false;
let initializing: Promise<void> | null = null;
let reverbNode: AudioWorkletNode | null = null;
let params: ReverbParams = { ...DEFAULT_REVERB_PARAMS };

export async function initReverb(): Promise<void> {
  if (initialized) return;
  if (initializing) return initializing;

  initializing = (async () => {
    const ctx = getAudioContext();

    const base = import.meta.env.BASE_URL;
    const [wasmRes, metaRes] = await Promise.all([
      fetch(`${base}worklets/faust/reverb-module.wasm`),
      fetch(`${base}worklets/faust/reverb-meta.json`),
    ]);
    const [dspModule, dspMetaJson] = await Promise.all([
      WebAssembly.compileStreaming(wasmRes),
      metaRes.text(),
    ]);

    const generator = new FaustMonoDspGenerator();
    const node = await generator.createNode(
      ctx,
      'reverb',
      { module: dspModule, json: dspMetaJson, soundfiles: {} },
    );
    if (!node) throw new Error('Failed to create Faust reverb node');
    reverbNode = node as unknown as AudioWorkletNode;

    // Insert reverb between the upstream FX output and mixBus. Init order
    // in togglePlayback is tape → glitch → reverb, so glitchNode is the
    // upstream node to re-route. Falls back to fxBus if glitch hasn't
    // initialized (defensive — shouldn't happen in normal flow).
    const mix = getMixBus();
    const upstream: AudioNode = getGlitchNode() || getFxBus();
    try {
      upstream.disconnect(mix);
    } catch {
      /* ignore — possibly never connected */
    }
    upstream.connect(reverbNode);
    reverbNode.connect(mix);

    initialized = true;
    setReverbParams(params);
  })();

  return initializing;
}

export function setReverbParams(patch: Partial<ReverbParams>): void {
  params = { ...params, ...patch };
  if (!reverbNode) return;
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const ramp = (path: string, value: number) => {
    const p = reverbNode!.parameters.get(path);
    if (p) p.setTargetAtTime(value, t, PARAM_RAMP);
  };
  ramp(PARAM_PATH.size, params.size);
  ramp(PARAM_PATH.mix, params.mix);
  // .dsp diffusion hslider range is [0, 0.85] (Clouds' upper-bound for stable
  // allpass nesting). Sequencer UI knob is unipolar 0..1, so scale on write.
  ramp(PARAM_PATH.diffusion, params.diffusion * 0.85);
  ramp(PARAM_PATH.damping, params.damping);
}

export function getReverbParams(): ReverbParams {
  return params;
}

// Exposed so downstream FX (saturation, future stages) can hook themselves
// into the chain in front of destination by re-routing this node.
export function getReverbNode(): AudioWorkletNode | null {
  return reverbNode;
}
