import { scheduler } from './scheduler';
import { cancelScheduledMidi, midiPanic } from './midiOut';
import { clockTransportStart, clockTransportStop } from './midiClock';
import { useSequencerStore } from '../state/store';
import { clearOverlay } from './mutationOverlay';

// Dev: transport functions are captured by hardware bindings + key handlers
// registered at mount, so HMR can't hot-swap them mid-session. Force a full
// reload on change, matching engine/tick.ts and voices.ts. No-op in production.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());

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
import { engineNow, frameAtTime } from './engineClock';
import { fadeTextures, audioPanic } from './nativeEngine';
import { setPendingRecordStartFrame } from './nativeRecorder';

// Texture voices ring down over this many seconds when transport stops,
// rather than playing their (often minute-long) sample out to the end.
// Everything else is left untouched — it stops issuing new triggers and
// any short tails ring out naturally. Tune by ear.
const TEXTURE_STOP_FADE_SECS = 6;

// Shared play-prep: push program changes. Used by both the local
// transport and the external-clock follower (clockFollow.ts), so the
// two start paths can't drift apart. (Async for call-site stability —
// historically this also resumed the WebAudio context.)
export async function prepareForPlay(): Promise<void> {
  useSequencerStore.getState().fireAllProgramChanges();
}

// Shared stop teardown (no MIDI clock-stop — callers decide whether to announce
// transport to followers). Stop REVERTS to the authored pattern: discard the
// transient mutation variation rather than baking it in. Mutation is a runtime
// overlay (the grid always shows the authored steps), so the knob value is kept
// and a fresh variation regenerates on the next play.
export function stopPlaybackLocal(): void {
  scheduler.stop();
  // Kill note-on/offs queued behind the 250ms schedule horizon BEFORE the
  // panic's all-notes-off — otherwise they fire after it and leave ghost
  // notes ringing on external hardware. (midiPanic also cancels internally;
  // explicit here so the stop path doesn't depend on that detail.)
  cancelScheduledMidi();
  midiPanic();
  void fadeTextures(TEXTURE_STOP_FADE_SECS);
  useSequencerStore.getState().setPlaying(false);
  clearOverlay();
}

// Panic kill — the "make it stop NOW" hotkey. Stops the transport, hard-kills
// every voice, CLEARS the reverb + delay buffers (so a self-oscillating FX
// tail goes silent — fadeTextures alone won't catch a runaway feedback loop),
// and flushes MIDI. Works whether or not transport is running.
export function panicKill(): void {
  const store = useSequencerStore.getState();
  if (store.playing) {
    scheduler.stop();
    clockTransportStop();
    store.setPlaying(false);
    clearOverlay();
  }
  midiPanic();
  // Hard voice kill + FX-buffer clear. Overrides the graceful texture
  // fade a normal stop would do — this is the emergency path. Rust also
  // drops any held resample loop; mirror it in the JS unit state so the
  // loops tab never shows a ghost loop (dynamic import — transport must
  // not pull the loops module graph in at boot).
  void audioPanic();
  void import('./loops').then((m) => m.loopsOnPanic());
  void import('./noise').then((m) => m.noiseOnPanic());
}

// Song mode reached the end of its rows (loop off): announce stop to clock
// followers and tear down, same as a manual stop. Called deferred (microtask)
// from the engine — never synchronously inside the scheduler tick.
export function endArrangementPlayback(): void {
  if (!useSequencerStore.getState().playing) return;
  clockTransportStop();
  stopPlaybackLocal();
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
    // scheduler's first tick is pushed by `nativeScheduleClickIn`'s
    // returned pattern-start time. The recorder (if armed) is frame-aligned
    // to `firstStepTime` below, so it opens the WAV ON the first musical
    // downbeat — count-in clicks are NOT captured (they play before it).
    // All times are engine-clock seconds.
    //
    // When armed with NO count-in, widen the lead so the recorder command
    // has time to install its producer on the audio thread before that
    // downbeat frame (the WAV is created synchronously in the invoke, so a
    // 50ms lead can be too tight); count-in already provides ample headroom.
    const lookahead = store.armed && !store.clickIn ? 0.2 : 0.05;
    let firstStepTime = engineNow() + lookahead;
    if (store.clickIn) {
      // Fire the bundled synthetic click samples via `triggerSample` with
      // sample-accurate delaySecs. The count-in plays through the cpal
      // output; the recorder starts after it, at the downbeat.
      firstStepTime = await nativeScheduleClickIn(firstStepTime, store.bpm);
    }
    // Song mode: every play starts the arrangement from the top (row 0), so a
    // run is deterministic and repeatable for the show timeline rather than
    // resuming wherever a prior stop left the cursor.
    const arr = store.arrangement;
    // Always clear a prior song's end-gate on play, even when song mode is now
    // disengaged — otherwise a stale pendingEnd silences every trigger.
    store.setArrangementPendingEnd(false);
    if (arr.active && arr.rows.length > 0) {
      store.setArrangementCursor(0, 0);
      store.setArrangementDisplayCursor(0);
      store.engageArrangementTarget(arr.rows[0].scene, arr.rows[0].bank);
      store.applyArrangementRowMutes(0);
    }
    // Stash the aligned capture frame for the recorder (armed takes read it
    // when the `armed && playing` subscription fires start()). Must be set
    // before setPlaying(true) triggers that subscription.
    setPendingRecordStartFrame(frameAtTime(firstStepTime));
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
  const beatDur = 60 / bpm;
  const beats = 4;
  // Route the count-in to the same cue channel as the universal metronome
  // (App.tsx) — mono, follows metronomeOutput when multi-out is ON; the engine
  // folds it to 1-2 when OFF. Without this the count-in defaults to channel 0
  // (1-2) regardless of the metronome cue setting. The section: 3 stem tap is
  // independent of output routing, so DAW alignment markers still land in both
  // split WAVs.
  const out = useSequencerStore.getState().nativeMix.metronomeOutput;
  for (let i = 0; i < beats; i++) {
    const when = startTime + i * beatDur;
    const path = i === 0 ? '__click_accent' : '__click_beat';
    // section: 3 = CLICK — writes to both rhythm + melody splits so
    // the count-in serves as a DAW alignment marker in either file.
    void triggerSample(path, {
      gain: 1.0,
      targetFrame: frameAtTime(when),
      section: 3,
      outFirst: out.firstChannel,
      outStereo: false,
    });
  }
  return startTime + beats * beatDur;
}
