import { ensureAudioRunning } from './audioContext';
import { scheduler } from './scheduler';
import { midiPanic } from './midiOut';
import { clockTransportStart, clockTransportStop } from './midiClock';
import { useSequencerStore } from '../state/store';
import { clearOverlay } from './mutationOverlay';

// Tap-tempo: averages the gaps between recent taps. A gap > TAP_RESET_MS
// resets the buffer so a long pause starts a fresh measurement.
const TAP_RESET_MS = 2000;
const TAP_BUFFER = 8;
const tapTimes: number[] = [];

export function tapTempo(): void {
  // Tempo is owned by the external master in follow mode — ignore taps.
  if (useSequencerStore.getState().syncSource === 'external') return;
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
import { isNativeAudioAvailable, fadeTextures } from './nativeEngine';

// Texture voices ring down over this many seconds when transport stops,
// rather than playing their (often minute-long) sample out to the end.
// Everything else is left untouched — it stops issuing new triggers and
// any short tails ring out naturally. Native path only (the web build
// keeps the prior natural-end behavior, same as recording being
// native-only). Tune by ear.
const TEXTURE_STOP_FADE_SECS = 6;

// Shared play-prep: resume audio, boot the web FX chain (web only), and push
// program changes. Used by both the local transport and the external-clock
// follower (clockFollow.ts), so the two start paths can't drift apart.
export async function prepareForPlay(): Promise<void> {
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
  useSequencerStore.getState().fireAllProgramChanges();
}

// Shared stop teardown (no MIDI clock-stop — callers decide whether to announce
// transport to followers). Stop REVERTS to the authored pattern: discard the
// transient mutation variation rather than baking it in. Mutation is a runtime
// overlay (the grid always shows the authored steps), so the knob value is kept
// and a fresh variation regenerates on the next play.
export function stopPlaybackLocal(): void {
  scheduler.stop();
  midiPanic();
  if (isNativeAudioAvailable()) {
    void fadeTextures(TEXTURE_STOP_FADE_SECS);
  }
  useSequencerStore.getState().setPlaying(false);
  clearOverlay();
}

export async function togglePlayback(): Promise<void> {
  const store = useSequencerStore.getState();
  // Follow mode: transport is driven by the external master's Start/Stop, so
  // the local play/stop toggle (and its hardware bindings) is a no-op.
  if (store.syncSource === 'external') return;
  if (store.playing) {
    // Sequence is the clock master: announce stop to followers, then tear down.
    clockTransportStop();
    stopPlaybackLocal();
  } else {
    await prepareForPlay();
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
    // Sequence is the clock master: announce transport to followers. The
    // pulse stream itself flows from the scheduler step subscriber in App.tsx.
    clockTransportStart();
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
