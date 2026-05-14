// Lazy AnalyserNode tap for the on-screen scope. Tapping `mixBus` gives the
// post-FX, pre-master signal — close enough to "what the listener hears" for
// a scope, and avoids the master compressor flattening the waveform shape.
// AnalyserNode is non-destructive (observation-only), so connecting to mixBus
// doesn't affect the audio path.

import { getAudioContext, getMixBus } from './audioContext';

let analyser: AnalyserNode | null = null;

export function getScopeAnalyser(): AnalyserNode {
  if (!analyser) {
    const ctx = getAudioContext();
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    getMixBus().connect(analyser);
  }
  return analyser;
}
