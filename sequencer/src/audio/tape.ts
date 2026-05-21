// Stage 1 tape unit — multi-head varispeed tape buffer.
// The `tape-machine` worklet owns the circular buffer + N read heads. Each
// head is varispeed-driven (couples time and pitch like real tape). v3 ships
// with 2 layers: live (1×) and octave down (0.5×). Defaults stack both at
// full gain so turning mix up gives the layered bed immediately.
//
// Signal flow:
//   voicesPostFX ──► dryGain ──► fxBus ──► (rest of chain)
//        │                         ▲
//        └──► tapeMachine ──► tapeHighpass ──► tapeMix (wet)
//
//   voicesPostFX is voicesBus's downstream after pre-saturation; tape taps
//   it (instead of voicesBus) so captured material reflects pre-drive.
//   dryGain.gain = 1 - mix
//   tapeMix.gain = mix
//
// Always-on 300 Hz highpass sits on the tape wet output. Bass voices keep
// their full range on the dry path; the tape bed + grains never compete with
// or muddy the low end. Placed AFTER the worklet so the filter catches both
// directly-recorded bass AND content shifted into the low range by the
// octave-down stretch layer (stretch2 = 0.25 = 0.5× = an octave-down
// companion that would otherwise pull mid content into the bass band).
import {
  getAudioContext,
  getDryGain,
  getFxBus,
  getVoicesPostFX,
} from './audioContext';

export interface TapeParams {
  // 0 = read window near write head (recent material); 1 = window deep in past
  position: number;
  // 0..1 window size as fraction of available history
  length: number;
  reverse: boolean;
  // Freezes the input write so the captured buffer stays static while read
  // heads keep playing — performance gesture, NOT persisted.
  hold: boolean;
  // Layer 1 — primary "live" layer. stretch 0..1 maps logarithmically to
  // 0.25..4 (varispeed, ±2 octaves). 0.5 = 1× (live pitch). gain 0..1.
  stretch1: number;
  gain1: number;
  // Layer 2 — defaults to octave-down companion. Same mapping.
  stretch2: number;
  gain2: number;
  // Grain spawner — short single-shot slices fired at random offsets within
  // the current window, layered on top of the bed. Length is randomized
  // per-spawn (167..400ms) inside the worklet — no UI control.
  grainRate: number; // 0..1 → 0..16 events/sec
  grainMix: number;  // 0..1 knob; mapped internally to 0..GRAIN_MIX_MAX to avoid clipping the bed+grain sum
  // Wet/dry crossfade. 0 = only dry, 1 = only bed.
  mix: number;
}

export const DEFAULT_TAPE_PARAMS: TapeParams = {
  position: 0.3,
  length: 0.7,
  reverse: true,
  hold: false,
  stretch1: 0.5,  // → 1× (live pitch)
  gain1: 0.41,
  stretch2: 0.25, // → 0.5× (octave down)
  gain2: 0.8,
  grainRate: 0.23,
  grainMix: 0.3,
  mix: 0,
};

const TAPE_LENGTH_SECONDS = 8;
const PARAM_RAMP = 0.05;
// grain layer ceiling — worklet sums bed + grain, so unbounded grainMix can clip
const GRAIN_MIX_MAX = 0.65;
// Fixed wet-path highpass. 300 Hz, 12 dB/oct (Butterworth Q ≈ 0.707, flat
// passband). Always on — not user-configurable. Carving low end out of the
// bed is a deliberate identity choice for the tape unit.
const TAPE_HIGHPASS_HZ = 300;
const TAPE_HIGHPASS_Q = 0.707;

let initialized = false;
let initializing: Promise<void> | null = null;
let tapeMachine: AudioWorkletNode | null = null;
let tapeHighpass: BiquadFilterNode | null = null;
let tapeMix: GainNode | null = null;
let dryGainRef: GainNode | null = null;
let params: TapeParams = { ...DEFAULT_TAPE_PARAMS };

// stretch knob value (0..1) → playback rate (0.25..4); 0.5 = 1×
function stretchToRate(s: number): number {
  return Math.pow(2, (s - 0.5) * 4);
}

export function stretchRateLabel(s: number): string {
  return `${stretchToRate(s).toFixed(2)}×`;
}

export async function initTape(): Promise<void> {
  if (initialized) return;
  if (initializing) return initializing;

  initializing = (async () => {
    const ctx = getAudioContext();
    const voices = getVoicesPostFX();
    const fx = getFxBus();
    dryGainRef = getDryGain();

    const url = `${import.meta.env.BASE_URL}worklets/tape-machine.js`;
    await ctx.audioWorklet.addModule(url);

    tapeMachine = new AudioWorkletNode(ctx, 'tape-machine', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      // Stereo output — bed is centered, grains pan to one side per spawn.
      outputChannelCount: [2],
      channelCount: 2,
      channelCountMode: 'explicit',
      processorOptions: {
        bufferLength: Math.floor(ctx.sampleRate * TAPE_LENGTH_SECONDS),
      },
    });

    voices.connect(tapeMachine);

    tapeHighpass = ctx.createBiquadFilter();
    tapeHighpass.type = 'highpass';
    tapeHighpass.frequency.value = TAPE_HIGHPASS_HZ;
    tapeHighpass.Q.value = TAPE_HIGHPASS_Q;

    tapeMix = ctx.createGain();
    tapeMix.gain.value = 0;
    tapeMachine.connect(tapeHighpass);
    tapeHighpass.connect(tapeMix);
    tapeMix.connect(fx);

    initialized = true;
    setTapeParams(params);
  })();

  return initializing;
}

function setParam(name: string, value: number, t: number, ramp: boolean): void {
  if (!tapeMachine) return;
  const p = tapeMachine.parameters.get(name);
  if (!p) return;
  if (ramp) p.setTargetAtTime(value, t, PARAM_RAMP);
  else p.setValueAtTime(value, t);
}

export function setTapeParams(patch: Partial<TapeParams>): void {
  params = { ...params, ...patch };
  const ctx = getAudioContext();
  const t = ctx.currentTime;

  if (tapeMix) {
    tapeMix.gain.setTargetAtTime(params.mix, t, PARAM_RAMP);
  }
  if (dryGainRef) {
    dryGainRef.gain.setTargetAtTime(1 - params.mix, t, PARAM_RAMP);
  }

  setParam('position', params.position, t, true);
  setParam('length', params.length, t, true);
  setParam('reverse', params.reverse ? 1 : 0, t, false);
  setParam('hold', params.hold ? 1 : 0, t, false);
  setParam('stretch1', stretchToRate(params.stretch1), t, true);
  setParam('gain1', params.gain1, t, true);
  setParam('stretch2', stretchToRate(params.stretch2), t, true);
  setParam('gain2', params.gain2, t, true);
  setParam('grainRate', params.grainRate, t, true);
  setParam('grainMix', params.grainMix * GRAIN_MIX_MAX, t, true);
}

export function getTapeParams(): TapeParams {
  return params;
}

// Tear down the tape branch so the next initTape() doesn't stack a second
// parallel wet path. Without this, every HMR cycle adds another
// tapeMachine + highpass + mix gain feeding fxBus.
export function disposeTape(): void {
  if (tapeMachine) {
    try {
      getVoicesPostFX().disconnect(tapeMachine);
    } catch {
      /* ignore */
    }
    try {
      tapeMachine.disconnect();
    } catch {
      /* ignore */
    }
    tapeMachine = null;
  }
  if (tapeHighpass) {
    try {
      tapeHighpass.disconnect();
    } catch {
      /* ignore */
    }
    tapeHighpass = null;
  }
  if (tapeMix) {
    try {
      tapeMix.disconnect();
    } catch {
      /* ignore */
    }
    tapeMix = null;
  }
  dryGainRef = null;
  initialized = false;
  initializing = null;
}

if (import.meta.hot) {
  import.meta.hot.dispose(disposeTape);
}
