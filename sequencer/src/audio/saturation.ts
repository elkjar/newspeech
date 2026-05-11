// Pre-saturation — soft-clip waveshaper between voicesBus and voicesPostFX:
//
//   voicesBus → preShaper → voicesPostFX → ... → dest
//
// Tanh curve (transparent at drive=0, crushed at 1) with a level-compensating
// post-gain. Pre-drive saturates everything the tape captures plus the dry
// voices — so the captured material reflects pre-drive. The post-chain
// crusher used to live here too; it's been replaced by the master stage
// (see `master.ts`), which is a more capable end-of-chain unit.
import { getAudioContext, getVoicesBus, getVoicesPostFX } from './audioContext';

export interface SaturationParams {
  preDrive: number;
}

export const DEFAULT_SATURATION_PARAMS: SaturationParams = {
  preDrive: 0,
};

const PARAM_RAMP = 0.05;
const CURVE_SAMPLES = 8192;

interface Stage {
  shaper: WaveShaperNode;
  postGain: GainNode;
  drive: number;
}

let pre: Stage | null = null;
let preInitializing: Promise<void> | null = null;
let params: SaturationParams = { ...DEFAULT_SATURATION_PARAMS };

function buildCurve(drive: number): Float32Array<ArrayBuffer> {
  // Construct from an explicit ArrayBuffer so the generic resolves to
  // ArrayBuffer (not ArrayBufferLike) — what WaveShaperNode.curve expects.
  const c = new Float32Array(new ArrayBuffer(CURVE_SAMPLES * 4));
  if (drive < 0.001) {
    for (let i = 0; i < CURVE_SAMPLES; i++) {
      c[i] = (i * 2) / (CURVE_SAMPLES - 1) - 1;
    }
    return c;
  }
  // Quadratic on drive so most of the visible action sits in the top half —
  // 0..0.5 stays warm, 0.5..1 crushes hard.
  const k = 1 + drive * drive * 30;
  const norm = Math.tanh(k);
  for (let i = 0; i < CURVE_SAMPLES; i++) {
    const x = (i * 2) / (CURVE_SAMPLES - 1) - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  return c;
}

function createStage(initialDrive: number): Stage {
  const ctx = getAudioContext();
  const shaper = ctx.createWaveShaper();
  shaper.curve = buildCurve(initialDrive);
  shaper.oversample = '4x';
  const postGain = ctx.createGain();
  postGain.gain.value = 1 / (1 + initialDrive * 0.9);
  shaper.connect(postGain);
  return { shaper, postGain, drive: initialDrive };
}

function applyDrive(stage: Stage, nextDrive: number): void {
  if (Math.abs(nextDrive - stage.drive) > 0.001) {
    stage.shaper.curve = buildCurve(nextDrive);
  }
  stage.drive = nextDrive;
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const post = 1 / (1 + nextDrive * 0.9);
  stage.postGain.gain.setTargetAtTime(post, t, PARAM_RAMP);
}

// Pre saturation — between voicesBus and voicesPostFX. Must init BEFORE
// tape so tape's tap (voicesPostFX) sees saturated material.
export async function initPreSaturation(): Promise<void> {
  if (pre) return;
  if (preInitializing) return preInitializing;
  preInitializing = (async () => {
    const inputBus = getVoicesBus();
    const tap = getVoicesPostFX();
    pre = createStage(params.preDrive);
    try {
      inputBus.disconnect(tap);
    } catch {
      /* ignore — passthrough may not have been wired yet */
    }
    inputBus.connect(pre.shaper);
    pre.postGain.connect(tap);
  })();
  return preInitializing;
}

export function setSaturationParams(patch: Partial<SaturationParams>): void {
  params = { ...params, ...patch };
  if (pre) applyDrive(pre, params.preDrive);
}

export function getSaturationParams(): SaturationParams {
  return params;
}
