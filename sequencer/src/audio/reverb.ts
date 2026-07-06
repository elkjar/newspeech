// Reverb — Griesinger/Dattorro plate (Clouds-flavoured), shared
// source-of-truth with the GlitchFX VST/AU at vst/glitch/dsp/reverb.dsp.
// Param shape + defaults only; the DSP lives in Rust (audio.rs reverb
// stage), pushed via nativeEngine.setReverbParams.

export interface ReverbParams {
  // 0..1 → tank feedback (krt) 0.30..0.92
  size: number;
  // wet/dry crossfade. mix=0 is the bypass — no separate flag.
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
