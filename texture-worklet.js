// texture-worklet.js — AudioWorklet port of the Sequence app's LOOP + NOISE
// units (sequencer/src-tauri/src/audio.rs ~8203-8738, docs/loop-resample.md),
// reworked for a standalone page: the uploaded file IS the loop buffer (no
// capture ring, no bar grid, no sequencer clock), so every clock here is
// free-running. Same signal topology as the app:
//
//   file → LOOP unit (tape layer + grain pool) → NOISE unit → out
//
// The NOISE unit sits after the loop like the app's insert/parallel routing:
// INS replaces the loop's direct out with the filtered signal, PAR adds on
// top, FILE gives the noise chain its own vari-speed head over the same
// uploaded buffer, OFF is the self-sounding Mörser trick (clocked noise
// alone through the filter).

const GRAIN_SLOTS = 8;
// Grain-pitch deviation ladder — OCTAVES ONLY (the app's ladder also has
// fifths at ±7/±19, but fifths-down read as fourths against the root and
// break the harmonic frame on tonal material; this page stays in octaves).
const DEV_INTERVALS = [0, 12, -12, 24, -24];

function wrap(pos, len) {
  let p = pos % len;
  if (p < 0) p += len;
  return p;
}

class TextureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bufL = null;
    this.bufR = null;
    // The unit works within a WINDOW of the uploaded buffer — off/len are
    // the selection (defaults to the whole file); bufLen is the full size.
    this.bufLen = 0;
    this.off = 0;
    this.len = 0;
    this.playing = false;
    this.vizOn = true;
    this.frame = 0;
    this.blockCount = 0;

    // LOOP unit — playhead, xorshift RNG (per-grain deviation rolls),
    // grain pool, OLA stretcher heads for the pitch-locked tape layer.
    // Slots 0..7 are the spawnable pool; 8..15 are a shadow pool for
    // STOLEN grains, which fade out over ~2ms there instead of being cut
    // mid-window (the steal click).
    this.pos = 0;
    this.rng = 0x9e3779b9;
    this.grains = [];
    for (let i = 0; i < GRAIN_SLOTS * 2; i++) {
      this.grains.push({
        active: false, start: 0, phase: 0, dur: 1, rate: 1,
        dying: false, gain: 1,
      });
    }
    this.nextSpawn = 0;
    this.ola = [[0, -1], [0, -1]]; // [position, phase]; phase < 0 = idle
    this.olaNext = 0;
    this.olaCountdown = 0;

    // NOISE unit — own vari-speed head (FILE source), LFSR, clock,
    // per-channel SVF + DC blocker state.
    this.nsPos = 0;
    this.nsRng = 0x51f0beef;
    this.nsSvf = [[0, 0], [0, 0]]; // (lp, bp) per channel
    this.nsDcb = [[0, 0], [0, 0]]; // (x1, y1) per channel
    this.nsBitL = false;
    this.nsBitR = false;
    this.nsPingL = 0;
    this.nsPingR = 0;
    this.nsJit = 0;
    this.nsNextClock = 0;
    this.xingSign = 0;
    this.xingCount = 0;

    // Scope = oscilloscope trace of the pre-level saturator out: a ring of
    // the last ~43ms of mono samples, binned to min/max pairs at post time.
    // (A scrolling envelope band reads as a solid wall once the saturator
    // is pinned — the waveform view keeps its shape at any level.)
    this.scopeRing = new Float32Array(2048);
    this.scopeWrite = 0;
    this.pingLedL = 0;
    this.pingLedR = 0;

    // Defaults mirror the app's (loops.ts / noise.ts state singletons),
    // minus everything sync-related.
    this.p = {
      // loop unit
      speed: 1,
      pitch: 0, // 0 = FOLLOW sentinel
      lock: false,
      tapeLevel: 1,
      grainLevel: 0,
      size: 0.35,
      random: 0,
      grains: 4,
      spawnFrames: sampleRate / 8,
      sizeDev: 0,
      pitchDev: 0,
      rateDev: 0,
      // noise unit
      nsSource: 0, // 0 INS · 1 PAR · 2 FILE · 3 OFF
      nsSpeed: 1,
      drive: 0.25,
      cutoff: 0.6,
      res: 0.4,
      width: 0,
      mode: 0, // 0 LP · 1 BP
      noiseAmt: 0.3,
      cv: 0.2,
      clockFrames: sampleRate / 240,
      clockMode: 0, // 0 timer (free) · 1 signal (zero crossings)
      clockSrc: 0, // 0 self-input · 1 loop out
      clockDiv: 8,
      sens: 0.2,
      nsLevel: 0, // unit silent until raised
    };

    this.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'buffer') {
        this.bufL = m.l;
        this.bufR = m.r;
        this.bufLen = m.l.length;
        this.off = 0;
        this.len = this.bufLen;
        this.resetHeads();
        this.port.postMessage({ type: 'ready' });
      } else if (m.type === 'window') {
        // Work within a selection of the file. Heads wrap into the new
        // window so a live edit never jumps out of bounds.
        const start = Math.max(0, Math.min(this.bufLen - 2, m.start | 0));
        const len = Math.max(2, Math.min(this.bufLen - start, m.len | 0));
        this.off = start;
        this.len = len;
        this.pos = wrap(this.pos, len);
        this.nsPos = wrap(this.nsPos, len);
      } else if (m.type === 'params') {
        Object.assign(this.p, m.p);
      } else if (m.type === 'play') {
        if (m.on && !this.playing) this.resetHeads();
        this.playing = m.on;
      } else if (m.type === 'vizOn') {
        this.vizOn = m.on;
      }
    };
  }

  // Fresh pass: playheads to 0, grains cleared, spawn immediately, clocks
  // and filter state zeroed — a render from frame 0 is deterministic.
  resetHeads() {
    this.frame = 0;
    this.pos = 0;
    for (const g of this.grains) g.active = false;
    this.nextSpawn = 0;
    this.ola[0][1] = -1;
    this.ola[1][1] = -1;
    this.olaCountdown = 0;
    this.nsPos = 0;
    this.nsNextClock = 0;
    this.nsSvf[0][0] = 0; this.nsSvf[0][1] = 0;
    this.nsSvf[1][0] = 0; this.nsSvf[1][1] = 0;
    this.nsDcb[0][0] = 0; this.nsDcb[0][1] = 0;
    this.nsDcb[1][0] = 0; this.nsDcb[1][1] = 0;
    this.nsBitL = false;
    this.nsBitR = false;
    this.nsPingL = 0;
    this.nsPingR = 0;
    this.nsJit = 0;
    this.xingSign = 0;
    this.xingCount = 0;
    this.rng = 0x9e3779b9;
    this.nsRng = 0x51f0beef;
  }

  // xorshift32 → bipolar roll, one per deviated control per grain.
  roll() {
    let r = this.rng;
    r = (r ^ (r << 13)) >>> 0;
    r = (r ^ (r >>> 17)) >>> 0;
    r = (r ^ (r << 5)) >>> 0;
    this.rng = r;
    return (r / 4294967295) * 2 - 1;
  }

  // Hard LFSR bit — ±1 held values are the digital hash.
  bit() {
    let r = this.nsRng;
    r = (r ^ (r << 13)) >>> 0;
    r = (r ^ (r >>> 17)) >>> 0;
    r = (r ^ (r << 5)) >>> 0;
    this.nsRng = r;
    return (r & 1) !== 0;
  }

  // Linear-interpolated fractional read within the selection window —
  // interp artifacts at extreme vari-speed are character (loop_read in
  // audio.rs). `pos` is window-relative; `off` anchors it in the file.
  read(buf, pos) {
    const len = this.len;
    const off = this.off;
    let i0 = pos | 0;
    if (i0 > len - 1) i0 = len - 1;
    const frac = pos - i0;
    const i1 = i0 + 1 >= len ? 0 : i0 + 1;
    const a = buf[off + i0];
    return a + (buf[off + i1] - a) * frac;
  }

  // Edge declick: reads fade to zero over ~2ms at the window boundaries,
  // so a wrap (or a mid-grain read crossing the selection edge) is a brief
  // dip instead of a step discontinuity. Uploaded files rarely wrap clean —
  // the capture-ring app never needed this (captures are bar-aligned).
  edge(pos, lenF, edgeF) {
    const d = Math.min(pos, lenF - pos);
    return d >= edgeF ? 1 : (d > 0 ? d / edgeF : 0);
  }

  // Cutoff → SVF coefficient for the 2x-oversampled loop. Log map 40..12k;
  // the clock-held jitter shifts it in octaves (noise→CV normalling).
  fcoef(jit) {
    const p = this.p;
    const base = 40 * Math.pow(300, p.cutoff);
    const fc = Math.min(
      Math.max(base * Math.pow(2, jit * p.cv * 2), 30),
      Math.min(sampleRate * 0.24, 14000),
    );
    return 2 * Math.sin((Math.PI * fc) / (2 * sampleRate));
  }

  // Asymmetric in-loop nonlinearity — even harmonics, mis-biased CMOS.
  asym(v) {
    return Math.tanh(v + 0.14 * v * v);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const outL = out[0];
    const outR = out[1] || out[0];
    const n = outL.length;
    const p = this.p;

    if (!this.playing) {
      // Output buffers arrive zeroed; drain the scope ring to a flat line.
      for (let i = 0; i < n; i++) {
        this.scopeRing[this.scopeWrite++ & 2047] = 0;
      }
      this.postViz();
      return true;
    }

    const hasLoop = this.bufL !== null && this.len > 1;
    const lenF = this.len;
    const stopped = Math.abs(p.speed) < 0.02;
    // Grain size: exponential 20ms..~1.8s, clamped to the loop and floored
    // so a window always has shape.
    const sizeT = Math.min(1, Math.max(0, p.size));
    const grainDur = hasLoop
      ? Math.max(64, Math.min(lenF, 0.02 * Math.pow(90, sizeT) * sampleRate))
      : 64;
    const gTape = p.tapeLevel;
    const gGrain = p.grainLevel;
    const tapeOn = gTape > 0.001;
    const grainsOn = gGrain > 0.001;
    // ±half-loop at full — wrap makes the start point truly uniform.
    const randomAmt = p.random * 0.5 * lenF;
    const spawnInterval = Math.max(32, p.spawnFrames);
    // Overlap gain compensation — stacked windows otherwise pump the level.
    const concurrent = Math.min(Math.max(grainDur / spawnInterval, 1), p.grains);
    const grainNorm = 1 / Math.sqrt(concurrent);
    // Declick constants: ~2ms edge fade (capped for tiny selections) and
    // the shadow-pool fade rate for stolen grains.
    const edgeF = Math.min(lenF * 0.2, sampleRate * 0.002);
    const dieDecay = Math.exp(-1 / (0.002 * sampleRate));

    const noiseOn = p.nsLevel > 0.001;
    const noiseInserted = p.nsSource === 0 && noiseOn;
    let fCoef = 0, qL = 0, qR = 0, inGain = 1, pingDecay = 0;
    if (noiseOn) {
      fCoef = this.fcoef(this.nsJit);
      // Per-channel damping from res ± width — the stereo instability.
      const damp = (r) => 2 * (1 - Math.min(0.98, Math.max(0, r)));
      qL = damp(p.res + p.width * 0.5);
      qR = damp(p.res - p.width * 0.5);
      inGain = 1 + p.drive * 23;
      // ~4ms ping decay — slow clocks read as discrete dots.
      pingDecay = Math.exp(-1 / (0.004 * sampleRate));
    }
    const clkInterval = Math.max(4, p.clockFrames);

    for (let i = 0; i < n; i++) {
      const abs = this.frame++;

      // ---- LOOP unit: tape layer + grain pool ------------------------
      let loopL = 0;
      let loopR = 0;
      if (hasLoop) {
        this.pos = wrap(this.pos + p.speed, lenF);
        if (tapeOn) {
          if (p.lock) {
            // Pitch-locked OLA: heads spawn every half-window at the
            // playhead, read forward at native pitch; triangular windows
            // at 50% overlap sum to unity. Runs even at stopped speed
            // (frozen slice — deliberate).
            const wFrames = Math.max(256, sampleRate * 0.085);
            const hop = wFrames * 0.5;
            this.olaCountdown -= 1;
            if (this.olaCountdown <= 0) {
              this.olaCountdown = hop;
              this.ola[this.olaNext][0] = this.pos;
              this.ola[this.olaNext][1] = 0;
              this.olaNext = (this.olaNext + 1) % 2;
            }
            let tl = 0;
            let tr = 0;
            for (const h of this.ola) {
              if (h[1] < 0) continue;
              const t = h[1] / wFrames;
              const w = 1 - Math.abs(2 * t - 1);
              const pp = wrap(h[0] + h[1], lenF);
              const ew = w * this.edge(pp, lenF, edgeF);
              tl += this.read(this.bufL, pp) * ew;
              tr += this.read(this.bufR, pp) * ew;
              h[1] += 1;
              if (h[1] >= wFrames) h[1] = -1;
            }
            loopL += tl * gTape;
            loopR += tr * gTape;
          } else if (!stopped) {
            // Tape physics: thru-zero vari-speed, |speed| < 0.02 = stopped
            // tape = silence.
            const eg = gTape * this.edge(this.pos, lenF, edgeF);
            loopL += this.read(this.bufL, this.pos) * eg;
            loopR += this.read(this.bufR, this.pos) * eg;
          }
        }
        if (grainsOn) {
          if (abs >= this.nextSpawn) {
            this.nextSpawn = abs + spawnInterval;
            // Slot within the first `grains`: a free one, else steal the
            // OLDEST (highest phase fraction). A stolen grain moves to the
            // shadow pool and fades out over ~2ms there — a hard cut
            // mid-window clicks (constant crackle at dense settings).
            const count = p.grains;
            let slot = -1;
            for (let s = 0; s < count; s++) {
              if (!this.grains[s].active) { slot = s; break; }
            }
            if (slot < 0) {
              slot = 0;
              for (let s = 1; s < count; s++) {
                if (this.grains[s].phase / this.grains[s].dur >
                    this.grains[slot].phase / this.grains[slot].dur) slot = s;
              }
              for (let s = GRAIN_SLOTS; s < GRAIN_SLOTS * 2; s++) {
                if (this.grains[s].active) continue;
                const src = this.grains[slot];
                const dst = this.grains[s];
                dst.active = true;
                dst.start = src.start;
                dst.phase = src.phase;
                dst.dur = src.dur;
                dst.rate = src.rate;
                dst.dying = true;
                dst.gain = 1;
                break;
              }
            }
            // One bipolar roll per deviated control — every grain is its
            // own event when the deviations are up (ADDAC 112 concept).
            const jitter = randomAmt > 0 ? this.roll() * randomAmt : 0;
            let durG = grainDur;
            if (p.sizeDev > 0) {
              durG = Math.max(64, Math.min(lenF,
                grainDur * Math.pow(4, this.roll() * p.sizeDev)));
            }
            // FOLLOW chains grain pitch to the playhead (tape); a fixed
            // pitch decouples them — timestretch.
            const baseRate = p.pitch !== 0 ? p.pitch : (stopped ? 1 : p.speed);
            let rateG = baseRate;
            if (p.pitchDev > 0) {
              const maxIdx = Math.round(p.pitchDev * (DEV_INTERVALS.length - 1));
              let pick = Math.floor(Math.abs(this.roll()) * (maxIdx + 1));
              if (pick > maxIdx) pick = maxIdx;
              rateG = baseRate * Math.pow(2, DEV_INTERVALS[pick] / 12);
            }
            if (p.rateDev > 0) {
              this.nextSpawn += this.roll() * p.rateDev * 0.9 * spawnInterval;
            }
            const g = this.grains[slot];
            g.active = true;
            g.start = wrap(this.pos + jitter, lenF);
            g.phase = 0;
            g.dur = durG;
            g.rate = rateG;
            g.dying = false;
            g.gain = 1;
          }
          let gl = 0;
          let gr = 0;
          for (const g of this.grains) {
            if (!g.active) continue;
            const t = g.phase / g.dur;
            let w = 4 * t * (1 - t); // parabolic window — no trig
            if (g.dying) {
              w *= g.gain;
              g.gain *= dieDecay;
              if (g.gain < 0.01) g.active = false;
            }
            const pp = wrap(g.start + g.phase * g.rate, lenF);
            const eg = w * this.edge(pp, lenF, edgeF);
            gl += this.read(this.bufL, pp) * eg;
            gr += this.read(this.bufR, pp) * eg;
            g.phase += 1;
            if (g.phase >= g.dur) g.active = false;
          }
          loopL += gl * grainNorm * gGrain;
          loopR += gr * grainNorm * gGrain;
        }
      }

      // ---- NOISE unit (Mörser-shaped) --------------------------------
      let nsL = 0;
      let nsR = 0;
      if (noiseOn) {
        // Source per selector. Read FIRST — the signal clock may need
        // this frame's input.
        let xl = 0;
        let xr = 0;
        if (p.nsSource === 0 || p.nsSource === 1) {
          xl = loopL;
          xr = loopR;
        } else if (p.nsSource === 2 && hasLoop && Math.abs(p.nsSpeed) >= 0.02) {
          this.nsPos = wrap(this.nsPos + p.nsSpeed, lenF);
          const eg = this.edge(this.nsPos, lenF, edgeF);
          xl = this.read(this.bufL, this.nsPos) * eg;
          xr = this.read(this.bufR, this.nsPos) * eg;
        }
        // Clock decision. Timer: absolute next-tick frame. SIGNAL
        // (Spektrum): ticks from the source's zero crossings through a
        // divider — silence stops the clock dead; hysteresis (sens) keeps
        // the noise floor from clocking it.
        let doTick = false;
        if (p.clockMode === 1) {
          const cs = p.clockSrc === 0 ? 0.5 * (xl + xr) : 0.5 * (loopL + loopR);
          const thr = 0.005 + p.sens * 0.12;
          const sign = cs > thr ? 1 : cs < -thr ? -1 : 0;
          if (sign !== 0) {
            if (this.xingSign !== 0 && sign !== this.xingSign) {
              this.xingCount += 1;
              if (this.xingCount >= p.clockDiv) {
                this.xingCount = 0;
                doTick = true;
              }
            }
            this.xingSign = sign;
          }
        } else if (abs >= this.nsNextClock) {
          doTick = true;
          this.nsNextClock = abs + clkInterval;
        }
        if (doTick) {
          const bL = this.bit();
          const bR = this.bit();
          // Pings fire only on TRANSITIONS — irregular flip runs are the
          // morse rhythm. Polarity follows the new bit.
          if (bL !== this.nsBitL) {
            this.nsPingL = bL ? 1 : -1;
            this.nsBitL = bL;
            this.pingLedL = 1;
          }
          if (bR !== this.nsBitR) {
            this.nsPingR = bR ? 1 : -1;
            this.nsBitR = bR;
            this.pingLedR = 1;
          }
          // Cutoff jitter keeps a graded value (bit pairs → 4 steps) so
          // cv reads as stepped CV, not pure square FM.
          this.nsJit = ((this.nsRng >>> 1) & 3) / 1.5 - 1;
          fCoef = this.fcoef(this.nsJit);
        }
        // Edge pings decay between ticks — not held DC.
        xl = (xl + this.nsPingL * p.noiseAmt * 1.4) * inGain;
        xr = (xr + this.nsPingR * p.noiseAmt * 1.4) * inGain;
        this.nsPingL *= pingDecay;
        this.nsPingR *= pingDecay;
        // WASP-grit Chamberlin SVF, 2x-oversampled: DRIVE into the filter
        // is the sound, asymmetric nonlinearity in the loop, resonance
        // squelch (damping rises with bp level). Leaky lp bleeds off the
        // DC the clipper injects.
        let lpL = this.nsSvf[0][0];
        let bpL = this.nsSvf[0][1];
        let lpR = this.nsSvf[1][0];
        let bpR = this.nsSvf[1][1];
        for (let o = 0; o < 2; o++) {
          const sqL = qL * (1 + 0.6 * Math.abs(bpL));
          lpL = (lpL + fCoef * bpL) * 0.9995;
          const hpL = xl - lpL - sqL * bpL;
          bpL = this.asym(bpL + fCoef * hpL);
          const sqR = qR * (1 + 0.6 * Math.abs(bpR));
          lpR = (lpR + fCoef * bpR) * 0.9995;
          const hpR = xr - lpR - sqR * bpR;
          bpR = this.asym(bpR + fCoef * hpR);
        }
        this.nsSvf[0][0] = lpL;
        this.nsSvf[0][1] = bpL;
        this.nsSvf[1][0] = lpR;
        this.nsSvf[1][1] = bpR;
        const rawL = p.mode === 0 ? lpL : bpL;
        const rawR = p.mode === 0 ? lpR : bpR;
        // DC blocker (~10Hz one-pole) ahead of the output stage.
        const dl = this.nsDcb[0];
        const tapL = rawL - dl[0] + 0.995 * dl[1];
        dl[0] = rawL;
        dl[1] = tapL;
        const dr = this.nsDcb[1];
        const tapR = rawR - dr[0] + 0.995 * dr[1];
        dr[0] = rawR;
        dr[1] = tapR;
        // Always-on distortion — no blend knob; output stage compensates
        // for drive so LEVEL stays a fader.
        const comp = 1 / (1 + p.drive * 1.5);
        const satL = Math.tanh(tapL * 2.2 * comp) * 0.9;
        const satR = Math.tanh(tapR * 2.2 * comp) * 0.9;
        nsL = satL * p.nsLevel;
        nsR = satR * p.nsLevel;
        // Scope tap — mono sum of the pre-level saturator output.
        this.scopeRing[this.scopeWrite++ & 2047] = 0.5 * (satL + satR);
      } else {
        this.scopeRing[this.scopeWrite++ & 2047] = 0;
      }

      // Inserted → the noise out REPLACES the loop signal; par/file/off →
      // it ADDS on top of the loop's direct out.
      outL[i] = (noiseInserted ? 0 : loopL) + nsL;
      outR[i] = (noiseInserted ? 0 : loopR) + nsR;
    }

    this.postViz();
    return true;
  }

  postViz() {
    this.blockCount++;
    if (!this.vizOn) return;
    if (this.blockCount % 8 !== 0) return;
    const grains = new Float32Array(GRAIN_SLOTS * 2);
    const lenF = this.len;
    for (let i = 0; i < GRAIN_SLOTS; i++) {
      const g = this.grains[i];
      if (g.active && this.playing && lenF > 1) {
        const t = g.phase / g.dur;
        grains[i * 2] = wrap(g.start + g.phase * g.rate, lenF) / lenF;
        grains[i * 2 + 1] = 4 * t * (1 - t);
      } else {
        grains[i * 2] = -1;
        grains[i * 2 + 1] = 0;
      }
    }
    // Oscilloscope bins: the ring in oldest→newest order, min/max per
    // 4-sample bin so single-frame pings survive the decimation.
    const SCOPE_BINS = 512;
    const scopeOut = new Float32Array(SCOPE_BINS * 2);
    const ring = this.scopeRing;
    const w = this.scopeWrite;
    for (let b = 0; b < SCOPE_BINS; b++) {
      let mn = Infinity;
      let mx = -Infinity;
      for (let j = 0; j < 4; j++) {
        const v = ring[(w + b * 4 + j) & 2047];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      scopeOut[b * 2] = mn;
      scopeOut[b * 2 + 1] = mx;
    }
    this.port.postMessage({
      type: 'viz',
      pos: this.playing && lenF > 1 ? this.pos / lenF : -1,
      grains,
      scope: scopeOut,
      pingL: this.pingLedL,
      pingR: this.pingLedR,
    });
    this.pingLedL = 0;
    this.pingLedR = 0;
  }
}

registerProcessor('texture', TextureProcessor);
