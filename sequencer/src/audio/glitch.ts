// Stage 2 glitch unit (v0) — clocked stutter inserted between fxBus and
// mixBus. Beat-synced: each beat we roll `chance` against random; on hit,
// post a "fire" message to the worklet, which captures recent input and
// stutters it for ~quarter-beat.
//
// Signal flow:
//   fxBus ──► glitchNode ──► mixBus
//
// Init pulls fxBus's existing connection to mixBus and inserts the
// glitchNode in between. Stage 3 (reverb) does the same against
// glitchNode → mixBus.
import { getAudioContext, getFxBus, getMixBus } from './audioContext';
import { scheduler } from './scheduler';

export interface GlitchParams {
  // probability per beat (0..1) of triggering a stutter event
  chance: number;
  // wet-during-fire amount (0..1). 0 = inaudible (pass-through), 1 = stutter
  // fully replaces live signal during a fire event. Outside fire events, the
  // worklet always passes through regardless of mix.
  mix: number;
}

export const DEFAULT_GLITCH_PARAMS: GlitchParams = {
  chance: 0.14,
  mix: 1,
};

const PARAM_RAMP = 0.05;

let initialized = false;
let initializing: Promise<void> | null = null;
let glitchNode: AudioWorkletNode | null = null;
let stepUnsub: (() => void) | null = null;
let params: GlitchParams = { ...DEFAULT_GLITCH_PARAMS };

export async function initGlitch(): Promise<void> {
  if (initialized) return;
  if (initializing) return initializing;

  initializing = (async () => {
    const ctx = getAudioContext();
    const fx = getFxBus();
    const mix = getMixBus();

    const url = `${import.meta.env.BASE_URL}worklets/glitch-machine.js`;
    await ctx.audioWorklet.addModule(url);

    glitchNode = new AudioWorkletNode(ctx, 'glitch-machine', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      // Stereo output — fires are panned hard L or R per fire so the dry
      // signal stays in the other channel.
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
    });

    // Insert glitch between fxBus and mixBus. fxBus → mixBus was
    // pre-connected by getFxBus(); we replace that link.
    try {
      fx.disconnect(mix);
    } catch {
      /* may already be disconnected */
    }
    fx.connect(glitchNode);
    glitchNode.connect(mix);

    // Subscribe to beat boundaries via the scheduler. Scheduler runs at
    // 32nds (stepsPerBeat = 8), so every 8th step is a beat.
    stepUnsub = scheduler.onStep((stepIndex, when) => {
      if (stepIndex % 8 !== 0) return;
      if (params.chance <= 0) return;
      if (Math.random() >= params.chance) return;
      const delayMs = Math.max(0, (when - ctx.currentTime) * 1000);
      window.setTimeout(() => {
        glitchNode?.port.postMessage({ type: 'fire' });
      }, delayMs);
    });

    initialized = true;
    setGlitchParams(params);
  })();

  return initializing;
}

export function setGlitchParams(patch: Partial<GlitchParams>): void {
  params = { ...params, ...patch };
  if (!glitchNode) return;
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const mixParam = glitchNode.parameters.get('mix');
  if (mixParam) mixParam.setTargetAtTime(params.mix, t, PARAM_RAMP);
}

export function getGlitchParams(): GlitchParams {
  return params;
}

// Exposed so downstream FX (reverb, future stages) can hook themselves
// into the chain in front of destination by re-routing this node.
export function getGlitchNode(): AudioWorkletNode | null {
  return glitchNode;
}

// Currently unused — kept so a future "shutdown" path can clean up the
// scheduler subscription if we ever need to tear down the FX chain.
export function disposeGlitch(): void {
  if (stepUnsub) {
    stepUnsub();
    stepUnsub = null;
  }
}
