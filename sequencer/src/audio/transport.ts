import { ensureAudioRunning } from './audioContext';
import { scheduler } from './scheduler';
import { midiPanic } from './midiOut';
import { useSequencerStore } from '../state/store';

// Tap-tempo: averages the gaps between recent taps. A gap > TAP_RESET_MS
// resets the buffer so a long pause starts a fresh measurement.
const TAP_RESET_MS = 2000;
const TAP_BUFFER = 8;
const tapTimes: number[] = [];

export function tapTempo(): void {
  const now = performance.now();
  if (tapTimes.length > 0 && now - tapTimes[tapTimes.length - 1] > TAP_RESET_MS) {
    tapTimes.length = 0;
  }
  tapTimes.push(now);
  if (tapTimes.length > TAP_BUFFER) tapTimes.shift();
  if (tapTimes.length < 2) return;
  let sum = 0;
  for (let i = 1; i < tapTimes.length; i++) sum += tapTimes[i] - tapTimes[i - 1];
  const avgMs = sum / (tapTimes.length - 1);
  if (avgMs <= 0) return;
  const bpm = Math.max(40, Math.min(240, Math.round(60000 / avgMs)));
  useSequencerStore.getState().setBpm(bpm);
}
import { scheduleClickIn } from './clickIn';
import { getAudioContext } from './audioContext';
import { isNativeAudioAvailable } from './nativeEngine';

export async function togglePlayback(): Promise<void> {
  const store = useSequencerStore.getState();
  if (store.playing) {
    scheduler.stop();
    midiPanic();
    store.setPlaying(false);
    store.commitMutationOverlay();
  } else {
    await ensureAudioRunning();
    // Native (Tauri) build skips the entire WebAudio FX chain. All
    // sample triggers go through `triggerSample` → cpal in native
    // mode, so voicesBus / mixBus / etc. have nothing flowing in.
    // The web chain (worklet loads + audio graph + RAF push +
    // recorder) lives in `./webChain` behind a dynamic import so
    // Vite chunks it out of the Tauri bundle — Tauri never even
    // parses tape.ts / glitch.ts / reverb.ts / master.ts /
    // trackFilter.ts / fxModulation.ts / recorder.ts. Recording is
    // web-only right now; native record path lands later.
    if (!isNativeAudioAvailable()) {
      const { bootWebChain } = await import('./webChain');
      await bootWebChain();
    }
    store.fireAllProgramChanges();
    // Count-in: one bar of clicks before the first scheduler step. The
    // scheduler's first tick is pushed by `scheduleClickIn`'s returned
    // pattern-start time. Recorder (if armed) starts at `setPlaying(true)`
    // and captures the clicks too — DAW alignment cue lives in the WAV.
    const ctx = getAudioContext();
    const lookahead = 0.05;
    let firstStepTime = ctx.currentTime + lookahead;
    if (store.clickIn) {
      if (isNativeAudioAvailable()) {
        // Native click: fire the bundled synthetic click samples via
        // `triggerSample` with sample-accurate delaySecs. The
        // count-in plays through the cpal output (and into the
        // native recorder's combined WAV); the web `scheduleClickIn`
        // path can't because its oscillators target a WebAudio bus
        // that isn't routed in Tauri.
        firstStepTime = await nativeScheduleClickIn(firstStepTime, store.bpm);
      } else {
        firstStepTime = scheduleClickIn(firstStepTime, store.bpm);
      }
    }
    scheduler.start(firstStepTime);
    store.setPlaying(true);
  }
}

// Native count-in: 4 quarter-note clicks fired through the trigger
// queue. Mirrors `audio/clickIn.ts` timing (beat 1 accented, 2-4 not).
// Click samples (`__click_accent` / `__click_beat`) are registered
// Rust-side when audio_open_device succeeds; if the device isn't open
// yet, the trigger IPC will fail silently and the count-in is just
// silent — caller's `firstStepTime` still advances by one bar so the
// pattern starts in the right place.
async function nativeScheduleClickIn(
  startTime: number,
  bpm: number,
): Promise<number> {
  const { triggerSample } = await import('./nativeEngine');
  const ctx = getAudioContext();
  const beatDur = 60 / bpm;
  const beats = 4;
  for (let i = 0; i < beats; i++) {
    const when = startTime + i * beatDur;
    const delaySecs = Math.max(0, when - ctx.currentTime);
    const path = i === 0 ? '__click_accent' : '__click_beat';
    // section: 3 = CLICK — writes to both rhythm + melody splits so
    // the count-in serves as a DAW alignment marker in either file.
    void triggerSample(path, { gain: 1.0, delaySecs, section: 3 });
  }
  return startTime + beats * beatDur;
}
