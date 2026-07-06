// Stage 2 glitch unit — clocked stutter. Param shape + defaults only; the
// DSP lives in Rust (audio.rs glitch stage). The beat-synced dice roll lives
// in App.tsx ('app:native-glitch' scheduler subscriber → fireGlitch), params
// push via nativeEngine.setGlitchParams.

export interface GlitchParams {
  // probability per beat (0..1) of triggering a stutter event
  chance: number;
  // wet-during-fire amount (0..1). 0 = inaudible (pass-through), 1 = stutter
  // fully replaces live signal during a fire event. Outside fire events, the
  // engine always passes through regardless of mix.
  mix: number;
}

export const DEFAULT_GLITCH_PARAMS: GlitchParams = {
  chance: 0.14,
  mix: 1,
};
