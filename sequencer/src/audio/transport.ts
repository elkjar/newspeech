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
import { initTape, setTapeParams } from './tape';
import { initGlitch, setGlitchParams } from './glitch';
import { initReverb, setReverbParams } from './reverb';
import { initPreSaturation, setSaturationParams } from './saturation';
import { initMaster, setMasterParams } from './master';
import { initTrackFilter } from './trackFilter';
import { startFXModulation } from './fxModulation';
import { initRecorder, subscribeRecorder } from './recorder';
import { scheduleClickIn } from './clickIn';
import { getAudioContext } from './audioContext';

export async function togglePlayback(): Promise<void> {
  const store = useSequencerStore.getState();
  if (store.playing) {
    scheduler.stop();
    midiPanic();
    store.setPlaying(false);
    store.commitMutationOverlay();
  } else {
    await ensureAudioRunning();
    // FX init requires audioWorklet.addModule — must run after the context
    // is resumed. Idempotent; subsequent play presses are no-ops.
    // Order matters: pre-saturation inserts between voicesBus and the
    // post-FX tap so tape captures saturated material → tape connects into
    // fxBus → glitch inserts between fxBus and mixBus → reverb inserts
    // between glitch and mixBus → master inserts between mixBus and dest
    // as the final tone-shaping unit.
    await initPreSaturation();
    await initTape();
    await initGlitch();
    await initReverb();
    await initMaster();
    // Track filters load their worklet last — they tap voicesBus/mixBus and
    // don't insert into the global chain, so order relative to the linear
    // FX stages doesn't matter. Must run before scheduler.start() so the
    // first trigger can lazy-create its per-track filter graph.
    await initTrackFilter();
    // Recorder taps master output. Init after master so the tap point
    // exists; subscribe once so the (armed && playing) state edge drives
    // start/stop. Both are idempotent — subsequent play presses are no-ops.
    await initRecorder();
    subscribeRecorder();
    const fresh = useSequencerStore.getState();
    setTapeParams(fresh.tape);
    setGlitchParams(fresh.glitch);
    setReverbParams(fresh.reverb);
    setSaturationParams(fresh.saturation);
    setMasterParams(fresh.master);
    // Start the FX modulation loop — from this point on, the worklets
    // receive their values from fxModulation (base + LFO modulation),
    // not from the store setters directly.
    startFXModulation();
    store.fireAllProgramChanges();
    // Count-in: one bar of clicks before the first scheduler step. The
    // scheduler's first tick is pushed by `scheduleClickIn`'s returned
    // pattern-start time. Recorder (if armed) starts at `setPlaying(true)`
    // and captures the clicks too — DAW alignment cue lives in the WAV.
    const ctx = getAudioContext();
    const lookahead = 0.05;
    let firstStepTime = ctx.currentTime + lookahead;
    if (store.clickIn) {
      firstStepTime = scheduleClickIn(firstStepTime, store.bpm);
    }
    scheduler.start(firstStepTime);
    store.setPlaying(true);
  }
}
