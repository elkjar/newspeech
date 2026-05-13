// Reverb — Faust port of Mutable Instruments Clouds' reverb.
//
// Topology: Griesinger / Dattorro plate. 4 input Schroeder allpasses feed a
// cross-coupled tank: two halves, each = LP filter + 2 Schroeder allpasses +
// 1 long delay. The long-delay output of each half feeds the input of the
// other (figure-8). Stereo decorrelated taps are read at the post-AP point
// of each half (one per channel). Alternating allpass coefficients per half
// (-,+ vs +,-) break the symmetry that would otherwise let the tank resonate
// on a single mode — this is the classic Dattorro parity-break.
//
// LFO modulation: AP1's length is swept by LFO_1 (0.5 Hz), del2's length is
// swept by LFO_2 (0.3 Hz). Both break the static-comb periodicity that
// produced the "metallic" tail in the previous FDN topology.
//
// Original C++: clouds/dsp/fx/reverb.h and fx_engine.h by Émilie Gillet
// (Mutable Instruments, 2014). MIT-licensed; see
// https://github.com/pichenettes/eurorack/.

declare name "Reverb";
declare description "Clouds-flavoured Griesinger plate reverb";
declare author "newspeech";

import("stdfaust.lib");

// ===== Sample-rate normalization =====
// Clouds shipped on 32 kHz Eurorack hardware. Scale Clouds' sample-counts to
// runtime SR so the room sounds the same at 44.1/48/96k.
SR_REF      = 32000.0;
nsamples(n) = int(n * ma.SR / SR_REF);
fsamples(n) = n * ma.SR / SR_REF;

// ===== UI =====
// size      → reverb time (tank feedback gain).
// mix       → wet/dry crossfade.
// diffusion → allpass coefficient throughout. Clouds default 0.625.
// damping   → high-frequency roll-off in the tank. 0=bright, 1=dark.
size      = hslider("size",      0.7,   0, 1,    0.001);
mix       = hslider("mix",       0.4,   0, 1,    0.001);
diffusion = hslider("diffusion", 0.625, 0, 0.85, 0.001);
damping   = hslider("damping",   0.4,   0, 1,    0.001);

// ===== Derived =====
krt     = 0.3 + size * 0.62;     // tank feedback 0.30 (short) → 0.92 (huge)
kap     = diffusion;
klp     = 1.0 - 0.7 * damping;   // damping=0 → klp=1 (bypass), damping=1 → klp=0.3

// Size-dependent wet attenuation: long tails accumulate energy in the figure-8
// tank, so cut output as size climbs. Replaces Clouds' fixed ×2 wet gain (which
// was matched to its hardware-set input_gain of ~0.5; we sum L+R via *0.5 so
// effective input is already attenuated, and the wet path needs no boost).
wetGain = 1.5 - size * 1.2;      // 1.5× at size=0 down to 0.3× at size=1

// One-pole LP matching Clouds' formulation:
//   state[n] = (1-klp)*state[n-1] + klp*input[n]
// Faust idiom: *(klp) : fi.pole(1-klp).
dampLP = *(klp) : fi.pole(1.0 - klp);

// ===== LFO =====
// Clouds modulates del2's read position with a 0.3 Hz LFO (and AP1's read
// position with a 0.5 Hz LFO via a side-channel write that's hard to express
// in Faust). We carry the del2 modulation, which is where the audible Clouds
// shimmer comes from; AP1 stays static.
lfo2 = os.osc(0.3);

// ===== Input diffusion (4 Schroeder allpasses in series) =====
inDiff = fi.allpass_comb(512,  nsamples(113), kap)
       : fi.allpass_comb(512,  nsamples(162), kap)
       : fi.allpass_comb(1024, nsamples(241), kap)
       : fi.allpass_comb(2048, nsamples(399), kap);

// ===== Tank =====
// Cross-coupled feedback loop. Per step:
//   h1 = (diff + krt * del2_fb) : dampLP : ap(DAP1A, -kap) : ap(DAP1B, +kap)
//   h2 = (diff + krt * del1_fb) : dampLP : ap(DAP2A, +kap) : ap(DAP2B, -kap)
//   del1Buf writes h1 → next-step del1_fb = h1 delayed by DEL1
//   del2Buf writes h2 → next-step del2_fb = h2 delayed by del2Len (LFO-mod)
//   wetL = h1 * 2.0, wetR = h2 * 2.0
DAP1A    = 1653;
DAP1B    = 2038;
DEL1     = 3411;
DAP2A    = 1913;
DAP2B    = 1663;
DEL2     = 4782;
DEL2_MOD = 100.0;

del2Len = fsamples(DEL2 + DEL2_MOD * lfo2);

// tankBody: 3 ins (del1_fb, del2_fb, diff) → 4 outs (h1, h2, wetL, wetR).
// Signal sharing on h1/h2 (each used twice) is via with-clause local names —
// not function args, so no phantom-input issue.
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

// tankFeedback: 4 ins (h1, h2, wetL, wetR) → 2 outs (del1_out, del2_out).
// Only h1, h2 actually carry feedback; wetL/wetR are dropped here (they exit
// as part of tankBody's outputs).
tankFeedback(h1, h2, wetL, wetR) = del1_out, del2_out
with {
  del1_out = h1 : de.fdelay(16384, nsamples(DEL1));
  del2_out = h2 : de.fdelay(16384, del2Len);
};

// Wire the feedback. tankBody has 3 ins, 4 outs. tankFeedback has 4 ins, 2 outs.
// `~` connects tankFeedback's 2 outs to tankBody's first 2 ins (with 1-sample
// delay). External: 1 in (diff), 4 outs (h1, h2, wetL, wetR). Keep wetL, wetR.
tank = (tankBody ~ tankFeedback) : !, !, _, _;

// ===== Process =====
monoMix = (_ + _) * 0.5;
wetPath = monoMix : inDiff : tank;

splitStereo(L, R) = L, R, L, R;
combiner(dryL, dryR, wetL, wetR) = dryL * (1.0 - mix) + wetL * mix,
                                    dryR * (1.0 - mix) + wetR * mix;
process = splitStereo : (_, _, wetPath) : combiner;
