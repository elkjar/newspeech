// FX modulation loop — RAF-driven canonical path from store + LFOs to the
// FX worklets. Reads each FX param's BASE value from the store, applies any
// LFO-routed modulation via `modulated()`, and pushes the result into the
// per-FX `setFooParams`. The store setters (`setTape` / `setGlitch` /
// `setReverb`) only update state; the worklets receive their values from
// here.
//
// Latency: one RAF frame (~16ms) between knob set and worklet response.
// Imperceptible for these params, and the cost of having a single canonical
// modulation path for both LFO-routed and non-routed knobs.
import { useSequencerStore } from '../state/store';
import { setTapeParams } from './tape';
import { setGlitchParams } from './glitch';
import { setReverbParams } from './reverb';
import { setSaturationParams } from './saturation';
import { setMasterParams } from './master';
import { applyTrackFilterParams } from './trackFilter';
import { modulated, GLOBAL_TRACK_ID } from './lfo';

let rafId: number | null = null;

export function startFXModulation(): void {
  if (rafId !== null) return;
  const tick = () => {
    const state = useSequencerStore.getState();
    const lfos = state.lfos;
    const tape = state.tape;
    const glitch = state.glitch;
    const reverb = state.reverb;
    const saturation = state.saturation;
    const master = state.master;

    // Tape — push modulated values for every continuous knob; toggles
    // (reverse, hold) and hidden params (stretch1/2, gain1/2) pass through
    // unchanged so user-facing state remains the source of truth for them.
    setTapeParams({
      position: modulated(tape.position, lfos, GLOBAL_TRACK_ID, 'tapePosition'),
      length: modulated(tape.length, lfos, GLOBAL_TRACK_ID, 'tapeLength'),
      mix: modulated(tape.mix, lfos, GLOBAL_TRACK_ID, 'tapeMix'),
      grainRate: modulated(tape.grainRate, lfos, GLOBAL_TRACK_ID, 'tapeGrainRate'),
      grainMix: modulated(tape.grainMix, lfos, GLOBAL_TRACK_ID, 'tapeGrainMix'),
      reverse: tape.reverse,
      hold: tape.hold,
      stretch1: tape.stretch1,
      gain1: tape.gain1,
      stretch2: tape.stretch2,
      gain2: tape.gain2,
    });

    setGlitchParams({
      chance: modulated(glitch.chance, lfos, GLOBAL_TRACK_ID, 'glitchChance'),
      mix: modulated(glitch.mix, lfos, GLOBAL_TRACK_ID, 'glitchMix'),
    });

    setReverbParams({
      size: modulated(reverb.size, lfos, GLOBAL_TRACK_ID, 'reverbSize'),
      mix: modulated(reverb.mix, lfos, GLOBAL_TRACK_ID, 'reverbMix'),
    });

    setSaturationParams({
      preDrive: modulated(saturation.preDrive, lfos, GLOBAL_TRACK_ID, 'preSaturationDrive'),
    });

    setMasterParams({
      input: modulated(master.input, lfos, GLOBAL_TRACK_ID, 'masterInput'),
      comp: modulated(master.comp, lfos, GLOBAL_TRACK_ID, 'masterComp'),
      drive: modulated(master.drive, lfos, GLOBAL_TRACK_ID, 'masterDrive'),
      // Bias modulates in 0..1 normalized space then scales — keeps the LFO
      // depth UI meaningful even though the underlying range is 0..0.2.
      bias:
        modulated(master.bias / 0.2, lfos, GLOBAL_TRACK_ID, 'masterBias') * 0.2,
      mix: modulated(master.mix, lfos, GLOBAL_TRACK_ID, 'masterMix'),
      hiCut: modulated(master.hiCut, lfos, GLOBAL_TRACK_ID, 'masterHiCut'),
      trim: modulated(master.trim, lfos, GLOBAL_TRACK_ID, 'masterTrim'),
      gateThreshold: modulated(
        master.gateThreshold,
        lfos,
        GLOBAL_TRACK_ID,
        'masterGateThreshold',
      ),
      // Discrete / boolean params pass through unchanged — no LFO mod.
      loCut: master.loCut,
      compAttack: master.compAttack,
      compRelease: master.compRelease,
      mode: master.mode,
      gateEnabled: master.gateEnabled,
      bypass: master.bypass,
    });

    // Per-track filter graphs — cutoff + resonance + fxSend wet/dry. All
    // continuous, all LFO-modulatable. The graph is lazy-created on first
    // trigger from each track, so applyTrackFilterParams is a no-op for
    // tracks that haven't triggered yet (graph map miss). Once initialized,
    // continuous params update via setTargetAtTime ramps in trackFilter.ts.
    for (const track of state.tracks) {
      applyTrackFilterParams(track.id, {
        cutoff: modulated(track.filterCutoff, lfos, track.id, 'filterCutoff'),
        resonance: modulated(track.filterResonance, lfos, track.id, 'filterResonance'),
        fxSend: modulated(track.fxSend, lfos, track.id, 'fxSend'),
      });
    }

    rafId = window.requestAnimationFrame(tick);
  };
  rafId = window.requestAnimationFrame(tick);
}

export function stopFXModulation(): void {
  if (rafId !== null) {
    window.cancelAnimationFrame(rafId);
    rafId = null;
  }
}
