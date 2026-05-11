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
import { startFXModulation } from './fxModulation';

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
    // masterBus → glitch inserts between masterBus and destination → reverb
    // inserts between glitch and dest → master inserts between reverb and
    // dest as the final tone-shaping unit.
    await initPreSaturation();
    await initTape();
    await initGlitch();
    await initReverb();
    await initMaster();
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
    scheduler.start();
    store.setPlaying(true);
  }
}
