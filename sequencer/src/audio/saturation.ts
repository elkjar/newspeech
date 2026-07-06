// Pre-saturation — soft-clip waveshaper ahead of the FX chain. Param shape
// + defaults only; the DSP lives in Rust (audio.rs pre-saturation stage),
// pushed via nativeEngine.setSaturationParams.

export interface SaturationParams {
  preDrive: number;
}

export const DEFAULT_SATURATION_PARAMS: SaturationParams = {
  preDrive: 0,
};
