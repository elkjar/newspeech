// Combined — full FX chain: tape → glitch → reverb in series.
//
// Each effect is inlined as an `environment` block for namespace isolation
// (otherwise `mix`, `sliceLen`, `fireRate`, etc. would collide across the
// three). The web Faust IDE can't resolve relative paths to other files in
// its sandbox, so component-based composition didn't work — single-file
// inline is the portable option.
//
// To run in the Faust web IDE (faustide.grame.fr): paste this whole file
// into a new project and hit Run. UI shows three named groups (Tape, Glitch,
// Reverb), each containing its effect's sliders.
//
// Signal flow: stereo in → tape → glitch → reverb → stereo out.

declare name "Glitch FX";
declare description "Tape + Glitch + Reverb — full FX chain";
declare author "newspeech";
declare options "[ftz:2]";

import("stdfaust.lib");

// =============================================================================
// TAPE — Multi-head varispeed tape buffer with stereo pan and 8-voice grain pool
// =============================================================================
tape = environment {
  MAX_BUF              = 768000;
  MIN_WINDOW_S         = 0.1;
  SAFETY_S             = 0.25;
  BUF_S                = 8.0;
  XFADE_S              = 0.01;
  GRAIN_POOL_SIZE      = 8;
  GRAIN_LEN_MIN_S      = 0.167;
  GRAIN_LEN_MAX_S      = 0.4;
  GRAIN_FADE_S         = 0.05;
  GRAIN_EVENTS_PER_SEC = 16;

  mix       = hslider("tape mix",  0.53, 0,    1, 0.001);
  position  = hslider("position",  0.3,  0,    1, 0.001);
  length_   = hslider("length",    0.5,  0,    1, 0.001);
  reverse   = hslider("reverse[hidden:1]",   1,    0,    1, 1);
  stretch1  = hslider("stretch1[hidden:1]",  1.0,  0.25, 4, 0.001);
  gain1     = hslider("gain1[hidden:1]",     1.0,  0,    1, 0.001);
  stretch2  = hslider("stretch2[hidden:1]",  0.5,  0.25, 4, 0.001);
  gain2     = hslider("gain2[hidden:1]",     1.0,  0,    1, 0.001);
  grainRate = hslider("grainRate", 0.39, 0,    1, 0.001);
  grainMix  = hslider("grainMix",  0.54, 0,    1, 0.001);
  hold      = checkbox("hold");

  SAFETY_SAMP   = SAFETY_S * ma.SR;
  MIN_WINDOW    = MIN_WINDOW_S * ma.SR;
  MAX_LOOKBACK  = (BUF_S - SAFETY_S - 1) * ma.SR;

  // Raw target bounds — used for first-sample rb injection (existing init
  // pattern: setting rb to a valid in-window value at t=0 prevents the
  // ~33k-sample startup bounce). The smoothed versions below drive the
  // steady-state wrap so knob-step clicks get masked. Mirrors the sequencer
  // worklet's `smoothedWindowMin/Max` approach (tape-machine.js).
  windowSizeRaw = max(MIN_WINDOW, MAX_LOOKBACK * length_);
  windowMinRaw  = SAFETY_SAMP + (MAX_LOOKBACK - windowSizeRaw) * position;
  windowMaxRaw  = windowMinRaw + windowSizeRaw;

  SMOOTH_POLE = ba.tau2pole(0.1);  // 100ms time constant, matches JS feel
  windowMin   = windowMinRaw : si.smooth(SMOOTH_POLE);
  windowMax   = windowMaxRaw : si.smooth(SMOOTH_POLE);
  windowSize  = windowMax - windowMin;
  xfadeSamp   = XFADE_S * ma.SR;

  wrap(x) = ba.if(x > windowMax, x - windowSize,
                  ba.if(x < windowMin, x + windowSize, x));

  // `- hold` mirrors the web's writeHead-paused compensation (see tape.dsp).
  adv(s) = (1 - s) * (1 - reverse) + (1 + s) * reverse - hold;

  firstSample = 1 - 1';
  rbHead(s) = (adv(s) + windowMinRaw * firstSample) : (+ : wrap) ~ _;

  layerSample(in, s) = primary * fadeGain + ghost * (1.0 - fadeGain)
  with {
    rb        = rbHead(s);
    advSig    = adv(s);
    event     = abs(rb - rb') > windowSize * 0.5;
    ghostRb   = (event * (rb' + advSig) + (1.0 - event) * (_ + advSig)) ~ _;
    fadeGain  = (event * 0.0 + (1.0 - event) * min(1.0, _ + 1.0 / xfadeSamp)) ~ _;
    primary   = de.fdelay(MAX_BUF, rb,      in);
    ghost     = de.fdelay(MAX_BUF, ghostRb, in);
  };

  sah(trig, x) = (trig * x + (1.0 - trig) * _) ~ _;

  grainSpawnProb = grainRate * GRAIN_EVENTS_PER_SEC / ma.SR;
  grainTrigger   = (no.noise > (1.0 - 2.0 * grainSpawnProb)) * (grainRate > 0);
  voiceIdx       = (+(grainTrigger) : %(GRAIN_POOL_SIZE)) ~ _;

  grainVoice(i, in) = sample * env * gainL, sample * env * gainR
  with {
    fire = grainTrigger * (voiceIdx == i);
    uni(n)       = (n + 1) * 0.5;
    randOffset   = sah(fire, uni(no.noise));
    randDuration = sah(fire, uni(no.noise'));
    randRateIdx  = sah(fire, uni(no.noise''));
    randSide     = sah(fire, no.noise''' > 0);

    durationSamp = (GRAIN_LEN_MIN_S + randDuration * (GRAIN_LEN_MAX_S - GRAIN_LEN_MIN_S)) * ma.SR;

    rateIdx = int(randRateIdx * 5);
    rate    = ba.if(rateIdx == 0, 0.5,
              ba.if(rateIdx == 1, 0.6667,
              ba.if(rateIdx == 2, 1.0,
              ba.if(rateIdx == 3, 1.5, 2.0))));

    usableWindow = max(1.0, windowSize - durationSamp);
    startRb      = windowMin + randOffset * usableWindow;

    counter = (fire * 0.0 + (1.0 - fire) * min(durationSamp, _ + 1.0)) ~ _;
    active  = counter < durationSamp;

    grainAdv = (1.0 - rate) * (1.0 - reverse) + (1.0 + rate) * reverse - hold;
    rbVoice = startRb + grainAdv * counter;

    fadeSampGrain = min(GRAIN_FADE_S * ma.SR, durationSamp * 0.25);
    attackEnv     = min(1.0, counter / fadeSampGrain);
    releaseEnv    = min(1.0, (durationSamp - counter) / fadeSampGrain);
    env           = active * min(attackEnv, releaseEnv);

    sample = de.fdelay(MAX_BUF, rbVoice, in);

    gainL = 1.0 - randSide;
    gainR = randSide;
  };

  grainPool(in) = par(i, GRAIN_POOL_SIZE, grainVoice(i, in)) : route(16, 2,
    (1,1),  (2,2),  (3,1),  (4,2),
    (5,1),  (6,2),  (7,1),  (8,2),
    (9,1),  (10,2), (11,1), (12,2),
    (13,1), (14,2), (15,1), (16,2)
  );

  PAN1 = -0.5;
  PAN2 =  0.5;
  L1_GAIN = cos((PAN1 + 1) * ma.PI / 4);
  R1_GAIN = sin((PAN1 + 1) * ma.PI / 4);
  L2_GAIN = cos((PAN2 + 1) * ma.PI / 4);
  R2_GAIN = sin((PAN2 + 1) * ma.PI / 4);

  monoMix = (_ + _) * 0.5;

  // Freeze loop — see tape.dsp for the rationale. When hold=1, `in` switches
  // from live to a recirculating delay whose period matches the active read
  // window, so the bed reads cycle the captured snippet indefinitely. `adv`
  // already uses raw `hold` for instant direction flip; `holdSmooth` ramps
  // the signal-switch over ~5ms to avoid click.
  holdSmooth = hold : si.smoo;
  freezeCombine(fb, live) = live * (1.0 - hold) + fb * hold;
  freezeBuffer = (freezeCombine : de.fdelay(MAX_BUF, max(1.0, windowSize - 1.0))) ~ _;

  wetPath(L, R) = bedL + grainL * grainMix,
                  bedR + grainR * grainMix
  with {
    liveIn   = monoMix(L, R);
    in       = liveIn * (1.0 - holdSmooth) + freezeBuffer(liveIn) * holdSmooth;
    l1       = layerSample(in, stretch1) * gain1;
    l2       = layerSample(in, stretch2) * gain2;
    bedLraw  = l1 * L1_GAIN + l2 * L2_GAIN;
    bedRraw  = l1 * R1_GAIN + l2 * R2_GAIN;
    bedL     = bedLraw : fi.highpass(2, 300);
    bedR     = bedRraw : fi.highpass(2, 300);

    grainLR  = grainPool(in);
    grainL   = grainLR : (_, !);
    grainR   = grainLR : (!, _);
  };

  splitStereo(L, R) = L, R, L, R;
  combiner(dryL, dryR, wetL, wetR) = dryL * (1.0 - mix) + wetL * mix,
                                      dryR * (1.0 - mix) + wetR * mix;
  process = splitStereo : (_, _, wetPath) : combiner;
};

// =============================================================================
// GLITCH — 8-mode random glitch buffer with stereo asymmetric output
// =============================================================================
glitch = environment {
  RING_MAX  = 96000;
  NUM_MODES = 8;

  mix    = hslider("glitch mix", 0.63, 0,  1,   0.001);
  chance = hslider("chance",     0.16, 0,  1,   0.001);
  bpm    = hslider("bpm[hidden:1]", 120, 60, 240, 0.1);

  samplesPerBeat = 60.0 / bpm * ma.SR;
  beatPhase      = (+(1.0) : %(samplesPerBeat)) ~ _;
  beatPulse      = beatPhase < beatPhase';

  fireTrigger = beatPulse * (no.noise > (1.0 - 2.0 * chance));

  sah(trig, x) = (trig * x + (1.0 - trig) * _) ~ _;
  uni(n) = (n + 1.0) * 0.5;

  sel8(i, x0, x1, x2, x3, x4, x5, x6, x7) =
    select2(i == 0,
     select2(i == 1,
      select2(i == 2,
       select2(i == 3,
        select2(i == 4,
         select2(i == 5,
          select2(i == 6, x7, x6),
          x5),
         x4),
        x3),
       x2),
      x1),
     x0);

  modeIdx = min(NUM_MODES - 1, int(sah(fireTrigger, uni(no.noise) * NUM_MODES)));

  sliceSec  = sel8(modeIdx, 0.09, 0.25, 0.2, 0.075, 0.2, 0.2, 0.15, 0.5);
  rate0     = sel8(modeIdx, 1.0, 1.0, 2.0, 0.5, 4.0, 2.0, 1.0, 1.0);
  dir       = sel8(modeIdx, 1.0, -1.0, 1.0, 1.0, 1.0, -1.0, 1.0, 1.0);
  silent    = sel8(modeIdx, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0);
  decay     = sel8(modeIdx, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 0.9995);
  outputSec = sel8(modeIdx, -1.0, -1.0, -1.0, -1.0, -1.0, -1.0, 0.15, 0.35);
  repeats   = sel8(modeIdx, 4.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0);

  sliceLen = sliceSec * ma.SR;

  fireDuration = ba.if(outputSec > 0.0,
                       outputSec * ma.SR,
                       sliceLen * repeats / max(0.0001, rate0));

  fireRate = (fireTrigger * rate0 + (1.0 - fireTrigger) * fireActive * (_ * decay)) ~ _;

  fireRemaining = (fireTrigger * fireDuration + (1.0 - fireTrigger) * max(0.0, _ - 1.0)) ~ _;
  fireActive    = fireRemaining > 0.0;

  wrapSlice = _ <: ba.if(dir == 1.0,
                          ba.if(_ >= sliceLen, _ - sliceLen, _),
                          ba.if(_ < 0.0, _ + sliceLen, _));

  firePosF = (fireTrigger * initStart + (1.0 - fireTrigger) * wrappedAdvance) ~ _
  with {
    initStart      = ba.if(dir == 1.0, 0.0, sliceLen - 1.0);
    wrappedAdvance = (_ + fireRate * dir) : wrapSlice;
  };

  side = sah(fireTrigger, ba.if(no.noise > 0.0, 1.0, 0.0));

  process(L, R) = outL, outR
  with {
    in = (L + R) * 0.5;
    fireSample = de.fdelay(RING_MAX, sliceLen - firePosF, in) * (1.0 - silent);
    wetL = (1.0 - mix) * L + mix * fireSample;
    wetR = (1.0 - mix) * R + mix * fireSample;
    outL = ba.if(fireActive * (side == 0.0), wetL, L);
    outR = ba.if(fireActive * (side == 1.0), wetR, R);
  };
};

// =============================================================================
// REVERB — Faust port of Clouds' Griesinger plate reverb (Émilie Gillet, MIT).
// 4 input Schroeder allpasses → cross-coupled tank (2 halves, each = LP + 2
// allpasses + 1 long delay). Alternating allpass coefficients per half break
// modal symmetry; LFO modulation on AP1 and del2 breaks comb periodicity.
// =============================================================================
reverb = environment {
  SR_REF      = 32000.0;
  nsamples(n) = int(n * ma.SR / SR_REF);
  fsamples(n) = n * ma.SR / SR_REF;

  size      = hslider("size",       0.77,  0, 1,    0.001);
  mix       = hslider("reverb mix", 0.37,  0, 1,    0.001);
  diffusion = hslider("diffusion",  0.63,  0, 0.85, 0.001);
  damping   = hslider("damping",    0.4,   0, 1,    0.001);

  krt     = 0.3 + size * 0.62;
  kap     = diffusion;
  klp     = 1.0 - 0.7 * damping;
  // Size-dependent wet attenuation prevents tank-energy buildup at long tails.
  wetGain = 1.5 - size * 1.2;

  dampLP = *(klp) : fi.pole(1.0 - klp);

  lfo2 = os.osc(0.3);

  inDiff = fi.allpass_comb(512,  nsamples(113), kap)
         : fi.allpass_comb(512,  nsamples(162), kap)
         : fi.allpass_comb(1024, nsamples(241), kap)
         : fi.allpass_comb(2048, nsamples(399), kap);

  DAP1A    = 1653;
  DAP1B    = 2038;
  DEL1     = 3411;
  DAP2A    = 1913;
  DAP2B    = 1663;
  DEL2     = 4782;
  DEL2_MOD = 100.0;

  del2Len = fsamples(DEL2 + DEL2_MOD * lfo2);

  tankBody(del1_fb, del2_fb, diff) = h1, h2, wetL, wetR
  with {
    h1 = (diff + krt * del2_fb) : dampLP
         : fi.allpass_comb(8192, nsamples(DAP1A), 0.0 - kap)
         : fi.allpass_comb(8192, nsamples(DAP1B), kap);
    h2 = (diff + krt * del1_fb) : dampLP
         : fi.allpass_comb(8192, nsamples(DAP2A), kap)
         : fi.allpass_comb(8192, nsamples(DAP2B), 0.0 - kap);
    wetL = h1 * wetGain;
    wetR = h2 * wetGain;
  };

  tankFeedback(h1, h2, wetL, wetR) = del1_out, del2_out
  with {
    del1_out = h1 : de.fdelay(16384, nsamples(DEL1));
    del2_out = h2 : de.fdelay(16384, del2Len);
  };

  tank = (tankBody ~ tankFeedback) : !, !, _, _;

  monoMix = (_ + _) * 0.5;
  wetPath = monoMix : inDiff : tank;

  splitStereo(L, R) = L, R, L, R;
  combiner(dryL, dryR, wetL, wetR) = dryL * (1.0 - mix) + wetL * mix,
                                      dryR * (1.0 - mix) + wetR * mix;
  process = splitStereo : (_, _, wetPath) : combiner;
};

// =============================================================================
// OUTPUT — universal post-chain trim. Compensates for cumulative loss of
// transient energy through the tape + glitch + reverb stages.
// =============================================================================
output = environment {
  gain = hslider("gain", 1.24, 0.0, 4.0, 0.001);
  process(L, R) = L * gain, R * gain;
};

// =============================================================================
// CHAIN
// =============================================================================
process = vgroup("Tape",   tape.process)
        : vgroup("Glitch", glitch.process)
        : vgroup("Reverb", reverb.process)
        : vgroup("Output", output.process);
