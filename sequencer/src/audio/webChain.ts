// Web audio FX chain bootstrap. Lives behind a dynamic import from
// `transport.ts` so the Tauri build (where every FX runs natively in
// the cpal callback) never references — and never bundles — the
// worklet-load + audio-graph-wiring code in tape.ts / glitch.ts /
// reverb.ts / saturation.ts / master.ts / trackFilter.ts /
// recorder.ts / fxModulation.ts. Standalone web build still pulls
// this chunk on first play.
//
// If a module exports BOTH runtime audio code AND pure types/data
// (e.g., DEFAULT_X_PARAMS used by persist.ts), Rollup's tree-shaking
// keeps only the imported exports — so persist.ts's `DEFAULT_TAPE_PARAMS`
// import doesn't drag the worklet code in, as long as nothing else
// references `initTape` outside this file.
import { useSequencerStore } from '../state/store';
import { initTape, setTapeParams } from './tape';
import { initGlitch, setGlitchParams } from './glitch';
import { initReverb, setReverbParams } from './reverb';
import { initPreSaturation, setSaturationParams } from './saturation';
import { initMaster, setMasterParams } from './master';
import { initTrackFilter } from './trackFilter';
import { startFXModulation } from './fxModulation';
import { initRecorder, subscribeRecorder } from './recorder';

export async function bootWebChain(): Promise<void> {
  // Order matters: pre-saturation inserts between voicesBus and the
  // post-FX tap so tape captures saturated material → tape connects
  // into fxBus → glitch inserts between fxBus and mixBus → reverb
  // inserts between glitch and mixBus → master inserts between mixBus
  // and dest as the final tone-shaping unit.
  await initPreSaturation();
  await initTape();
  await initGlitch();
  await initReverb();
  await initMaster();
  // Track filters tap voicesBus/mixBus; order vs the linear FX stages
  // doesn't matter, but must run before the first trigger so the
  // first per-track filter graph exists.
  await initTrackFilter();
  // Recorder taps master output — init after master so the tap point
  // exists. Subscribe drives start/stop from (armed && playing) edges.
  await initRecorder();
  subscribeRecorder();
  // Seed the worklets with current store state, then hand over to the
  // RAF loop in fxModulation.
  const fresh = useSequencerStore.getState();
  setTapeParams(fresh.tape);
  setGlitchParams(fresh.glitch);
  setReverbParams(fresh.reverb);
  setSaturationParams(fresh.saturation);
  setMasterParams(fresh.master);
  startFXModulation();
}
