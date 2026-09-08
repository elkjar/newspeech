// Extracted verbatim from App.tsx (Phase 0 of the broadcast runner,
// docs/broadcast-set.md). No behavior change: each install* function is the
// body of the former useEffect and returns the same cleanup.
import { useSequencerStore } from '../state/store';
import {
  performDelaySend,
  performFilterCutoff,
  performReverbSend,
} from '../audio/perform';
import {
  voiceReverbSend,
  voiceDelaySend,
  voiceTune,
  voiceFinetune,
} from '../instruments/voiceEditsStore';
import { delayDivisionToSeconds, FEEDBACK_TO_ENGINE } from '../audio/delay';
import {
  setTrackFiltersBulk,
  setReverbParams,
  setDelayParams,
  setSaturationParams,
  setTapeParams,
  setGlitchParams,
  setMasterFilters,
  setMasterComp,
  setMasterDist,
  setMasterGate,
  setMasterBypass,
  type TrackFilterUpdate,
} from '../audio/nativeEngine';
import { sendMIDIControlChange, resolveDeviceId } from '../audio/midiOut';
import { modulated } from '../audio/lfo';

// Was requestAnimationFrame. A timer keeps pushing when the window is
// occluded (WKWebView throttles rAF hard there) — the broadcast runner's
// window may sit behind OBS. ~60 Hz to match the old cadence.
const PARAM_PUSH_MS = 16;

// Phase 6: push raw BASE values to the native engine every animation
// frame. The LFO compute lives Rust-side now (see audio.rs LfoEngine
// section) — the audio thread reads its own snapshot and overwrites
// each routed destination's `_eff` atomic per block. This loop is
// just the user-knob → Rust bridge for hand-edits / non-LFO moves.
//
// Thresholds prevent floating-point noise from generating no-op
// pushes when nothing's actually moving. Gated on bootDone so the
// loop doesn't start before tracks settle.
export function installParamPush(): () => void {
  const lastTrack = new Map<
    string,
    {
      cutoffNorm: number;
      resonance: number;
      fxSend: number;
      reverbSend: number;
      delaySend: number;
      tuneNorm: number;
      finetuneNorm: number;
    }
  >();
  // Last CC values (0..127 ints) sent out per instrument track, so we only
  // emit on a real change — dedupes the rAF tick to ≤128 messages per full
  // sweep instead of one per frame. See the instrument-CC block in tick.
  const lastInstrumentCC = new Map<
    string,
    { cutoff: number; res: number; gain: number; pan: number }
  >();
  // Standard MIDI controllers most hardware maps out of the box: CC74/71 =
  // filter cutoff / resonance (Sound Controllers), CC7 = channel volume,
  // CC10 = pan. The per-track gain/pan/filter knobs mirror out as these so
  // they drive the external synth (the knobs are otherwise internal-only).
  const CC_FILTER_CUTOFF = 74;
  const CC_FILTER_RESONANCE = 71;
  const CC_VOLUME = 7;
  const CC_PAN = 10;
  let lastReverb: {
    size: number;
    wetGain: number;
    diffusion: number;
    damping: number;
  } | null = null;
  let lastDelay: {
    seconds: number;
    feedback: number;
    pingpong: number;
    lofi: number;
  } | null = null;
  let lastSaturation: { preDrive: number } | null = null;
  let lastTape: {
    position: number;
    length: number;
    stretch1: number;
    gain1: number;
    stretch2: number;
    gain2: number;
    mix: number;
    reverse: boolean;
    hold: boolean;
    grainRate: number;
    grainMix: number;
  } | null = null;
  let lastGlitchMix: number | null = null;
  let lastMaster: {
    input: number;
    loCut: number;
    hiCut: number;
    trim: number;
  } | null = null;
  let lastMasterComp: {
    amount: number;
    attackIdx: number;
    releaseIdx: number;
  } | null = null;
  let lastMasterDist: {
    mode: number;
    drive: number;
    bias: number;
    mix: number;
  } | null = null;
  let lastMasterGate: {
    enabled: boolean;
    threshold: number;
  } | null = null;
  let lastMasterBypass: boolean | null = null;
  const tick = () => {
    const state = useSequencerStore.getState();

    // Per-track DSP bases (filter + fx send). Phase 6: cutoff travels
    // as normalized 0..1 so the Rust LFO compute matches the web
    // modulator's space. Resonance + fxSend already are.
    const updates: TrackFilterUpdate[] = [];
    for (const t of state.tracks) {
      // Perform filter punch (P2) — an engaged filter slot replaces masked
      // tracks' cutoff outright (absolute punch, hardware-style). Riding
      // this continuous path means it bends already-ringing voices and
      // restores the knob value the moment the slot releases.
      const cutoffNorm = performFilterCutoff(t.id) ?? t.filterCutoff;
      const resonance = t.filterResonance;
      const fxSend = t.fxSend;
      // Reverb send is a per-instrument (voice) param, not a track knob —
      // source it from the track's current voice. Non-voice rows (external
      // MIDI instruments) have no native voice, so 0. Perform send punches
      // (P2) override outright, same absolute semantics as the filter
      // punch — throws ringing voices into the bus, restores on release.
      const reverbSend =
        performReverbSend(t.id) ??
        (t.source.kind === 'voice' ? voiceReverbSend(t.source.id) : 0);
      const delaySend =
        performDelaySend(t.id) ??
        (t.source.kind === 'voice' ? voiceDelaySend(t.source.id) : 0);
      // Static tune (−24..24 st) / finetune (−100..100 ct) normalized to
      // 0..1 — the LFO swing center for the trackTune / trackFineTune dests.
      // The static value itself is baked into the trigger pitch; Rust only
      // uses these to center the LFO swing.
      const tuneNorm =
        t.source.kind === 'voice' ? (voiceTune(t.source.id) + 24) / 48 : 0.5;
      const finetuneNorm =
        t.source.kind === 'voice' ? (voiceFinetune(t.source.id) + 100) / 200 : 0.5;
      const last = lastTrack.get(t.id);
      const changed =
        !last ||
        Math.abs(last.cutoffNorm - cutoffNorm) > 0.0005 ||
        Math.abs(last.resonance - resonance) > 0.001 ||
        Math.abs(last.fxSend - fxSend) > 0.001 ||
        Math.abs((last.reverbSend ?? 0) - reverbSend) > 0.001 ||
        Math.abs((last.delaySend ?? 0) - delaySend) > 0.001 ||
        Math.abs((last.tuneNorm ?? 0.5) - tuneNorm) > 0.0005 ||
        Math.abs((last.finetuneNorm ?? 0.5) - finetuneNorm) > 0.0005;
      if (changed) {
        updates.push({ trackId: t.id, cutoffNorm, resonance, fxSend, reverbSend, delaySend, tuneNorm, finetuneNorm });
        lastTrack.set(t.id, { cutoffNorm, resonance, fxSend, reverbSend, delaySend, tuneNorm, finetuneNorm });
      }

      // Instrument (external-MIDI) rows: mirror the filter / gain / pan knobs
      // out as CC so they drive the hardware synth (these knobs are otherwise
      // internal-voice-only). We send the LFO-MODULATED value (modulated() ===
      // base when no LFO is routed), so this single path covers manual knob
      // moves, MIDI-mapped (Launch Control XL3), macros, AND automated LFO
      // sweeps. modulated() also honours the hand-override ramp, so a manual
      // grab wins then eases back. Emit only when the 0..127 int changes —
      // caps a sweep at ≤128 messages, not one per frame.
      if (t.source.kind === 'instrument') {
        const deviceId = resolveDeviceId(t.midi.portName, state.midiOutDeviceId);
        if (deviceId) {
          const ch = t.midi.channel;
          const cutoff = Math.round(
            modulated(cutoffNorm, state.lfos, t.id, 'filterCutoff') * 127
          );
          const res = Math.round(
            modulated(resonance, state.lfos, t.id, 'filterResonance') * 127
          );
          const gain = Math.round(modulated(t.gain, state.lfos, t.id, 'gain') * 127);
          // Pan is 0..1 store space (0.5 center) → CC10 0..127 (64 center).
          const pan = Math.round(modulated(t.pan, state.lfos, t.id, 'pan') * 127);
          const lastCC = lastInstrumentCC.get(t.id);
          if (!lastCC || lastCC.cutoff !== cutoff) {
            sendMIDIControlChange(deviceId, ch, CC_FILTER_CUTOFF, cutoff);
          }
          if (!lastCC || lastCC.res !== res) {
            sendMIDIControlChange(deviceId, ch, CC_FILTER_RESONANCE, res);
          }
          if (!lastCC || lastCC.gain !== gain) {
            sendMIDIControlChange(deviceId, ch, CC_VOLUME, gain);
          }
          if (!lastCC || lastCC.pan !== pan) {
            sendMIDIControlChange(deviceId, ch, CC_PAN, pan);
          }
          lastInstrumentCC.set(t.id, { cutoff, res, gain, pan });
        }
      }
    }
    if (updates.length > 0) void setTrackFiltersBulk(updates);

    // Global reverb base. Store's `mix` is reinterpreted as the
    // post-reverb wet bus gain on the native side (DSP's internal
    // crossfade pinned to fully-wet; per-voice fxSend carries the
    // dry/wet split per track).
    const rv = state.reverb;
    const size = rv.size;
    const wetGain = rv.mix;
    const diffusion = rv.diffusion;
    const damping = rv.damping;
    const reverbChanged =
      !lastReverb ||
      Math.abs(lastReverb.size - size) > 0.001 ||
      Math.abs(lastReverb.wetGain - wetGain) > 0.001 ||
      Math.abs(lastReverb.diffusion - diffusion) > 0.001 ||
      Math.abs(lastReverb.damping - damping) > 0.001;
    if (reverbChanged) {
      lastReverb = { size, wetGain, diffusion, damping };
      void setReverbParams({ size, wetGain, diffusion, damping });
    }

    // Global delay base. Time is tempo-synced: division + current bpm →
    // seconds (so a bpm change re-pushes the time too). Feedback maps store
    // 0..1 → engine 0..1.1 so the top runs past unity.
    const dl = state.delay;
    const delaySeconds = delayDivisionToSeconds(dl.timeDivision, state.bpm);
    const delayFeedback = dl.feedback * FEEDBACK_TO_ENGINE;
    const delayChanged =
      !lastDelay ||
      Math.abs(lastDelay.seconds - delaySeconds) > 1e-6 ||
      Math.abs(lastDelay.feedback - delayFeedback) > 0.001 ||
      Math.abs(lastDelay.pingpong - dl.pingpong) > 0.001 ||
      Math.abs(lastDelay.lofi - dl.lofi) > 0.001;
    if (delayChanged) {
      lastDelay = {
        seconds: delaySeconds,
        feedback: delayFeedback,
        pingpong: dl.pingpong,
        lofi: dl.lofi,
      };
      void setDelayParams({
        delaySeconds,
        feedback: delayFeedback,
        pingpong: dl.pingpong,
        lofi: dl.lofi,
      });
    }

    // Pre-saturation drive (base). Drive at 0 is a true no-op in
    // the FX bus, so a separate bypass toggle would only duplicate
    // the knob's already-pinned-down zero.
    const preDrive = state.saturation.preDrive;
    const satChanged =
      !lastSaturation ||
      Math.abs(lastSaturation.preDrive - preDrive) > 0.001;
    if (satChanged) {
      lastSaturation = { preDrive };
      void setSaturationParams({ preDrive });
    }

    // Glitch mix base. `chance` drives the beat-fire dice roll in
    // the scheduler subscriber below; the engine just receives
    // one-shot fire commands.
    const glitchMix = state.glitch.mix;
    if (lastGlitchMix === null || Math.abs(lastGlitchMix - glitchMix) > 0.001) {
      lastGlitchMix = glitchMix;
      void setGlitchParams({ mix: glitchMix });
    }

    // Master stage filters (phase 7e-1) — bases. loCut is an integer
    // index, the others are 0..1 norms.
    const masterInput = state.master.input;
    const masterHiCut = state.master.hiCut;
    const masterTrim = state.master.trim;
    const masterLoCut = state.master.loCut;
    const masterChanged =
      !lastMaster ||
      Math.abs(lastMaster.input - masterInput) > 0.001 ||
      Math.abs(lastMaster.hiCut - masterHiCut) > 0.001 ||
      Math.abs(lastMaster.trim - masterTrim) > 0.001 ||
      lastMaster.loCut !== masterLoCut;
    if (masterChanged) {
      lastMaster = {
        input: masterInput,
        loCut: masterLoCut,
        hiCut: masterHiCut,
        trim: masterTrim,
      };
      void setMasterFilters({
        input: masterInput,
        loCut: masterLoCut,
        hiCut: masterHiCut,
        trim: masterTrim,
      });
    }

    // Master compressor (phase 7e-2). `amount` is the LFO-routable
    // base; attack/release are discrete selector positions.
    const masterCompAmount = state.master.comp;
    const masterCompAttack = state.master.compAttack;
    const masterCompRelease = state.master.compRelease;
    const masterCompChanged =
      !lastMasterComp ||
      Math.abs(lastMasterComp.amount - masterCompAmount) > 0.001 ||
      lastMasterComp.attackIdx !== masterCompAttack ||
      lastMasterComp.releaseIdx !== masterCompRelease;
    if (masterCompChanged) {
      lastMasterComp = {
        amount: masterCompAmount,
        attackIdx: masterCompAttack,
        releaseIdx: masterCompRelease,
      };
      void setMasterComp({
        amount: masterCompAmount,
        attackIdx: masterCompAttack,
        releaseIdx: masterCompRelease,
      });
    }

    // Master distortion (phase 7e-3) — bases. Bias travels in its
    // natural 0..0.2 range; Rust LFO compute normalizes per the
    // `bias/0.2 → modulate → ×0.2` pattern.
    const masterDistMode = state.master.mode;
    const masterDistDrive = state.master.drive;
    const masterDistBias = state.master.bias;
    const masterDistMix = state.master.mix;
    const masterDistChanged =
      !lastMasterDist ||
      lastMasterDist.mode !== masterDistMode ||
      Math.abs(lastMasterDist.drive - masterDistDrive) > 0.001 ||
      Math.abs(lastMasterDist.bias - masterDistBias) > 0.0005 ||
      Math.abs(lastMasterDist.mix - masterDistMix) > 0.001;
    if (masterDistChanged) {
      lastMasterDist = {
        mode: masterDistMode,
        drive: masterDistDrive,
        bias: masterDistBias,
        mix: masterDistMix,
      };
      void setMasterDist({
        mode: masterDistMode,
        drive: masterDistDrive,
        bias: masterDistBias,
        mix: masterDistMix,
      });
    }

    // Master gate (phase 7e-4) — bases.
    const masterGateEnabled = state.master.gateEnabled;
    const masterGateThreshold = state.master.gateThreshold;
    const masterGateChanged =
      !lastMasterGate ||
      lastMasterGate.enabled !== masterGateEnabled ||
      Math.abs(lastMasterGate.threshold - masterGateThreshold) > 0.001;
    if (masterGateChanged) {
      lastMasterGate = {
        enabled: masterGateEnabled,
        threshold: masterGateThreshold,
      };
      void setMasterGate({
        enabled: masterGateEnabled,
        threshold: masterGateThreshold,
      });
    }

    // Master full-unit bypass (phase 7e-5). Discrete toggle, no
    // modulation — Rust handles the smooth crossfade internally.
    const masterBypass = state.master.bypass;
    if (lastMasterBypass !== masterBypass) {
      lastMasterBypass = masterBypass;
      void setMasterBypass(masterBypass);
    }

    // Tape (full bed + grains) — bases. Stretch knobs are 0..1 in
    // store; map to 0.25..4 playback rate the same way web tape.ts
    // does. Stretch/gain/reverse/hold aren't LFO-modulated, so no
    // base/effective split Rust-side.
    const tape = state.tape;
    const tapePosition = tape.position;
    const tapeLength = tape.length;
    const tapeMix = tape.mix;
    const tapeStretch1 = Math.pow(2, (tape.stretch1 - 0.5) * 4);
    const tapeStretch2 = Math.pow(2, (tape.stretch2 - 0.5) * 4);
    const tapeGain1 = tape.gain1;
    const tapeGain2 = tape.gain2;
    const tapeReverse = tape.reverse;
    const tapeHold = tape.hold;
    const tapeGrainRate = tape.grainRate;
    const tapeGrainMix = tape.grainMix;
    const tapeChanged =
      !lastTape ||
      Math.abs(lastTape.position - tapePosition) > 0.001 ||
      Math.abs(lastTape.length - tapeLength) > 0.001 ||
      Math.abs(lastTape.stretch1 - tapeStretch1) > 0.001 ||
      Math.abs(lastTape.gain1 - tapeGain1) > 0.001 ||
      Math.abs(lastTape.stretch2 - tapeStretch2) > 0.001 ||
      Math.abs(lastTape.gain2 - tapeGain2) > 0.001 ||
      Math.abs(lastTape.mix - tapeMix) > 0.001 ||
      lastTape.reverse !== tapeReverse ||
      lastTape.hold !== tapeHold ||
      Math.abs(lastTape.grainRate - tapeGrainRate) > 0.001 ||
      Math.abs(lastTape.grainMix - tapeGrainMix) > 0.001;
    if (tapeChanged) {
      lastTape = {
        position: tapePosition,
        length: tapeLength,
        stretch1: tapeStretch1,
        gain1: tapeGain1,
        stretch2: tapeStretch2,
        gain2: tapeGain2,
        mix: tapeMix,
        reverse: tapeReverse,
        hold: tapeHold,
        grainRate: tapeGrainRate,
        grainMix: tapeGrainMix,
      };
      void setTapeParams({
        position: tapePosition,
        length: tapeLength,
        stretch1: tapeStretch1,
        gain1: tapeGain1,
        stretch2: tapeStretch2,
        gain2: tapeGain2,
        mix: tapeMix,
        reverse: tapeReverse,
        hold: tapeHold,
        grainRate: tapeGrainRate,
        grainMix: tapeGrainMix,
      });
    }
  };
  const id = window.setInterval(tick, PARAM_PUSH_MS);
  return () => window.clearInterval(id);
}
