import { ensureAudioRunning } from './audioContext';
import { scheduler } from './scheduler';
import { midiPanic } from './midiOut';
import { useSequencerStore } from '../state/store';
import { initTape, setTapeParams } from './tape';
import { initGlitch, setGlitchParams } from './glitch';
import { initReverb, setReverbParams } from './reverb';
import {
  initPreSaturation,
  initPostSaturation,
  setSaturationParams,
} from './saturation';
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
    // inserts between glitch and dest → post-saturation inserts between
    // reverb and dest.
    await initPreSaturation();
    await initTape();
    await initGlitch();
    await initReverb();
    await initPostSaturation();
    const fresh = useSequencerStore.getState();
    setTapeParams(fresh.tape);
    setGlitchParams(fresh.glitch);
    setReverbParams(fresh.reverb);
    setSaturationParams(fresh.saturation);
    // Start the FX modulation loop — from this point on, the worklets
    // receive their values from fxModulation (base + LFO modulation),
    // not from the store setters directly.
    startFXModulation();
    store.fireAllProgramChanges();
    scheduler.start();
    store.setPlaying(true);
  }
}
