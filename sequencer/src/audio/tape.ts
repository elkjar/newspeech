// Stage 1 tape unit — multi-head varispeed tape buffer. Param shape +
// defaults only; the DSP lives in Rust (audio.rs tape stage), pushed via
// nativeEngine.setTapeParams from the App.tsx RAF bridge.

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
  // per-spawn (167..400ms) inside the engine — no UI control.
  grainRate: number; // 0..1 → 0..16 events/sec
  grainMix: number;  // 0..1 knob; mapped internally to avoid clipping the bed+grain sum
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
