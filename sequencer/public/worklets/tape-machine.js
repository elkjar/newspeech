// Tape machine worklet — multi-head varispeed tape buffer with crossfaded
// wrap, plus a grain-spawner that randomly fires short slices of the same
// captured buffer on top of the bed. The shared circular buffer captures
// input continuously. The bed's N read heads each have their own stretch +
// gain. Grains are pooled single-shot reads at random offsets within the
// current window.
//
// Each bed head holds a `ghostRb` companion position. When the head's
// primary `rb` (samples behind write head) crosses the window edge, the
// ghost is snapshotted at the just-passed position and the primary jumps
// to the wrapped position; over the next ~20ms the ghost fades out while
// the primary fades in, producing a smooth boundary instead of a click.

const NUM_LAYERS = 2;
const GRAIN_POOL_SIZE = 8;

// Bed layer pans — each layer leans halfway toward one side. Equal-power
// (cos/sin) so symmetric pan preserves perceived loudness. Layer 1 leans
// left, layer 2 leans right — gives stereo width without hard separation.
const LAYER_PANS = [-0.5, 0.5];
const LAYER_GAIN_L = LAYER_PANS.map((p) => Math.cos((p + 1) * Math.PI / 4));
const LAYER_GAIN_R = LAYER_PANS.map((p) => Math.sin((p + 1) * Math.PI / 4));

// Quantized pitch ratios used when spawning a grain. Each grain picks one
// uniformly at random and uses it as its source-traversal rate, so grains
// land on -1 oct / -5th / unison / +5th / +1 oct instead of all at 1×.
const GRAIN_RATES = [0.5, 0.6667, 1.0, 1.5, 2.0];

// Each grain picks its own length uniformly in this range (seconds). Was a
// `grainSize` AudioParam earlier; randomized per-spawn produces enough
// natural size variation that the knob wasn't earning its place.
const GRAIN_LEN_MIN = 0.167;
const GRAIN_LEN_MAX = 0.4;

function readInterp(buf, wh, rb, bufLen) {
  let readPos = wh - rb;
  while (readPos < 0) readPos += bufLen;
  while (readPos >= bufLen) readPos -= bufLen;
  const i0 = Math.floor(readPos);
  const frac = readPos - i0;
  const i1 = (i0 + 1) % bufLen;
  return buf[i0] * (1 - frac) + buf[i1] * frac;
}

class TapeMachine extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: 'position', defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'k-rate' },
      { name: 'length',   defaultValue: 0.5, minValue: 0,    maxValue: 1, automationRate: 'k-rate' },
      // 0/1 boolean as float; >= 0.5 is reverse
      { name: 'reverse',  defaultValue: 1,   minValue: 0,    maxValue: 1, automationRate: 'k-rate' },
      // 0/1 boolean as float; >= 0.5 freezes input write (captured audio held)
      { name: 'hold',     defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'k-rate' },
      // layer 1 (default: live pitch)
      { name: 'stretch1', defaultValue: 1,   minValue: 0.25, maxValue: 4, automationRate: 'k-rate' },
      { name: 'gain1',    defaultValue: 1,   minValue: 0,    maxValue: 1, automationRate: 'k-rate' },
      // layer 2 (default: octave down)
      { name: 'stretch2', defaultValue: 0.5, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' },
      { name: 'gain2',    defaultValue: 1,   minValue: 0,    maxValue: 1, automationRate: 'k-rate' },
      // grain spawner — short single-shot slices fired at random offsets
      // within the current window, on top of the bed. Each spawn picks its
      // own length, pitch, and offset randomly.
      { name: 'grainRate', defaultValue: 0,   minValue: 0,    maxValue: 1, automationRate: 'k-rate' }, // → 0..16 events/sec
      { name: 'grainMix',  defaultValue: 1,   minValue: 0,    maxValue: 1, automationRate: 'k-rate' },
    ];
  }

  constructor(options) {
    super();
    const opts = options.processorOptions || {};
    this.bufferLength = opts.bufferLength || sampleRate * 8;
    this.buffer = new Float32Array(this.bufferLength);
    this.writeHead = 0;
    this.crossfadeSamples = Math.floor(sampleRate * 0.02); // 20ms

    this.heads = [];
    for (let h = 0; h < NUM_LAYERS; h++) {
      this.heads.push({
        rb: sampleRate * 0.5,
        ghostRb: 0,
        xfadeLeft: 0,
      });
    }

    // Grain pool — preallocated single-shot reads. `active=false` slots are
    // free; spawn finds the first free slot, fills it, sets active=true.
    // Each grain picks a `side` (0=L, 1=R) at spawn so grains scatter across
    // the stereo field on top of the centered bed.
    this.grainPool = [];
    for (let g = 0; g < GRAIN_POOL_SIZE; g++) {
      this.grainPool.push({
        active: false,
        rb: 0,
        remaining: 0,
        total: 0,
        fade: 0,
        rate: 1,
        reverseGrain: false,
        side: 0,
      });
    }

    // Window bounds (samples behind writeHead) are smoothed across blocks so
    // fast scrubbing of position/length doesn't snap the read head every
    // 3ms. The smoothed values trail the targets with a one-pole filter at
    // ~100ms time constant. -1 sentinel = uninitialized (snap to first
    // target on first process() call).
    this.smoothedWindowMin = -1;
    this.smoothedWindowMax = -1;
  }

  process(inputs, outputs, params) {
    // Stereo I/O. Input may arrive mono (1 channel) or stereo; downmixed to
    // mono for the ring buffer either way. Output is always 2 channels —
    // bed is centered (same to L and R), grains pan to one side per spawn.
    const inL = inputs[0] && inputs[0][0];
    const inR = (inputs[0] && inputs[0][1]) || inL;
    const outL = outputs[0] && outputs[0][0];
    const outR = outputs[0] && outputs[0][1];
    if (!outL) return true;

    const bufLen = this.bufferLength;
    const buf = this.buffer;
    const blockLen = outL.length;
    const xfade = this.crossfadeSamples;

    const position = params.position[0];
    const length = params.length[0];
    const reverse = params.reverse[0] >= 0.5;
    const hold = params.hold[0] >= 0.5;
    const stretches = [params.stretch1[0], params.stretch2[0]];
    const gains = [params.gain1[0], params.gain2[0]];
    const grainRate = params.grainRate[0];
    const grainMix = params.grainMix[0];

    const safety = Math.floor(sampleRate * 0.25);
    const maxLookback = bufLen - safety - 1;
    const minWindow = Math.floor(sampleRate * 0.1);
    const targetWindowSize = Math.max(minWindow, Math.floor(maxLookback * length));
    const targetPositionBack = safety + Math.floor((maxLookback - targetWindowSize) * position);
    const targetWindowMin = targetPositionBack;
    const targetWindowMax = targetPositionBack + targetWindowSize;

    // Smooth the window bounds toward target. Without this, fast scrubbing of
    // position/length causes a snap every block which retriggers the
    // ghost-crossfade before it can resolve, producing rough overlapping
    // jumps. With smoothing, the window glides over ~100ms regardless of
    // knob speed and snaps become rare.
    if (this.smoothedWindowMin < 0) {
      this.smoothedWindowMin = targetWindowMin;
      this.smoothedWindowMax = targetWindowMax;
    } else {
      const SMOOTH = 0.04;
      this.smoothedWindowMin += (targetWindowMin - this.smoothedWindowMin) * SMOOTH;
      this.smoothedWindowMax += (targetWindowMax - this.smoothedWindowMax) * SMOOTH;
    }
    const windowMin = this.smoothedWindowMin;
    const windowMax = this.smoothedWindowMax;
    const windowSize = windowMax - windowMin;

    // Crossfade-snap heads that are still out of bounds after smoothing —
    // happens when window changes faster than the smoothing can keep up
    // (rare, e.g. very fast scrub or programmatic param jump).
    for (let h = 0; h < NUM_LAYERS; h++) {
      const head = this.heads[h];
      if (head.rb < windowMin) {
        if (head.xfadeLeft <= 0) {
          head.ghostRb = head.rb;
          head.xfadeLeft = xfade;
        }
        head.rb = windowMin;
      } else if (head.rb > windowMax) {
        if (head.xfadeLeft <= 0) {
          head.ghostRb = head.rb;
          head.xfadeLeft = xfade;
        }
        head.rb = windowMax;
      }
    }

    // Maybe spawn a grain this block. Probability = (events/sec) × (block
    // duration in sec). With max rate 16/sec and 128-sample blocks at 44.1k,
    // max prob ≈ 0.046/block — so grains don't pile up faster than the pool.
    const eventsPerSec = grainRate * 16;
    const probSpawn = eventsPerSec * (blockLen / sampleRate);
    if (probSpawn > 0 && Math.random() < probSpawn && windowSize > 0) {
      const lengthSec = GRAIN_LEN_MIN + Math.random() * (GRAIN_LEN_MAX - GRAIN_LEN_MIN);
      const totalSamples = Math.max(64, Math.floor(lengthSec * sampleRate));
      const usableWindow = Math.max(1, windowSize - totalSamples);
      const offset = Math.random() * usableWindow;
      // 50ms fade in/out, capped at 25% of grain length so short grains
      // don't over-fade.
      const fade = Math.min(Math.floor(sampleRate * 0.05), Math.floor(totalSamples / 4));
      const rate = GRAIN_RATES[Math.floor(Math.random() * GRAIN_RATES.length)];
      const side = Math.random() < 0.5 ? 0 : 1;
      for (let g = 0; g < GRAIN_POOL_SIZE; g++) {
        const slot = this.grainPool[g];
        if (!slot.active) {
          slot.rb = windowMin + offset;
          slot.remaining = totalSamples;
          slot.total = totalSamples;
          slot.fade = fade;
          slot.rate = rate;
          slot.reverseGrain = reverse;
          slot.side = side;
          slot.active = true;
          break;
        }
      }
    }

    let wh = this.writeHead;

    for (let i = 0; i < blockLen; i++) {
      // Write input — skipped while held so the captured buffer stays static
      // and read heads keep reading the same audio while the live pattern
      // changes underneath. Mono downmix (L+R)/2 so the bed's source is
      // independent of which side grains end up on.
      if (!hold) {
        const sL = inL ? inL[i] : 0;
        const sR = inR ? inR[i] : sL;
        buf[wh] = (sL + sR) * 0.5;
        wh++;
        if (wh >= bufLen) wh = 0;
      }

      // Bed accumulators — each layer pans to its precomputed L/R gains.
      let bedL = 0;
      let bedR = 0;

      for (let h = 0; h < NUM_LAYERS; h++) {
        const head = this.heads[h];
        const gain = gains[h];
        const stretch = stretches[h];
        // Advance per output sample. The `±1` term compensates for writeHead
        // moving forward by 1; when held, writeHead is paused so we drop it.
        // Without this, hold doubles the apparent playback rate (octave-up
        // reversed at stretch=1, etc.).
        const advance = hold
          ? reverse ? stretch : -stretch
          : reverse ? 1 + stretch : 1 - stretch;

        // Read primary
        const primary = readInterp(buf, wh, head.rb, bufLen);

        let sample;
        if (head.xfadeLeft > 0) {
          const t = 1 - head.xfadeLeft / xfade; // 0 → 1
          const ghost = readInterp(buf, wh, head.ghostRb, bufLen);
          sample = (1 - t) * ghost + t * primary;
          head.ghostRb += advance;
          head.xfadeLeft--;
        } else {
          sample = primary;
        }

        if (gain > 0.0001) {
          const s = sample * gain;
          bedL += s * LAYER_GAIN_L[h];
          bedR += s * LAYER_GAIN_R[h];
        }

        // Advance primary
        head.rb += advance;

        // Wrap with crossfade trigger (only if not already crossfading)
        if (head.xfadeLeft <= 0) {
          if (head.rb > windowMax) {
            head.ghostRb = head.rb;
            head.rb -= windowSize;
            head.xfadeLeft = xfade;
          } else if (head.rb < windowMin) {
            head.ghostRb = head.rb;
            head.rb += windowSize;
            head.xfadeLeft = xfade;
          }
        }
      }

      // Grain layer — short single-shot reads at random offsets within the
      // current window. Each grain plays once forward through its slice with
      // a 5ms attack/release envelope, then frees its pool slot. `slot.side`
      // (0=L, 1=R, picked at spawn) routes the grain to one channel only.
      let grainL = 0;
      let grainR = 0;
      if (grainMix > 0.0001) {
        for (let g = 0; g < GRAIN_POOL_SIZE; g++) {
          const slot = this.grainPool[g];
          if (!slot.active) continue;

          const sample = readInterp(buf, wh, slot.rb, bufLen);
          const elapsed = slot.total - slot.remaining;
          let env = 1;
          if (elapsed < slot.fade) env = elapsed / slot.fade;
          else if (slot.remaining < slot.fade) env = slot.remaining / slot.fade;
          const out = sample * env;
          if (slot.side === 0) grainL += out;
          else grainR += out;

          // Same writeHead-compensation logic as the bed heads. Each grain's
          // `rate` is picked at spawn from GRAIN_RATES (octave/fifth quantized).
          const advance = hold
            ? slot.reverseGrain ? slot.rate : -slot.rate
            : slot.reverseGrain ? 1 + slot.rate : 1 - slot.rate;
          slot.rb += advance;
          slot.remaining--;
          if (slot.remaining <= 0) slot.active = false;
        }
      }

      outL[i] = bedL + grainL * grainMix;
      if (outR) outR[i] = bedR + grainR * grainMix;
    }

    this.writeHead = wh;
    return true;
  }
}

registerProcessor('tape-machine', TapeMachine);
