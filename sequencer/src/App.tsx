import { useEffect } from 'react';
import { PlayButton, TransportControls } from './components/Transport';
import { TrackGrid } from './components/TrackGrid';
import { StepInspector } from './components/StepInspector';
import { useSequencerStore, type EditMode, type Track } from './state/store';
import { scheduler } from './audio/scheduler';
import { samplePlayer } from './audio/samplePlayer';
import { quantize, octaveDegrees, fifthDegrees } from './audio/scale';
import { isMelodicVoice, voiceChord, voiceMutation } from './audio/voices';
import { setOverlay } from './audio/mutationOverlay';
import { morphStep, stepSeed } from './audio/morph';
import { effectiveTieToNext } from './audio/mutationTie';
import { togglePlayback } from './audio/transport';

const MODE_KEYS: Record<string, EditMode> = {
  n: 'note',
  v: 'velocity',
  c: 'chance',
  r: 'ratchet',
  t: 'timing',
  g: 'gate',
};

const MODES: EditMode[] = ['note', 'velocity', 'chance', 'ratchet', 'timing', 'gate'];

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
    return scheduler.onStep((globalStep, when, stepDuration) => {
      const { tracks, rootNote, scale } = useSequencerStore.getState();
      const anySolo = tracks.some((t) => t.solo);
      for (const track of tracks) {
        if (track.mute) continue;
        if (anySolo && !track.solo) continue;
        const localStep = globalStep % track.length;
        const authoredStep = track.steps[localStep];
        if (!authoredStep) continue;
        let step = authoredStep;
        if (track.slotA && track.slotB && track.morph > 0) {
          const a = track.slotA[localStep];
          const b = track.slotB[localStep];
          if (a && b) {
            step = morphStep(a, b, track.morph, stepSeed(track.id, localStep));
          }
        }
        const mut = track.mutation;
        const melodic = isMelodicVoice(track.voice);
        const profile = voiceMutation(track.voice);
        let on = step.on;
        if (mut > 0) {
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
          const total = w.octave + w.fifth + w.small;
          const r = Math.random() * total;
          let jump: number;
          if (r < w.octave) jump = Math.random() < 0.5 ? -oct : oct;
          else if (r < w.octave + w.fifth) jump = Math.random() < 0.5 ? -fifth : fifth;
          else {
            const small = [-3, -2, -1, 1, 2, 3];
            jump = small[Math.floor(Math.random() * small.length)];
          }
          pitch = Math.max(-14, Math.min(14, pitch + jump));
        }
        const gateBias = mut > 0 ? mut * profile.gateBias : 0;
        const gateJitter =
          mut > 0 ? (Math.random() - 0.5) * 2 * mut * profile.gateSpread : 0;
        const gateMutated = Math.max(0.1, Math.min(3, step.gate + gateBias + gateJitter));
        setOverlay(track.id, localStep, { on, velocity: v, pitch, gate: gateMutated });
        if (!on) continue;
        if (isSilencedByTie(track, localStep)) continue;
        const effectiveProb = step.probability * (1 - track.rowChance);
        if (effectiveProb < 100 && Math.random() * 100 >= effectiveProb) continue;
        const ties = tieLength(track, localStep);
        const baseTime = when + step.microTiming * stepDuration;
        let ratchet = Math.max(1, Math.floor(step.ratchet));
        if (track.rowRatchet > 0 && Math.random() < track.rowRatchet * 0.5) {
          ratchet = 2 + Math.floor(Math.random() * 7);
        }
        const subDur = stepDuration / ratchet;
        const effectiveGate = gateMutated * ties;
        const chordIntervals = melodic ? voiceChord(track.voice) : [0];
        const chordMidi = melodic
          ? chordIntervals.map((interval) => quantize(rootNote, scale, pitch + interval))
          : [undefined as number | undefined];
        for (let r = 0; r < ratchet; r++) {
          const t = baseTime + r * subDur;
          for (const m of chordMidi) {
            samplePlayer.trigger(track.voice, t, v, m, effectiveGate, stepDuration);
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
      } else if (editMode === 'note' && isMelodicVoice(track.voice)) {
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
      <header className="crumb absolute top-0 left-0 right-0 z-10">
        <span className="label">
          <a href="/">newspeech</a>
          <span className="sep"> / </span>sequence
        </span>
        <span className="aux">
          click selects · cmd-click toggles · drag/scroll adjusts active mode · shift = velocity · cmd = chance · space play/stop · n/v/c/r/t/g switch mode · ↑↓ nudge step
        </span>
      </header>
      <main className="min-h-screen flex items-center justify-center px-10 py-12">
        <div className="flex flex-col gap-8 w-[1394px] max-w-full">
          <div className="flex justify-between items-start gap-8">
            <StepInspector />
            <TransportControls />
          </div>
          <TrackGrid />
          <div className="flex justify-between items-center gap-8">
            <PlayButton />
            <ModeSwitcher />
          </div>
        </div>
      </main>
    </div>
  );
}
