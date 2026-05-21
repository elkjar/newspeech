// Reverb — Faust-compiled Griesinger/Dattorro plate (Clouds-flavoured),
// shared source-of-truth with the GlitchFX VST/AU at vst/glitch/dsp/reverb.dsp.
// Compiled to WASM + a self-contained AudioWorkletProcessor JS by
// `npm run build-faust`. Loaded here like any plain worklet: addModule()
// then `new AudioWorkletNode(ctx, 'reverb', ...)`. No @grame/faustwasm in
// the runtime bundle (it's a build-time-only dep).
//
// Insertion order in the FX chain is unchanged: tape → glitch → reverb →
// mixBus. initReverb() reroutes glitchNode (or fxBus as a fallback) through
// the new node.
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
    const processorUrl = `${base}worklets/faust/reverb-processor.js`;
    const wasmUrl = `${base}worklets/faust/reverb-module.wasm`;
    const metaUrl = `${base}worklets/faust/reverb-meta.json`;

    await ctx.audioWorklet.addModule(processorUrl);

    const [wasmRes, metaRes] = await Promise.all([fetch(wasmUrl), fetch(metaUrl)]);
    const [dspModule, dspMetaJson] = await Promise.all([
      WebAssembly.compileStreaming(wasmRes),
      metaRes.text(),
    ]);

    // Faust's worklet processor reads `factory` out of processorOptions in
    // its constructor and synchronously instantiates the WASM. JSON metadata
    // is passed as a string; soundfiles map is empty for this DSP.
    const factory = { module: dspModule, json: dspMetaJson, soundfiles: {} };
    const meta = JSON.parse(dspMetaJson) as { inputs: number; outputs: number };
    const sampleSize = 4;

    reverbNode = new AudioWorkletNode(ctx, 'reverb', {
      numberOfInputs: meta.inputs > 0 ? 1 : 0,
      numberOfOutputs: meta.outputs > 0 ? 1 : 0,
      channelCount: Math.max(1, meta.inputs),
      outputChannelCount: [meta.outputs],
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { name: 'reverb', factory, sampleSize },
    });

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

// Pull reverbNode out of the chain so the next initReverb() can wire a fresh
// one in without stacking. Without this every HMR cycle would leave the old
// reverbNode connected between its upstream node and mixBus.
export function disposeReverb(): void {
  if (reverbNode) {
    try {
      const upstream: AudioNode = getGlitchNode() || getFxBus();
      upstream.disconnect(reverbNode);
    } catch {
      /* ignore */
    }
    try {
      reverbNode.disconnect();
    } catch {
      /* ignore */
    }
    reverbNode = null;
  }
  initialized = false;
  initializing = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(disposeReverb);
}
