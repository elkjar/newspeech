import { useEffect } from 'react';
import { PlayButton, TransportControls } from './components/Transport';
import { TrackGrid } from './components/TrackGrid';
import { StepInspector } from './components/StepInspector';
import { LFOPanel } from './components/LFOPanel';
import { MacroStrip } from './components/MacroStrip';
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
import { quantize, octaveDegrees, fifthDegrees } from './audio/scale';
import {
  sourceChord,
  sourceIsMelodic,
  sourceMutation,
} from './instruments/library';
import { setOverlay } from './audio/mutationOverlay';
import { morphStep, stepSeed } from './audio/morph';
import { effectiveTieToNext } from './audio/mutationTie';
import { modulated, GLOBAL_TRACK_ID } from './audio/lfo';
import { makeHarmonicMotionState, tickHarmonicMotion } from './audio/harmonicMotion';
import { togglePlayback } from './audio/transport';

const MODE_KEYS: Record<string, EditMode> = {
  '1': 'note',
  '2': 'velocity',
  '3': 'chance',
  '4': 'ratchet',
  '5': 'timing',
  '6': 'gate',
};

const MODES: EditMode[] = ['note', 'velocity', 'chance', 'ratchet', 'timing', 'gate'];

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
  }, []);

  useEffect(() => {
    const harmonic = makeHarmonicMotionState();
    return scheduler.onStep((globalStep, when, stepDuration) => {
      const { tracks, rootNote, scale, lfos, midiOutDeviceId, density, chaos, motion, drift, tension } =
        useSequencerStore.getState();
      // Macros may themselves be LFO-modulated. LFOs run at their natural rates
      // (motion no longer scales them) so we pass rateMul=1 across the board.
      const modMotion = modulated(motion, lfos, GLOBAL_TRACK_ID, 'motion', undefined, 1);
      const modDrift = modulated(drift, lfos, GLOBAL_TRACK_ID, 'drift', undefined, 1);
      const modDensity = modulated(density, lfos, GLOBAL_TRACK_ID, 'density', undefined, 1);
      const modChaos = modulated(chaos, lfos, GLOBAL_TRACK_ID, 'chaos', undefined, 1);
      const modTension = modulated(tension, lfos, GLOBAL_TRACK_ID, 'tension', undefined, 1);
      const DENSITY_FLOOR = 0.19;
      const densityMul = (DENSITY_FLOOR + modDensity * (1 - DENSITY_FLOOR)) * 2;
      const chaosMul = modChaos * 2;
      const tBipolar = (modTension - 0.5) * 2;
      const tStableMul = Math.max(0, 1 - tBipolar);
      const tColorMul = Math.max(0, 1 + tBipolar);
      const harmonicOffset = tickHarmonicMotion(
        harmonic,
        globalStep,
        modMotion,
        modDrift,
        octaveDegrees(scale)
      );
      const anySolo = tracks.some((t) => t.solo);
      for (const track of tracks) {
        if (track.mute) continue;
        if (anySolo && !track.solo) continue;
        const stride = RATE_STRIDE[track.rate];
        if (globalStep % stride !== 0) continue;
        const rowStep = Math.floor(globalStep / stride);
        const localStep = rowStep % track.length;
        const authoredStep = track.steps[localStep];
        if (!authoredStep) continue;
        const rowStepDuration = stepDuration * stride;
        const trackMut = modulated(track.mutation, lfos, track.id, 'mutation') * chaosMul;
        const trackMorph = modulated(track.morph, lfos, track.id, 'morph');
        const trackRowChance = modulated(track.rowChance, lfos, track.id, 'rowChance');
        const trackRowRatchet = modulated(track.rowRatchet, lfos, track.id, 'rowRatchet');
        let step = authoredStep;
        if (track.slotA && track.slotB) {
          const a = track.slotA[localStep];
          const b = track.slotB[localStep];
          if (a && b) {
            step = morphStep(a, b, trackMorph, stepSeed(track.id, localStep));
          }
        }
        const mut = trackMut;
        if (track.source.kind === 'empty') continue;
        const melodic = sourceIsMelodic(track.source);
        const profile = sourceMutation(track.source);
        let on = step.on;
        if (mut > 0 && !track.lockTiming) {
          let flipChance = mut * profile.flipChance;
          if (!step.on && profile.stepWeights && profile.stepWeights.length > 0) {
            flipChance *= profile.stepWeights[localStep % profile.stepWeights.length];
          }
          if (flipChance > 0 && Math.random() < flipChance) on = !on;
        }
        const velJitter =
          mut > 0 ? (Math.random() - 0.5) * 2 * mut * profile.velSpread : 0;
        const v = Math.max(0, Math.min(1, step.velocity + velJitter));
        let pitch = step.pitch;
        if (melodic && mut > 0 && Math.random() < mut * profile.pitchJumpProb) {
          const oct = octaveDegrees(scale);
          const fifth = fifthDegrees(scale);
          const w = profile.pitchWeights;
          const eOct = w.octave * tStableMul;
          const eFifth = w.fifth * tStableMul;
          const eSmall = w.small * tColorMul;
          const total = eOct + eFifth + eSmall;
          if (total > 0) {
            const r = Math.random() * total;
            let jump: number;
            if (r < eOct) jump = Math.random() < 0.5 ? -oct : oct;
            else if (r < eOct + eFifth) jump = Math.random() < 0.5 ? -fifth : fifth;
            else {
              const small = [-3, -2, -1, 1, 2, 3];
              jump = small[Math.floor(Math.random() * small.length)];
            }
            pitch = Math.max(-14, Math.min(14, pitch + jump));
          }
        }
        const gateBias = mut > 0 ? mut * profile.gateBias : 0;
        const gateJitter =
          mut > 0 ? (Math.random() - 0.5) * 2 * mut * profile.gateSpread : 0;
        const gateMutated = Math.max(0.1, Math.min(3, step.gate + gateBias + gateJitter));
        setOverlay(track.id, localStep, { on, velocity: v, pitch, gate: gateMutated });
        if (!on) continue;
        if (isSilencedByTie(track, localStep)) continue;
        const effectiveProb = step.probability * (1 - trackRowChance) * densityMul;
        if (effectiveProb < 100 && Math.random() * 100 >= effectiveProb) continue;
        const ties = tieLength(track, localStep);
        const baseTime = when + step.microTiming * rowStepDuration;
        let ratchet = Math.max(1, Math.floor(step.ratchet));
        if (trackRowRatchet > 0 && Math.random() < trackRowRatchet * 0.5) {
          ratchet = 2 + Math.floor(Math.random() * 7);
        }
        const subDur = rowStepDuration / ratchet;
        const effectiveGate = gateMutated * ties;
        const chordIntervals = melodic ? sourceChord(track.source) : [0];
        // Harmonic motion: apply the global scale-degree offset to melodic
        // tracks before quantize. Drum/empty tracks ignore it.
        const harmonicShift = melodic ? harmonicOffset : 0;
        const chordMidi = melodic
          ? chordIntervals.map((interval) =>
              quantize(rootNote, scale, pitch + interval + harmonicShift)
            )
          : [undefined as number | undefined];
        const isInstrument = track.source.kind === 'instrument';
        const effectiveDeviceId = isInstrument
          ? resolveDeviceId(track.midi.portName, midiOutDeviceId)
          : null;
        const midiNoteDuration = Math.max(0.02, effectiveGate * rowStepDuration);
        for (let r = 0; r < ratchet; r++) {
          const t = baseTime + r * subDur;
          for (const m of chordMidi) {
            if (isInstrument) {
              if (!effectiveDeviceId) continue;
              let outNote: number;
              if (track.midi.note !== null) outNote = track.midi.note;
              else if (m !== undefined) outNote = m;
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
              samplePlayer.trigger(track.source.id, t, v, m, effectiveGate, rowStepDuration);
            }
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
      } else if (editMode === 'note' && sourceIsMelodic(track.source)) {
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
            </span>
            <MacroStrip />
          </div>
          <div className="flex justify-between items-start gap-8">
            <StepInspector />
            <LFOPanel />
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
        </div>
      </main>
    </div>
  );
}
