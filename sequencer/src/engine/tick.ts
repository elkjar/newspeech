// Pure per-step resolution functions extracted from App.tsx's scheduler
// callback. These compute the dispatch decision for a single track-step and
// return the resolved values; the caller (App.tsx, or a future native /
// VST shell) owns all I/O — overlay writes, chord-context updates, pad-
// drift advances, sample/MIDI triggers.
//
// Refactor pass 1a (behavior-identical move): random rolls live here, but
// every observable side effect still happens in the dispatcher.
//
// Layout:
//   - Tie helpers (isSilencedByTie, tieLength)
//   - resolveFreezePlayback — replays the most recent overlay
//   - resolveStepMutation   — rolls flip / vel / pitch / gate / density gate
//   - resolveChordMasterNote — chord-master harmony with chord-aware mutation
//   - resolveFollowerNote   — root-follow / chord-tone / scale-tone / semitones

import type { Step, Track, TrackSection } from '../state/store';
import { RATE_STRIDE } from '../state/store';
import type { MutationProfile } from '../audio/voices';
import { isPadVoice, voicePadConfig } from '../audio/voices';
import type { ChordContext } from '../audio/chordContext';
import { chordToneMidi } from '../audio/chordContext';
import {
  resolveChord,
  dropChordTone,
  shuffleInversion,
  shiftSpread,
  borrowChord,
  type ChordVoicing,
} from '../audio/chords';
import type { OverlayValue } from '../audio/mutationOverlay';
import { effectiveTieToNext } from '../audio/mutationTie';
import {
  octaveDegrees,
  fifthDegrees,
  quantize,
  scaleDegreeOf,
  type Scale,
} from '../audio/scale';
import { computeThinMul, computeFillProb } from '../audio/macros';
import { modulated, GLOBAL_TRACK_ID, type LFO } from '../audio/lfo';
import { sourceIsMelodic, sourceMutation } from '../instruments/library';

export function isSilencedByTie(track: Track, i: number): boolean {
  const len = track.length;
  if (len <= 0 || i <= 0) return false;
  let cur = i - 1;
  while (cur >= 0) {
    if (!effectiveTieToNext(track, cur)) return false;
    if (track.steps[cur]?.on) return true;
    cur--;
  }
  return false;
}

export function tieLength(track: Track, i: number): number {
  const len = track.length;
  if (len <= 0) return 1;
  let count = 1;
  let cur = i;
  while (cur < len - 1) {
    if (!effectiveTieToNext(track, cur)) break;
    count++;
    cur++;
  }
  return count;
}

export interface StepResolution {
  on: boolean;
  velocity: number;
  pitch: number;
  gate: number;
  gated: boolean;
  ratchet: number;
}

// Freeze replay — replays the previous mutated cycle's overlay outcome.
// Falls back to the authored step on the rare first-cycle case where no
// overlay entry has been written for this trackId+localStep.
export function resolveFreezePlayback(
  track: Track,
  step: Step,
  localStep: number,
  overlay: OverlayValue | undefined,
): StepResolution {
  if (overlay) {
    return {
      on: overlay.on,
      velocity: overlay.velocity,
      pitch: overlay.pitch,
      gate: overlay.gate,
      gated: overlay.gated,
      ratchet: overlay.ratchet,
    };
  }
  const tied = isSilencedByTie(track, localStep);
  return {
    on: step.on,
    velocity: step.velocity,
    pitch: step.pitch,
    gate: step.gate,
    gated: step.on && !tied,
    ratchet: Math.max(1, Math.floor(step.ratchet)),
  };
}

export interface MutationInputs {
  track: Track;
  step: Step;
  localStep: number;
  // pre-modulated mutation × chaosMul
  mut: number;
  profile: MutationProfile;
  melodic: boolean;
  isChordMaster: boolean;
  harmonicAnchor: boolean;
  isBarDownbeatTick: boolean;
  // tension biases — already split into stable / color multipliers
  tStableMul: number;
  tColorMul: number;
  // modulated density [0..1]
  modDensity: number;
  // modulated row-ratchet probability gate [0..1]
  rowRatchet: number;
  chordContext: ChordContext;
  scale: Scale;
}

// Non-freeze per-step roll: on-flip, velocity jitter, pitch jump (chord-tone
// aware), gate jitter, tie + density thin/fill, row ratchet bump. All random
// state lives here; the caller writes the result to the mutation overlay.
export function resolveStepMutation(inputs: MutationInputs): StepResolution {
  const {
    track,
    step,
    localStep,
    mut,
    profile,
    melodic,
    isChordMaster,
    harmonicAnchor,
    isBarDownbeatTick,
    tStableMul,
    tColorMul,
    modDensity,
    rowRatchet,
    chordContext,
    scale,
  } = inputs;
  let on = step.on;
  if (mut > 0 && !track.lockTiming && !harmonicAnchor) {
    let flipChance = mut * profile.flipChance;
    if (!step.on && profile.stepWeights && profile.stepWeights.length > 0) {
      flipChance *= profile.stepWeights[localStep % profile.stepWeights.length];
    }
    if (flipChance > 0 && Math.random() < flipChance) {
      // Don't flip authored-ON hits OFF at bar downbeats — drum / motif
      // downbeats stay reliable. Chord master + bass short-circuit above
      // via harmonicAnchor.
      if (!(isBarDownbeatTick && step.on)) {
        on = !on;
      }
    }
  }
  const velJitter =
    mut > 0 ? (Math.random() - 0.5) * 2 * mut * profile.velSpread : 0;
  const velocity = Math.max(0, Math.min(1, step.velocity + velJitter));
  let pitch = step.pitch;
  if (melodic && mut > 0 && Math.random() < mut * profile.pitchJumpProb) {
    // chord-tone-mode followers measure octaves in chord-tone count rather
    // than scale degrees; see App.tsx history for the rationale.
    const isChordToneMode = !isChordMaster && track.pitchInterp === 'chord-tone';
    const ctxLen = isChordToneMode
      ? Math.max(1, chordContext.intervals.length)
      : 0;
    const oct = isChordToneMode ? ctxLen : octaveDegrees(scale);
    const fifth = isChordToneMode ? 0 : fifthDegrees(scale);
    const w = profile.pitchWeights;
    const eOct = isChordToneMode
      ? (w.octave + w.fifth) * tStableMul
      : w.octave * tStableMul;
    const eFifth = isChordToneMode ? 0 : w.fifth * tStableMul;
    const eSmall = w.small * tColorMul;
    const total = eOct + eFifth + eSmall;
    if (total > 0) {
      const r = Math.random() * total;
      let jump: number;
      if (r < eOct) jump = Math.random() < 0.5 ? -oct : oct;
      else if (r < eOct + eFifth) jump = Math.random() < 0.5 ? -fifth : fifth;
      else {
        const small = isChordToneMode
          ? [-2, -1, 1, 2]
          : [-3, -2, -1, 1, 2, 3];
        jump = small[Math.floor(Math.random() * small.length)];
      }
      const clampMax = isChordToneMode ? ctxLen : 14;
      pitch = Math.max(-clampMax, Math.min(clampMax, pitch + jump));
    }
  }
  const gateBias = mut > 0 ? mut * profile.gateBias : 0;
  const gateJitter =
    mut > 0 ? (Math.random() - 0.5) * 2 * mut * profile.gateSpread : 0;
  const gate = Math.max(0.1, Math.min(3, step.gate + gateBias + gateJitter));
  const tied = isSilencedByTie(track, localStep);
  let gated = on && !tied;
  if (gated) {
    if (!isBarDownbeatTick && !harmonicAnchor) {
      const mul = computeThinMul(modDensity, localStep, track.length);
      const effectiveProb = step.probability * mul;
      if (effectiveProb < 100 && Math.random() * 100 >= effectiveProb) {
        gated = false;
      }
    }
  } else if (!on && !tied && !harmonicAnchor) {
    const hasAuthoredOn = track.steps
      .slice(0, track.length)
      .some((s) => s.on);
    if (hasAuthoredOn) {
      const fillProb = computeFillProb(modDensity, localStep, track.length, track.section);
      if (fillProb > 0 && Math.random() < fillProb) {
        gated = true;
      }
    }
  }
  let ratchet = Math.max(1, Math.floor(step.ratchet));
  if (gated && rowRatchet > 0 && Math.random() < rowRatchet * 0.5) {
    ratchet = 2 + Math.floor(Math.random() * 7);
  }
  return { on, velocity, pitch, gate, gated, ratchet };
}

export interface ChordMasterInputs {
  track: Track;
  stepVoicing: ChordVoicing;
  rootNote: number;
  scale: Scale;
  // mutated pitch (degree offset)
  pitch: number;
  harmonicShift: number;
  mut: number;
  profile: MutationProfile;
  freeze: boolean;
  frozenChord:
    | { root: number; intervals: number[]; voicing: ChordVoicing }
    | undefined;
  // null = not a pad voice or freeze mode (skip drift roll entirely)
  // number = pre-advanced drift counter (caller called tickPadDrift)
  padDriftCount: number | null;
}

export interface ChordMasterResult {
  rootMidi: number;
  // intervals to play (audible). For non-voice sources, always [0].
  voiceIntervals: number[];
  // chord context write — null when stepVoicing.degree === 0 (no chord to publish)
  publishedChord:
    | { root: number; intervals: number[]; voicing: ChordVoicing }
    | null;
  // overlay attach data — null on freeze (don't overwrite the frozen entry)
  overlayChord:
    | { root: number; intervals: number[]; voicing: ChordVoicing }
    | null;
}

// Chord-master harmony with chord-aware mutation primitives and pad voicing
// drift. Returns the resolved root + audible intervals + writes the caller
// should apply (chord context, overlay attach). No I/O performed here.
export function resolveChordMasterNote(
  inputs: ChordMasterInputs,
): ChordMasterResult {
  const {
    track,
    stepVoicing,
    rootNote,
    scale,
    pitch,
    harmonicShift,
    mut,
    profile,
    freeze,
    frozenChord,
    padDriftCount,
  } = inputs;
  let chordRoot: number;
  let chordIntervals: number[];
  let audibleIntervals: number[];
  let publishedVoicing = stepVoicing;
  if (frozenChord) {
    chordRoot = frozenChord.root;
    chordIntervals = frozenChord.intervals;
    audibleIntervals = frozenChord.intervals;
    publishedVoicing = frozenChord.voicing;
  } else {
    const authored = resolveChord(
      rootNote,
      scale,
      stepVoicing,
      pitch + harmonicShift,
    );
    let chord = authored;
    let droppedIntervals: number[] | null = null;
    if (
      !freeze &&
      mut > 0 &&
      stepVoicing.degree > 0 &&
      profile.chordMutationChance > 0 &&
      Math.random() < mut * profile.chordMutationChance
    ) {
      const isPad =
        track.source.kind === 'voice' && isPadVoice(track.source.id);
      const picks = isPad ? [0, 2, 3] : [0, 1, 2, 3];
      const pick = picks[Math.floor(Math.random() * picks.length)];
      if (pick === 0) {
        droppedIntervals = dropChordTone(authored.intervals);
      } else if (pick === 1) {
        const borrowed = borrowChord(
          rootNote,
          scale,
          stepVoicing,
          pitch + harmonicShift,
        );
        if (borrowed) chord = borrowed;
      } else if (pick === 2) {
        const v = shuffleInversion(stepVoicing);
        chord = resolveChord(rootNote, scale, v, pitch + harmonicShift);
        publishedVoicing = v;
      } else {
        const v = shiftSpread(stepVoicing);
        chord = resolveChord(rootNote, scale, v, pitch + harmonicShift);
        publishedVoicing = v;
      }
    }
    if (
      !freeze &&
      track.source.kind === 'voice' &&
      isPadVoice(track.source.id) &&
      stepVoicing.degree > 0 &&
      padDriftCount !== null
    ) {
      const padCfg = voicePadConfig(track.source.id);
      if (padCfg && padCfg.voicingDriftEveryNTriggers > 0) {
        if (
          padDriftCount % padCfg.voicingDriftEveryNTriggers === 0 &&
          Math.random() < padCfg.voicingDriftChance
        ) {
          let v = publishedVoicing;
          if (padCfg.voicingDriftAxis === 'inversion') {
            v = shuffleInversion(v);
          } else if (padCfg.voicingDriftAxis === 'spread') {
            v = shiftSpread(v);
          } else {
            v = Math.random() < 0.5 ? shuffleInversion(v) : shiftSpread(v);
          }
          chord = resolveChord(rootNote, scale, v, pitch + harmonicShift);
          droppedIntervals = null;
          publishedVoicing = v;
        }
      }
    }
    chordRoot = chord.root;
    chordIntervals = chord.intervals;
    audibleIntervals = droppedIntervals ?? chord.intervals;
  }
  const voiceIntervals =
    track.source.kind === 'voice' ? audibleIntervals : [0];
  const publishedChord =
    stepVoicing.degree > 0
      ? { root: chordRoot, intervals: chordIntervals, voicing: publishedVoicing }
      : null;
  const overlayChord = !freeze
    ? { root: chordRoot, intervals: audibleIntervals, voicing: publishedVoicing }
    : null;
  return { rootMidi: chordRoot, voiceIntervals, publishedChord, overlayChord };
}

export interface FollowerInputs {
  track: Track;
  stepVoicing: ChordVoicing;
  rootNote: number;
  scale: Scale;
  pitch: number;
  harmonicShift: number;
  chordContext: ChordContext;
}

export interface FollowerResult {
  rootMidi: number;
  voiceIntervals: number[];
}

// Melodic follower note resolution — picks one of four interpretations of
// `step.pitch` based on track.pitchInterp. harmonicShift is already baked
// into the published chord context (the chord master applied it), so
// chord-tone / root-follow / scale-tone modes don't re-apply it.
export function resolveFollowerNote(inputs: FollowerInputs): FollowerResult {
  const {
    track,
    stepVoicing,
    rootNote,
    scale,
    pitch,
    harmonicShift,
    chordContext,
  } = inputs;
  if (track.pitchInterp === 'root-follow') {
    return { rootMidi: chordContext.root, voiceIntervals: [0] };
  }
  if (track.pitchInterp === 'chord-tone') {
    return { rootMidi: chordToneMidi(chordContext, pitch), voiceIntervals: [0] };
  }
  if (track.pitchInterp === 'scale-tone') {
    const baseDegree = scaleDegreeOf(chordContext.root, rootNote, scale);
    const rootMidi =
      baseDegree !== null
        ? quantize(rootNote, scale, baseDegree + pitch)
        : quantize(chordContext.root, scale, pitch);
    return { rootMidi, voiceIntervals: [0] };
  }
  // semitones — independent, no chord-context follow.
  const chord = resolveChord(rootNote, scale, stepVoicing, pitch + harmonicShift);
  return {
    rootMidi: chord.root,
    voiceIntervals: track.source.kind === 'voice' ? chord.intervals : [0],
  };
}

// -----------------------------------------------------------------------------
// Pass-1b entry point: per-tick orchestrator that emits a typed event list.
//
// `runTick` reads a state snapshot + per-tick scheduler params and returns
// the events the dispatcher should apply, in order. All same-tick read-after-
// write semantics live inside the engine via a local chord-context shadow —
// followers process AFTER the chord master in the same tick and read the
// updated chord locally, so the emitted `chordContext` event only matters
// for code outside the dispatch loop.
//
// `TickContext` carries the two unavoidable caller-side reads/writes — the
// mutation overlay (read for freeze playback, written via emitted events)
// and the pad-drift counter (read-and-increment in one shot). Both are
// injected so tests can swap in fakes.
// -----------------------------------------------------------------------------

export type TickEvent =
  | {
      kind: 'overlay';
      trackId: string;
      localStep: number;
      value: OverlayValue;
    }
  | { kind: 'chordContext'; chord: ChordContext }
  | {
      kind: 'overlayChord';
      trackId: string;
      localStep: number;
      chord: { root: number; intervals: number[]; voicing: ChordVoicing };
    }
  | {
      kind: 'midi';
      portName: string | null;
      channel: number;
      note: number;
      velocity: number;
      when: number;
      durationS: number;
    }
  | {
      kind: 'sample';
      voice: string;
      trackId: string;
      when: number;
      velocity: number;
      midi: number | undefined;
      gate: number;
      stepDuration: number;
      // Tied-chain length (1 = no tie, 2+ = step + N consumed silent
      // followers). Already folded into `gate` for the standard
      // play-through; carried separately so the arp dispatcher can
      // spread tones across the full tied window instead of just the
      // first step.
      tieLength: number;
      voiceIntervals: number[];
      pan: number;
      monophonic: boolean;
      // Track section — routed by the dispatcher into the rhythm or melody
      // recorder bus so stems output can split sample audio by section.
      section: TrackSection;
    };

export interface TickContext {
  // Pure read — used for freeze playback + frozenChord lookup.
  readOverlay(trackId: string, stepIndex: number): OverlayValue | undefined;
  // Mutating read — increments and returns the per-track counter. Engine
  // only invokes this when it has decided drift roll should happen, so the
  // counter advances on exactly the triggers it would have under 1a.
  consumePadDrift(trackId: string): number;
}

export interface TickInputs {
  // State snapshot (read once at the start of the scheduler callback, so
  // the engine never sees a mid-tick swap).
  tracks: Track[];
  rootNote: number;
  scale: Scale;
  lfos: LFO[];
  density: number;
  chaos: number;
  tension: number;
  freeze: boolean;
  sceneStartStep: number;
  // Per-tick scheduler params.
  globalStep: number;
  when: number;
  stepDuration: number;
  // Caller computes harmonic motion (it's a cross-tick state machine that
  // lives in the dispatcher) and threads the resolved offset in.
  harmonicOffset: number;
  // Chord context at tick start. Engine maintains a local shadow as it
  // walks tracks; emits the final value as a `chordContext` event if it
  // changed.
  chordContext: ChordContext;
}

export function runTick(inputs: TickInputs, ctx: TickContext): TickEvent[] {
  const events: TickEvent[] = [];

  // Macro modulation — only density / chaos / tension drive per-step gating.
  // motion / drift are consumed by `tickHarmonicMotion` in the dispatcher
  // (cross-tick state) so they don't appear here.
  const modDensity = modulated(
    inputs.density,
    inputs.lfos,
    GLOBAL_TRACK_ID,
    'density',
    undefined,
    1,
  );
  const modChaos = modulated(
    inputs.chaos,
    inputs.lfos,
    GLOBAL_TRACK_ID,
    'chaos',
    undefined,
    1,
  );
  const modTension = modulated(
    inputs.tension,
    inputs.lfos,
    GLOBAL_TRACK_ID,
    'tension',
    undefined,
    1,
  );
  const chaosMul = modChaos * 2;
  const tBipolar = (modTension - 0.5) * 2;
  const tStableMul = Math.max(0, 1 - tBipolar);
  const tColorMul = Math.max(0, 1 + tBipolar);

  const sceneStep = inputs.globalStep - inputs.sceneStartStep;
  const isBarDownbeatTick = sceneStep % 32 === 0;
  const anySolo = inputs.tracks.some((t) => t.solo);

  // Local shadow of the chord context. Updated when the chord master
  // publishes; followers (later in this same tick) read this rather than
  // the global so same-tick read-after-write works without leaking through
  // the global singleton.
  let localChordCtx = inputs.chordContext;

  let melodicSlot = -1;
  for (const track of inputs.tracks) {
    let isChordMaster = false;
    let isBass = false;
    if (track.section === 'melodic') {
      melodicSlot++;
      isChordMaster = melodicSlot === 0;
      isBass = melodicSlot === 1;
    }
    const harmonicAnchor = isChordMaster || isBass;
    // Row 0 mute split — chord master still resolves so chord context
    // publishes, but no audio events get emitted at the tail.
    if (track.mute && !isChordMaster) continue;
    if (anySolo && !track.solo && !isChordMaster) continue;
    const stride = RATE_STRIDE[track.rate];
    if (sceneStep % stride !== 0) continue;
    const rowStep = Math.floor(sceneStep / stride);
    const localStep = rowStep % track.length;
    const step = track.steps[localStep];
    if (!step) continue;
    if (track.source.kind === 'empty') continue;

    const rowStepDuration = inputs.stepDuration * stride;
    const mut =
      modulated(track.mutation, inputs.lfos, track.id, 'mutation') * chaosMul;
    const trackRowRatchet = modulated(
      track.rowRatchet,
      inputs.lfos,
      track.id,
      'rowRatchet',
    );
    const melodic = sourceIsMelodic(track.source);
    const profile = sourceMutation(track.source);
    const stepVoicing = step.chordVoicing ?? track.defaultChordVoicing;

    const resolution = inputs.freeze
      ? resolveFreezePlayback(
          track,
          step,
          localStep,
          ctx.readOverlay(track.id, localStep),
        )
      : resolveStepMutation({
          track,
          step,
          localStep,
          mut,
          profile,
          melodic,
          isChordMaster,
          harmonicAnchor,
          isBarDownbeatTick,
          tStableMul,
          tColorMul,
          modDensity,
          rowRatchet: trackRowRatchet,
          chordContext: localChordCtx,
          scale: inputs.scale,
        });

    if (!inputs.freeze) {
      events.push({
        kind: 'overlay',
        trackId: track.id,
        localStep,
        value: {
          on: resolution.on,
          velocity: resolution.velocity,
          pitch: resolution.pitch,
          gate: resolution.gate,
          gated: resolution.gated,
          ratchet: resolution.ratchet,
        },
      });
    }

    if (!resolution.gated) continue;

    const { velocity: v, pitch, gate: gateMutated, ratchet } = resolution;
    const ties = tieLength(track, localStep);
    const baseTime = inputs.when + step.microTiming * rowStepDuration;
    const subDur = rowStepDuration / ratchet;
    const effectiveGate = gateMutated * ties;
    const harmonicShift = melodic ? inputs.harmonicOffset : 0;

    let rootMidi: number | undefined;
    let voiceIntervals: number[] = [0];
    if (melodic) {
      if (isChordMaster) {
        let padDriftCount: number | null = null;
        if (
          !inputs.freeze &&
          track.source.kind === 'voice' &&
          isPadVoice(track.source.id) &&
          stepVoicing.degree > 0
        ) {
          const padCfg = voicePadConfig(track.source.id);
          if (padCfg && padCfg.voicingDriftEveryNTriggers > 0) {
            padDriftCount = ctx.consumePadDrift(track.id);
          }
        }
        const frozenChord = inputs.freeze
          ? ctx.readOverlay(track.id, localStep)?.chord
          : undefined;
        const cm = resolveChordMasterNote({
          track,
          stepVoicing,
          rootNote: inputs.rootNote,
          scale: inputs.scale,
          pitch,
          harmonicShift,
          mut,
          profile,
          freeze: inputs.freeze,
          frozenChord,
          padDriftCount,
        });
        rootMidi = cm.rootMidi;
        voiceIntervals = cm.voiceIntervals;
        if (cm.publishedChord) {
          // Update the local shadow FIRST so followers later in this tick
          // see the new chord; emit the event so the global gets updated
          // when the dispatcher applies events.
          localChordCtx = cm.publishedChord;
          events.push({ kind: 'chordContext', chord: cm.publishedChord });
        }
        if (cm.overlayChord) {
          events.push({
            kind: 'overlayChord',
            trackId: track.id,
            localStep,
            chord: cm.overlayChord,
          });
        }
      } else {
        const fr = resolveFollowerNote({
          track,
          stepVoicing,
          rootNote: inputs.rootNote,
          scale: inputs.scale,
          pitch,
          harmonicShift,
          chordContext: localChordCtx,
        });
        rootMidi = fr.rootMidi;
        voiceIntervals = fr.voiceIntervals;
      }
      if (rootMidi !== undefined && track.octave !== 0) {
        rootMidi += track.octave * 12;
      }
    }

    // Row 0 mute split tail — chord context has already been published
    // above; we skip emitting audio events for muted/soloed-out rows.
    if (track.mute) continue;
    if (anySolo && !track.solo) continue;

    const isInstrument = track.source.kind === 'instrument';
    const midiNoteDuration = Math.max(0.02, effectiveGate * rowStepDuration);

    for (let r = 0; r < ratchet; r++) {
      const t = baseTime + r * subDur;
      if (isInstrument) {
        let outNote: number;
        if (track.midi.note !== null) outNote = track.midi.note;
        else if (rootMidi !== undefined) outNote = rootMidi;
        else continue;
        events.push({
          kind: 'midi',
          portName: track.midi.portName,
          channel: track.midi.channel,
          note: outNote,
          velocity: v,
          when: t,
          durationS: midiNoteDuration,
        });
      } else if (track.source.kind === 'voice') {
        // Gain stores 0..2 with unity at the dial center, but the LFO
        // pipeline clamps inside 0..1. Halve before modulating, restore
        // after — keeps swing symmetric around the knob's center.
        const modGain =
          modulated(track.gain / 2, inputs.lfos, track.id, 'gain') * 2;
        events.push({
          kind: 'sample',
          voice: track.source.id,
          trackId: track.id,
          when: t,
          velocity: v * modGain,
          midi: rootMidi,
          gate: effectiveGate,
          stepDuration: rowStepDuration,
          tieLength: ties,
          voiceIntervals,
          pan: modulated(track.pan, inputs.lfos, track.id, 'pan'),
          // Bass-by-position (melodic slot 1) is always monophonic
          // regardless of saved track.monophonic — covers user-authored
          // bass tracks loaded from .seq files that predate the composer.
          monophonic: track.monophonic || isBass,
          section: track.section,
        });
      }
    }
  }

  return events;
}

