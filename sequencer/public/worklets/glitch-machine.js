// Glitch machine worklet — Stage 2. Default behavior: pass-through.
// On a "fire" message from main thread, picks a random MODE and runs it.
// Each mode reads from a shared 1-second ring buffer that's always
// recording the live input. Output during a fire is crossfaded against
// the live signal via the `mix` AudioParam.
//
// MODES (each fire picks one uniformly at random from the MODES table).
// User-facing controls stay at `chance` and `mix`; the variety comes from
// the random pick, not from per-mode knobs.
//
// Adding a mode = add an entry to MODES. process() is mode-agnostic — it
// reads the slice at `firePosF` (float, with linear interp) and advances
// by `fireRate × fireDirection` per output sample.
//
// Stereo: each fire picks a side (L or R) at random. The fire effect mixes
// into ONE channel only; the other passes the dry signal through. Outside
// fires, both channels pass through unchanged.

const STUTTER_REPEATS_MIN = 2;
const STUTTER_REPEATS_MAX = 5;
const RING_SECONDS = 1.0; // how far back we can pull a slice from

const MODES = [
  // 0 STUTTER         — 90ms slice, 2..5× forward repeats  (CD skip)
  { sliceSec: 0.09,  rate: 1,   dir:  1,
    repeats: () =>
      STUTTER_REPEATS_MIN +
      Math.floor(Math.random() * (STUTTER_REPEATS_MAX - STUTTER_REPEATS_MIN + 1)) },
  // 1 REVERSE         — 250ms slice, single backward pass  (tape rewind)
  { sliceSec: 0.25,  rate: 1,   dir: -1, repeats: () => 1 },
  // 2 OCTAVE_UP       — 200ms × 2×  = 100ms output         (pitched squeak)
  { sliceSec: 0.2,   rate: 2,   dir:  1, repeats: () => 1 },
  // 3 OCTAVE_DOWN     — 75ms  × 0.5 = 150ms output         (slow pitched-down)
  { sliceSec: 0.075, rate: 0.5, dir:  1, repeats: () => 1 },
  // 4 OCTAVE_2_UP     — 200ms × 4×  = 50ms output          (very short chirp)
  { sliceSec: 0.2,   rate: 4,   dir:  1, repeats: () => 1 },
  // 5 REVERSE_OCTAVE  — 200ms × 2×  reversed = 100ms       (rewind + pitched)
  { sliceSec: 0.2,   rate: 2,   dir: -1, repeats: () => 1 },
  // 6 SILENCE         — 150ms gap (zero in fire side)      (broken dropout)
  { sliceSec: 0.15,  rate: 1,   dir:  1, repeats: () => 1, silent: true },
  // 7 TAPE_STOP       — rate decays 1×→0 over 350ms        (turntable stop)
  { sliceSec: 0.5,   rate: 1,   dir:  1, repeats: () => 1,
    outputSec: 0.35, rateDecay: 0.9995 },
];
const NUM_MODES = MODES.length;

class GlitchMachine extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      // 0 = pass-through always (no glitch audible). 1 = full stutter
      // replaces the live signal during a fire event.
      { name: 'mix', defaultValue: 0, minValue: 0, maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor() {
    super();
    this.ringLength = Math.floor(sampleRate * RING_SECONDS);
    this.ring = new Float32Array(this.ringLength);
    this.writeHead = 0;

    // Active fire state — one set of fields covers all modes.
    this.fireActive = false;
    this.fireMode = 0;
    this.firePosF = 0;         // float position within the slice
    this.fireRate = 1;         // source samples advanced per output sample (>0)
    this.fireRateDecay = 1;    // multiplier applied to fireRate per sample (tape stop)
    this.fireDirection = 1;    // 1 = forward, -1 = reverse
    this.fireRemaining = 0;    // samples remaining before fire ends
    this.fireSliceLen = 0;     // active slice length in samples
    this.fireStart = 0;        // ring index where the slice begins
    this.fireSide = 0;         // 0 = L, 1 = R — which channel hosts the effect
    this.fireSilent = false;   // if true, fire output is silence (gated drop)
    this.fireGain = 1;         // per-mode level adjustment (audio_rate is 0.6, etc.)

    this.port.onmessage = (e) => {
      if (e.data && e.data.type === 'fire') this.fire();
    };
  }

  fire() {
    // Pick a mode uniformly at random and apply its config.
    const modeIdx = Math.floor(Math.random() * NUM_MODES);
    const cfg = MODES[modeIdx];
    this.fireSliceLen = Math.floor(sampleRate * cfg.sliceSec);
    this.fireRate = cfg.rate;
    this.fireRateDecay = typeof cfg.rateDecay === 'number' ? cfg.rateDecay : 1;
    this.fireDirection = cfg.dir;
    this.fireSilent = cfg.silent === true;
    this.fireGain = typeof cfg.gain === 'number' ? cfg.gain : 1;
    // Forward modes start at slice beginning; reverse modes at the end so
    // they read backward toward 0.
    this.firePosF = cfg.dir === 1 ? 0 : this.fireSliceLen - 1;
    this.fireStart = (this.writeHead - this.fireSliceLen + this.ringLength) % this.ringLength;
    this.fireMode = modeIdx;
    // Total fire duration: explicit `outputSec` if set (tape stop, silence,
    // any future mode that wants a fixed duration), otherwise derived from
    // slice × repeats / rate so existing modes' timing is unchanged.
    const repeats = cfg.repeats();
    this.fireRemaining = cfg.outputSec
      ? Math.floor(sampleRate * cfg.outputSec)
      : Math.max(1, Math.floor((this.fireSliceLen * repeats) / Math.max(0.0001, cfg.rate)));
    // Random L/R per fire — the dry signal stays in the other channel.
    this.fireSide = Math.random() < 0.5 ? 0 : 1;
    this.fireActive = true;
  }

  process(inputs, outputs, params) {
    const inL = inputs[0] && inputs[0][0];
    const inR = (inputs[0] && inputs[0][1]) || inL; // mono → both channels see same
    const outL = outputs[0] && outputs[0][0];
    const outR = outputs[0] && outputs[0][1];
    if (!outL) return true;
    const blockLen = outL.length;

    const mix = params.mix[0];
    const ring = this.ring;
    const ringLen = this.ringLength;

    let wh = this.writeHead;

    for (let i = 0; i < blockLen; i++) {
      const sL = inL ? inL[i] : 0;
      const sR = inR ? inR[i] : sL;

      // Ring captures a mono downmix so the fire content is independent of
      // which side it ends up panned to.
      ring[wh] = (sL + sR) * 0.5;
      wh++;
      if (wh >= ringLen) wh = 0;

      let outLs = sL;
      let outRs = sR;

      if (this.fireActive) {
        let fireSample = 0;
        if (!this.fireSilent) {
          const idxF = (this.fireStart + this.firePosF + ringLen) % ringLen;
          const i0 = Math.floor(idxF);
          const frac = idxF - i0;
          const i1 = (i0 + 1) % ringLen;
          fireSample = (ring[i0] * (1 - frac) + ring[i1] * frac) * this.fireGain;
        }

        // Mix into one channel only; the other passes the dry signal through.
        if (this.fireSide === 0) {
          outLs = (1 - mix) * sL + mix * fireSample;
        } else {
          outRs = (1 - mix) * sR + mix * fireSample;
        }

        this.firePosF += this.fireRate * this.fireDirection;
        // Slice wrap (lets stutter loop back to start; harmless for one-shots).
        if (this.fireDirection === 1 && this.firePosF >= this.fireSliceLen) {
          this.firePosF -= this.fireSliceLen;
        } else if (this.fireDirection === -1 && this.firePosF < 0) {
          this.firePosF += this.fireSliceLen;
        }
        // Rate decay (tape stop); no-op when fireRateDecay === 1.
        if (this.fireRateDecay !== 1) this.fireRate *= this.fireRateDecay;
        // End by sample count — single end check shared across all modes.
        if (--this.fireRemaining <= 0) this.fireActive = false;
      }

      outL[i] = outLs;
      if (outR) outR[i] = outRs;
    }

    this.writeHead = wh;
    return true;
  }
}

registerProcessor('glitch-machine', GlitchMachine);
