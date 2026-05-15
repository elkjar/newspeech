// recorder — float32 PCM tap. Whatever audio node is plugged in is captured
// frame-by-frame and posted to the main thread when the `_recording` flag is
// on. The flag is toggled by control messages so the worklet can stay
// patched into the audio graph for the page lifetime — no connect/disconnect
// dance per take.
//
// Render quantum (128 samples) buffer is reused by the host per call, so each
// posted message carries a fresh Float32Array copy. Cost is one allocation
// per channel per quantum (~2.7ms at 48k) which the GC handles without
// audible jitter for take-length workloads.

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._recording = false;
    this.port.onmessage = (e) => {
      const cmd = e.data && e.data.cmd;
      if (cmd === 'start') this._recording = true;
      else if (cmd === 'stop') this._recording = false;
    };
  }

  process(inputs) {
    if (!this._recording) return true;
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const left = input[0];
    // Mono input: duplicate left into right so the WAV stays stereo.
    const right = input[1] || input[0];
    if (!left || left.length === 0) return true;
    this.port.postMessage({
      left: new Float32Array(left),
      right: new Float32Array(right),
    });
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
