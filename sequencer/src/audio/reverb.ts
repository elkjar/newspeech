// Stage 3 reverb unit (v0) — 4-line FDN, stereo decorrelated taps. Sits at
// the end of the FX chain: `glitchNode → reverbNode → destination`.
//
// Init pulls glitchNode's existing connection to destination and inserts
// the reverbNode in between. Order matters: tape → glitch → reverb, each
// re-routing the chain on init.
import { getAudioContext, getMasterBus } from './audioContext';
import { getGlitchNode } from './glitch';

export interface ReverbParams {
  // 0..1 → feedback 0.3..0.95 (small smudge → ambient wash)
  size: number;
  // wet/dry crossfade
  mix: number;
}

export const DEFAULT_REVERB_PARAMS: ReverbParams = {
  size: 0.5,
  mix: 0,
};

const PARAM_RAMP = 0.05;

let initialized = false;
let initializing: Promise<void> | null = null;
let reverbNode: AudioWorkletNode | null = null;
let params: ReverbParams = { ...DEFAULT_REVERB_PARAMS };

export async function initReverb(): Promise<void> {
  if (initialized) return;
  if (initializing) return initializing;

  initializing = (async () => {
    const ctx = getAudioContext();

    const url = `${import.meta.env.BASE_URL}worklets/reverb-machine.js`;
    await ctx.audioWorklet.addModule(url);

    reverbNode = new AudioWorkletNode(ctx, 'reverb-machine', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      // Stereo: L taps lines 0+1, R taps lines 2+3 — uncorrelated tails.
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });

    // Insert reverb at the end of the chain. Init order in togglePlayback
    // is tape → glitch → reverb, so glitchNode is the upstream node to
    // re-route. Falls back to masterBus if glitch hasn't initialized
    // (defensive — shouldn't happen in normal flow).
    const upstream: AudioNode = getGlitchNode() || getMasterBus();
    try {
      upstream.disconnect(ctx.destination);
    } catch {
      /* ignore — possibly never connected */
    }
    upstream.connect(reverbNode);
    reverbNode.connect(ctx.destination);

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
  const sizeP = reverbNode.parameters.get('size');
  const mixP = reverbNode.parameters.get('mix');
  if (sizeP) sizeP.setTargetAtTime(params.size, t, PARAM_RAMP);
  if (mixP) mixP.setTargetAtTime(params.mix, t, PARAM_RAMP);
}

export function getReverbParams(): ReverbParams {
  return params;
}

// Exposed so downstream FX (saturation, future stages) can hook themselves
// into the chain in front of destination by re-routing this node.
export function getReverbNode(): AudioWorkletNode | null {
  return reverbNode;
}
