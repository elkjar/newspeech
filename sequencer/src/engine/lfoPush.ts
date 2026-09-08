// Extracted verbatim from App.tsx (Phase 0 of the broadcast runner,
// docs/broadcast-set.md). No behavior change: each install* function is the
// body of the former useEffect and returns the same cleanup.
import { useSequencerStore } from '../state/store';
import { setLfos, type NativeLfo, type LfoDestKind } from '../audio/nativeEngine';
import { GLOBAL_TRACK_ID } from '../audio/lfo';

// Phase 6 — push LFO panel state to the Rust audio thread on change.
// The audio-thread compute reads its own snapshot of (rate / depth /
// destinations) per block; only the IPC fires here, at user-event
// rate, not RAF rate. JS still owns LFO compute for the destinations
// that aren't audio params (mutation / motion / drift / chaos /
// tension / rowRatchet / glitchChance / etc. — handled inline above
// via the JS `modulated()` helper).
//
// We translate the web LFO type to the native shape: per-track
// destinations carry `trackId`, globals omit it. Knobs that don't
// map to a Rust destination (JS-only sequencer logic) get filtered.
export function installLfoPush(): () => void {
  const KNOB_MAP: Partial<Record<string, LfoDestKind>> = {
    filterCutoff: 'trackFilterCutoff',
    filterResonance: 'trackFilterResonance',
    fxSend: 'trackFxSend',
    reverbSend: 'trackReverbSend',
    delaySend: 'trackDelaySend',
    tune: 'trackTune',
    finetune: 'trackFineTune',
    wtPosition: 'trackWtPosition',
    reverbSize: 'reverbSize',
    reverbMix: 'reverbMix',
    reverbDiffusion: 'reverbDiffusion',
    reverbDamping: 'reverbDamping',
    preSaturationDrive: 'preSaturationDrive',
    glitchMix: 'glitchMix',
    tapePosition: 'tapePosition',
    tapeLength: 'tapeLength',
    tapeMix: 'tapeMix',
    tapeGrainRate: 'tapeGrainRate',
    tapeGrainMix: 'tapeGrainMix',
    masterInput: 'masterInput',
    masterHiCut: 'masterHiCut',
    masterTrim: 'masterTrim',
    masterComp: 'masterComp',
    masterDrive: 'masterDrive',
    masterBias: 'masterBias',
    masterMix: 'masterMix',
    masterGateThreshold: 'masterGateThreshold',
  };
  const push = () => {
    const lfos = useSequencerStore.getState().lfos;
    const payload: NativeLfo[] = lfos.map((lfo) => {
      const destinations: { knob: LfoDestKind; trackId?: string }[] = [];
      for (const d of lfo.destinations) {
        const native = KNOB_MAP[d.knob];
        if (!native) continue;
        // Per-track destinations carry trackId; globals don't.
        // GLOBAL_TRACK_ID is the sentinel for global routings.
        if (
          native === 'trackFilterCutoff' ||
          native === 'trackFilterResonance' ||
          native === 'trackFxSend' ||
          native === 'trackReverbSend' ||
          native === 'trackDelaySend' ||
          native === 'trackTune' ||
          native === 'trackFineTune' ||
          native === 'trackWtPosition'
        ) {
          if (d.trackId === GLOBAL_TRACK_ID) continue;
          destinations.push({ knob: native, trackId: d.trackId });
        } else {
          destinations.push({ knob: native });
        }
      }
      return {
        id: lfo.id,
        rate: lfo.rate,
        depth: lfo.depth,
        destinations,
      };
    });
    void setLfos(payload);
  };
  // Initial push so the audio thread has the current state at boot.
  push();
  // Subscribe to ALL store changes; only re-push when `lfos` ref
  // changes (reducer updates with structural copy → new ref). This
  // catches rate / depth / destination edits without per-frame churn.
  let prevLfos = useSequencerStore.getState().lfos;
  const unsub = useSequencerStore.subscribe((state) => {
    if (state.lfos !== prevLfos) {
      prevLfos = state.lfos;
      push();
    }
  });
  return () => unsub();
}
