import { useEffect } from 'react';
import { PlayButton, TransportControls } from './components/Transport';
import { TrackGrid } from './components/TrackGrid';
import { StepInspector } from './components/StepInspector';
import { LFOPanel } from './components/LFOPanel';
import { MacroStrip } from './components/MacroStrip';
import { BankPad } from './components/BankPad';
import { MidiBar } from './components/MidiBar';
import { FXPanel } from './components/FXPanel';
import {
  useSequencerStore,
  RATE_STRIDE,
  type EditMode,
  type Track,
  type TrackSection,
} from './state/store';
import { scheduler } from './audio/scheduler';
import { samplePlayer } from './audio/samplePlayer';
import { initMIDIOut, sendMIDINote, resolveDeviceId } from './audio/midiOut';
import { initMIDIIn } from './midi/midiIn';
import { dispatchMidi } from './midi/midiMap';
import { loadMidiMapLibrary } from './midi/midiMapLoader';
import { octaveDegrees, fifthDegrees, quantize, scaleDegreeOf } from './audio/scale';
import {
  sourceIsMelodic,
  sourceMutation,
} from './instruments/library';
import { isPadVoice, voicePadConfig } from './audio/voices';
import { tickPadDrift } from './audio/padState';
import {
  resolveChord,
  dropChordTone,
  shuffleInversion,
  shiftSpread,
  borrowChord,
} from './audio/chords';
import { getChordContext, setChordContext, chordToneMidi } from './audio/chordContext';
import { getOverlay, setOverlay, attachChordToOverlay } from './audio/mutationOverlay';
import { effectiveTieToNext } from './audio/mutationTie';
import { modulated, GLOBAL_TRACK_ID } from './audio/lfo';
import { computeThinMul, computeFillProb } from './audio/macros';
import { makeHarmonicMotionState, tickHarmonicMotion } from './audio/harmonicMotion';
import { togglePlayback } from './audio/transport';

const MODE_KEYS: Record<string, EditMode> = {
  '1': 'live',
  '2': 'velocity',
  '3': 'chance',
  '4': 'ratchet',
  '5': 'timing',
  '6': 'gate',
};

const MODES: EditMode[] = ['live', 'velocity', 'chance', 'ratchet', 'timing', 'gate'];

const SECTIONS: { id: TrackSection; label: string }[] = [
  { id: 'drum', label: 'rhythm' },
  { id: 'melodic', label: 'melody' },
];

function SectionToggle() {
  const viewSection = useSequencerStore((s) => s.viewSection);
  const setViewSection = useSequencerStore((s) => s.setViewSection);
  return (
    <div className="flex gap-2 text-[11px] uppercase tracking-widest">
      {SECTIONS.map((s) => (
        <button
          key={s.id}
          onClick={() => setViewSection(s.id)}
          className={[
            'px-3 py-1.5 border transition-colors',
            viewSection === s.id
              ? 'bg-white text-ink border-white'
              : 'border-white/15 text-white/60 hover:text-white hover:border-white',
          ].join(' ')}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

function ModeSwitcher() {
  const editMode = useSequencerStore((s) => s.editMode);
  const setEditMode = useSequencerStore((s) => s.setEditMode);
  return (
    <div className="flex gap-2 text-[11px] uppercase tracking-widest">
      {MODES.map((m) => (
        <button
          key={m}
          onClick={() => setEditMode(m)}
          className={[
            'px-3 py-1.5 border transition-colors',
            editMode === m
              ? 'bg-white text-ink border-white'
              : 'border-white/15 text-white/60 hover:text-white hover:border-white',
          ].join(' ')}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

function isSilencedByTie(track: Track, i: number): boolean {
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

function tieLength(track: Track, i: number): number {
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

export function App() {
  const bpm = useSequencerStore((s) => s.bpm);

  useEffect(() => {
    initMIDIOut();
    // Load any saved user mappings FIRST so the active mapping is in
    // place before MIDI input starts firing.
    void (async () => {
      await loadMidiMapLibrary();
      await initMIDIIn(dispatchMidi);
    })();
  }, []);

  useEffect(() => {
    const kits = [
      'drums/blck_noir',
      'pads/encounter',
      'pads/pulsed',
      'pads/sinewaves-at-the-scope',
      'instruments/hydrasynth_plaits',
      'instruments/mini-moog',
      'instruments/rhodes_mk1',
      'instruments/root_grain',
      'instruments/soft_piano',
      'instruments/tape_piano',
      'instruments/under_piano',
    ];
    for (const kitPath of kits) {
      const baseUrl = `${import.meta.env.BASE_URL}samples/${kitPath}`;
      fetch(`${baseUrl}/manifest.json`)
        .then((r) => r.json())
        .then((manifest) => samplePlayer.loadManifest(baseUrl, manifest))
        .catch((err) => console.warn(`sample manifest ${kitPath} load failed:`, err));
    }
  }, []);

  useEffect(() => {
    const harmonic = makeHarmonicMotionState();
    return scheduler.onStep((globalStep, when, stepDuration) => {
      // Bar boundary at 4/4 32nd resolution = every 32 global steps. A queued
      // pattern recall commits here, before we read `tracks` for this tick,
      // so the swap is atomic from the dispatch's point of view.
      if (globalStep % 32 === 0) {
        useSequencerStore.getState().commitPendingBank();
      }
      const { tracks, rootNote, scale, lfos, midiOutDeviceId, density, chaos, motion, drift, tension, freeze } =
        useSequencerStore.getState();
      // Macros may themselves be LFO-modulated. LFOs run at their natural rates
      // (motion no longer scales them) so we pass rateMul=1 across the board.
      const modMotion = modulated(motion, lfos, GLOBAL_TRACK_ID, 'motion', undefined, 1);
      const modDrift = modulated(drift, lfos, GLOBAL_TRACK_ID, 'drift', undefined, 1);
      const modDensity = modulated(density, lfos, GLOBAL_TRACK_ID, 'density', undefined, 1);
      const modChaos = modulated(chaos, lfos, GLOBAL_TRACK_ID, 'chaos', undefined, 1);
      const modTension = modulated(tension, lfos, GLOBAL_TRACK_ID, 'tension', undefined, 1);
      // density is bipolar — per-step thin/fill helpers are called inside the gate below.
      const chaosMul = modChaos * 2;
      const tBipolar = (modTension - 0.5) * 2;
      const tStableMul = Math.max(0, 1 - tBipolar);
      const tColorMul = Math.max(0, 1 + tBipolar);
      // Hold harmonic offset at its current value during freeze so the captured
      // mutated cycle keeps the same key-shift it had at freeze moment.
      const harmonicOffset = freeze
        ? harmonic.offset
        : tickHarmonicMotion(
            harmonic,
            globalStep,
            modMotion,
            modDrift,
            octaveDegrees(scale)
          );
      const anySolo = tracks.some((t) => t.solo);
      // Melodic-section row index drives role assignment: slot 0 = chord
      // master, slot 1 = bass (default root-follow), slots 2+ = motifs
      // (default chord-tone). Counter is per-section; drum tracks don't
      // increment it.
      let melodicSlot = -1;
      for (const track of tracks) {
        let isChordMaster = false;
        if (track.section === 'melodic') {
          melodicSlot++;
          isChordMaster = melodicSlot === 0;
        }
        // Row 0 mute split: keep running dispatch so chord context still
        // updates (the "pull pad out of the mix, leave harmonic skeleton
        // intact" performance gesture). Audio trigger is skipped later.
        if (track.mute && !isChordMaster) continue;
        if (anySolo && !track.solo && !isChordMaster) continue;
        const stride = RATE_STRIDE[track.rate];
        if (globalStep % stride !== 0) continue;
        const rowStep = Math.floor(globalStep / stride);
        const localStep = rowStep % track.length;
        const authoredStep = track.steps[localStep];
        if (!authoredStep) continue;
        const rowStepDuration = stepDuration * stride;
        const trackMut = modulated(track.mutation, lfos, track.id, 'mutation') * chaosMul;
        const trackRowRatchet = modulated(track.rowRatchet, lfos, track.id, 'rowRatchet');
        const step = authoredStep;
        const mut = trackMut;
        if (track.source.kind === 'empty') continue;
        const melodic = sourceIsMelodic(track.source);
        const profile = sourceMutation(track.source);
        // Freeze: replay the most recent overlay (= the previous cycle's mutated
        // outcome) without rolling new mutation OR new trigger gates, and don't
        // overwrite the overlay. Falls back to the authored step on the rare
        // first-cycle case where no overlay entry has been written.
        let on: boolean;
        let v: number;
        let pitch: number;
        let gateMutated: number;
        let gated: boolean;
        let ratchet: number;
        if (freeze) {
          const f = getOverlay(track.id, localStep);
          if (f) {
            on = f.on;
            v = f.velocity;
            pitch = f.pitch;
            gateMutated = f.gate;
            gated = f.gated;
            ratchet = f.ratchet;
          } else {
            on = step.on;
            v = step.velocity;
            pitch = step.pitch;
            gateMutated = step.gate;
            gated = on && !isSilencedByTie(track, localStep);
            ratchet = Math.max(1, Math.floor(step.ratchet));
          }
        } else {
          on = step.on;
          if (mut > 0 && !track.lockTiming) {
            let flipChance = mut * profile.flipChance;
            if (!step.on && profile.stepWeights && profile.stepWeights.length > 0) {
              flipChance *= profile.stepWeights[localStep % profile.stepWeights.length];
            }
            if (flipChance > 0 && Math.random() < flipChance) on = !on;
          }
          const velJitter =
            mut > 0 ? (Math.random() - 0.5) * 2 * mut * profile.velSpread : 0;
          v = Math.max(0, Math.min(1, step.velocity + velJitter));
          pitch = step.pitch;
          if (melodic && mut > 0 && Math.random() < mut * profile.pitchJumpProb) {
            // Pitch-jump units depend on how the follower interprets `pitch`.
            // In chord-tone mode (`pitch` indexes the published chord's
            // intervals), an "octave" is intervals.length — adding the
            // chord-tone count lands on the same tone one octave up. The
            // scale's octaveDegrees (= 7 in major) would land 2-3 octaves
            // away and several chord-tones over, producing ear-piercing
            // jumps. The scale "fifth" concept also doesn't map to a chord
            // tone, so chord-tone mode folds the fifth weight into octave
            // and trims small jumps to ±1, ±2 (chord-tone steps within an
            // octave). Other modes (chord master, semitones, scale-tone,
            // root-follow) keep the scale-degree behavior.
            const isChordToneMode = !isChordMaster && track.pitchInterp === 'chord-tone';
            const ctxLen = isChordToneMode
              ? Math.max(1, getChordContext().intervals.length)
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
          gateMutated = Math.max(0.1, Math.min(3, step.gate + gateBias + gateJitter));
          // Trigger decisions — captured into the overlay so freeze replays
          // exactly which steps fired and with how many ratchets.
          const tied = isSilencedByTie(track, localStep);
          gated = on && !tied;
          if (gated) {
            // Authored-ON path: density < 0.5 thins by metric weight; >= 0.5 leaves alone.
            const mul = computeThinMul(modDensity, localStep, track.length);
            const effectiveProb = step.probability * mul;
            if (effectiveProb < 100 && Math.random() * 100 >= effectiveProb) {
              gated = false;
            }
          } else if (!on && !tied) {
            // Authored-OFF path: density > 0.5 fills offbeats by inverse metric
            // weight — but only on rows that have at least one authored on step,
            // so empty rows stay silent regardless of density.
            const hasAuthoredOn = track.steps
              .slice(0, track.length)
              .some((s) => s.on);
            if (hasAuthoredOn) {
              const fillProb = computeFillProb(modDensity, localStep, track.length);
              if (fillProb > 0 && Math.random() < fillProb) {
                gated = true;
              }
            }
          }
          ratchet = Math.max(1, Math.floor(step.ratchet));
          if (gated && trackRowRatchet > 0 && Math.random() < trackRowRatchet * 0.5) {
            ratchet = 2 + Math.floor(Math.random() * 7);
          }
          setOverlay(track.id, localStep, {
            on,
            velocity: v,
            pitch,
            gate: gateMutated,
            gated,
            ratchet,
          });
        }
        if (!gated) continue;
        const ties = tieLength(track, localStep);
        const baseTime = when + step.microTiming * rowStepDuration;
        const subDur = rowStepDuration / ratchet;
        const effectiveGate = gateMutated * ties;
        // Harmonic motion: apply the global scale-degree offset to melodic
        // tracks before quantize. Drum/empty tracks ignore it.
        const harmonicShift = melodic ? harmonicOffset : 0;
        // Role-based note resolution. Three paths depending on melodic slot
        // and the track's pitchInterp:
        //   - Chord master (slot 0): resolves its own voicing into a full
        //     chord (degree + extension + inversion + spread) AND publishes
        //     the result to the global chord context so followers can read it
        //     on subsequent ticks. Same-tick followers see this update because
        //     drum tracks come first in the iteration and slot 0 melodic is
        //     processed before slots 1+.
        //   - Followers in 'root-follow': single-note play of the chord
        //     context's root. step.pitch ignored.
        //   - Followers in 'chord-tone': single-note play of a chord-tone
        //     selected by step.pitch (index into the chord-master's intervals
        //     with octave wrap). harmonicShift is already baked into the
        //     chord context via the chord master's resolveChord call.
        //   - Followers in 'semitones': independent of the chord context —
        //     fall back to the Stage 4 behavior of resolving the track's own
        //     voicing against the scene scale. Useful for tracks that should
        //     stay rhythmic/melodic without auto-harmonizing.
        const stepVoicing = step.chordVoicing ?? track.defaultChordVoicing;
        let rootMidi: number | undefined;
        let voiceIntervals: number[] = [0];
        if (melodic) {
          if (isChordMaster) {
            // Stage 7: chord-aware mutation primitives. When mutation is up
            // AND the step has a real chord (degree > 0), roll for a per-
            // trigger harmonic mutation and uniformly pick one of four:
            // dropChordTone / borrowChord / shuffleInversion / shiftSpread.
            // The latter three change harmonic identity → published to the
            // chord context so followers walk the mutated chord.
            // dropChordTone is density-only on the chord master's audible
            // voicing; followers keep seeing the full chord. Under freeze,
            // we restore the previous cycle's mutated chord from the overlay
            // instead of re-rolling.
            let chordRoot: number;
            let chordIntervals: number[];
            let audibleIntervals: number[];
            let publishedVoicing = stepVoicing;
            const frozenChord = freeze
              ? getOverlay(track.id, localStep)?.chord
              : undefined;
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
                pitch + harmonicShift
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
                // Pad-type voices skip borrowChord (introduces atonal parallel-
                // mode notes that don't compose well with long-release tail
                // stacking — drop / shuffle / shift stay in-scene-scale).
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
                    pitch + harmonicShift
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
              // Pad-type voicing drift — fires every N chord-master triggers
              // independently of the mutation roll above. Re-resolves the
              // chord with a shuffled inversion or shifted spread on top of
              // whatever publishedVoicing currently holds (which may already
              // be a mutated voicing). When it fires it wipes any pending
              // drop from the mutation roll — drift output wins.
              if (
                !freeze &&
                track.source.kind === 'voice' &&
                isPadVoice(track.source.id) &&
                stepVoicing.degree > 0
              ) {
                const padCfg = voicePadConfig(track.source.id);
                if (padCfg && padCfg.voicingDriftEveryNTriggers > 0) {
                  const count = tickPadDrift(track.id);
                  if (
                    count % padCfg.voicingDriftEveryNTriggers === 0 &&
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
            rootMidi = chordRoot;
            voiceIntervals = track.source.kind === 'voice' ? audibleIntervals : [0];
            if (stepVoicing.degree > 0) {
              setChordContext({
                root: chordRoot,
                intervals: chordIntervals,
                voicing: publishedVoicing,
              });
            }
            if (!freeze) {
              attachChordToOverlay(track.id, localStep, {
                root: chordRoot,
                intervals: audibleIntervals,
                voicing: publishedVoicing,
              });
            }
          } else if (track.pitchInterp === 'root-follow') {
            rootMidi = getChordContext().root;
            voiceIntervals = [0];
          } else if (track.pitchInterp === 'chord-tone') {
            rootMidi = chordToneMidi(getChordContext(), pitch);
            voiceIntervals = [0];
          } else if (track.pitchInterp === 'scale-tone') {
            // Scale-tone: step.pitch is a scale-degree offset above the
            // current chord root, using the scene scale. Walks stay
            // diatonic to the scene but the anchor moves with the chord.
            // harmonicShift baked into chordContext.root already; don't
            // double-apply.
            const ctx = getChordContext();
            const baseDegree = scaleDegreeOf(ctx.root, rootNote, scale);
            rootMidi =
              baseDegree !== null
                ? quantize(rootNote, scale, baseDegree + pitch)
                : quantize(ctx.root, scale, pitch);
            voiceIntervals = [0];
          } else {
            // 'semitones' — independent, no chord-context follow.
            const chord = resolveChord(rootNote, scale, stepVoicing, pitch + harmonicShift);
            rootMidi = chord.root;
            voiceIntervals = track.source.kind === 'voice' ? chord.intervals : [0];
          }
          // Per-track octave shift: lets bass sit two octaves below the chord
          // master without per-step authoring, lets motifs sit above or below
          // chord master's range, etc. Applied after role resolution so every
          // path (chord master, follower modes) benefits.
          if (rootMidi !== undefined && track.octave !== 0) {
            rootMidi += track.octave * 12;
          }
        }
        const isInstrument = track.source.kind === 'instrument';
        const effectiveDeviceId = isInstrument
          ? resolveDeviceId(track.midi.portName, midiOutDeviceId)
          : null;
        const midiNoteDuration = Math.max(0.02, effectiveGate * rowStepDuration);
        // Row 0 mute split tail: chord context has been updated above (if the
        // step had a chord), but no audio fires. Same for any chord-master
        // that's deselected during a solo.
        if (track.mute) continue;
        if (anySolo && !track.solo) continue;
        for (let r = 0; r < ratchet; r++) {
          const t = baseTime + r * subDur;
          if (isInstrument) {
            if (!effectiveDeviceId) continue;
            let outNote: number;
            if (track.midi.note !== null) outNote = track.midi.note;
            else if (rootMidi !== undefined) outNote = rootMidi;
            else continue;
            sendMIDINote(
              effectiveDeviceId,
              track.midi.channel,
              outNote,
              v,
              t,
              midiNoteDuration
            );
          } else if (track.source.kind === 'voice') {
            // Gain stores 0..2 with unity at the dial center, but the LFO
            // pipeline clamps inside 0..1. Halve before modulating, restore
            // after — keeps swing symmetric around the knob's center.
            const modGain = modulated(track.gain / 2, lfos, track.id, 'gain') * 2;
            // fxSend dropped from this call — it's now driven continuously
            // by fxModulation.ts through the per-track filter graph's wet/dry
            // GainNodes. Same story for filter cutoff/resonance.
            samplePlayer.trigger(
              track.source.id,
              t,
              v * modGain,
              rootMidi,
              effectiveGate,
              rowStepDuration,
              voiceIntervals,
              modulated(track.pan, lfos, track.id, 'pan'),
              track.id
            );
          }
        }
      }
    });
  }, []);

  useEffect(() => {
    scheduler.setBpm(bpm);
  }, [bpm]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        togglePlayback();
        return;
      }

      const lower = e.key.toLowerCase();
      const mode = MODE_KEYS[lower];
      if (mode) {
        e.preventDefault();
        useSequencerStore.getState().setEditMode(mode);
        return;
      }

      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const store = useSequencerStore.getState();
      const sel = store.selectedStep;
      if (!sel) return;
      const track = store.tracks.find((t) => t.id === sel.trackId);
      const step = track?.steps[sel.index];
      if (!track || !step?.on) return;
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const editMode = store.editMode;
      if (editMode === 'velocity') {
        store.setStepVelocity(
          sel.trackId,
          sel.index,
          Math.max(0, Math.min(1, step.velocity + 0.05 * dir))
        );
      } else if (editMode === 'chance') {
        store.setStepProbability(
          sel.trackId,
          sel.index,
          Math.max(0, Math.min(100, step.probability + 5 * dir))
        );
      } else if (editMode === 'ratchet') {
        store.setStepRatchet(
          sel.trackId,
          sel.index,
          Math.max(1, Math.min(8, step.ratchet + dir))
        );
      } else if (editMode === 'timing') {
        store.setStepMicroTiming(
          sel.trackId,
          sel.index,
          Math.max(-0.5, Math.min(0.5, step.microTiming + 0.05 * dir))
        );
      } else if (editMode === 'gate') {
        store.setStepGate(
          sel.trackId,
          sel.index,
          Math.max(0.1, Math.min(2, step.gate + 0.05 * dir))
        );
      } else if (editMode === 'live' && sourceIsMelodic(track.source)) {
        store.setStepPitch(
          sel.trackId,
          sel.index,
          Math.max(-14, Math.min(14, step.pitch + dir))
        );
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="relative w-full">
      <main className="min-h-screen flex items-center justify-center px-10 py-12">
        <div className="flex flex-col gap-8 border border-white/15 rounded-[20px] p-10">
          <div className="flex justify-between items-center gap-8">
            <span className="text-[12px] uppercase tracking-[0.12em] opacity-55">
              <a href="/" className="hover:opacity-100 transition-opacity">newspeech</a>
              <span className="opacity-50"> | </span>
              <span>sequence</span>
              <span className="opacity-50"> | </span>
              <a href="/sequencer-readme.html" className="hover:opacity-100 transition-opacity">readme.txt</a>
            </span>
            <MacroStrip />
          </div>
          <div className="flex justify-between items-start gap-8">
            <StepInspector />
            <LFOPanel />
          </div>
          <div className="flex justify-between items-center gap-8 -my-4">
            <MidiBar />
            <BankPad />
          </div>
          <TrackGrid />
          <div className="flex justify-between items-center gap-8">
            <div className="transport flex items-center gap-6">
              <PlayButton />
              <TransportControls />
            </div>
            <div className="flex items-center gap-4">
              <SectionToggle />
              <span className="w-px h-6 bg-white/15" />
              <ModeSwitcher />
            </div>
          </div>
          <FXPanel />
        </div>
      </main>
    </div>
  );
}
