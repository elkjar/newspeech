// The AudioContext here is the app's master CLOCK, not an audio graph.
// No audio flows through it — every voice plays through the native cpal
// engine — but the scheduler, LFO previews, MIDI-out timing, clock-follow,
// and MIDI-record timestamps all read `AudioContext.currentTime` as the
// shared monotonic timebase. It leaves only when the engine-clock rework
// moves the timebase to the Rust sample counter.
let ctx: AudioContext | null = null;

export function getAudioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
  }
  return ctx;
}

export async function ensureAudioRunning(): Promise<AudioContext> {
  const c = getAudioContext();
  if (c.state === 'suspended') {
    await c.resume();
  }
  return c;
}
