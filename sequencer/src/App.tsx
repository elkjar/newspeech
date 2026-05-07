import { useEffect } from 'react';
import { PlayButton, TransportControls } from './components/Transport';
import { TrackGrid } from './components/TrackGrid';
import { StepInspector } from './components/StepInspector';
import { useSequencerStore, type EditMode, type Track } from './state/store';
import { scheduler } from './audio/scheduler';
import { samplePlayer } from './audio/samplePlayer';
import { quantize } from './audio/scale';
import { isMelodicVoice } from './audio/voices';

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
    const s = track.steps[cur];
    if (!s?.tieToNext) return false;
    if (s.on) return true;
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
    if (!track.steps[cur]?.tieToNext) break;
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
        const step = track.steps[localStep];
        if (!step?.on) continue;
        if (isSilencedByTie(track, localStep)) continue;
        if (step.probability < 100 && Math.random() * 100 >= step.probability) continue;
        const ties = tieLength(track, localStep);
        const v = step.velocity;
        const baseTime = when + step.microTiming * stepDuration;
        const ratchet = Math.max(1, Math.floor(step.ratchet));
        const subDur = stepDuration / ratchet;
        const effectiveGate = step.gate * ties;
        const melodic = isMelodicVoice(track.voice);
        const midi = melodic ? quantize(rootNote, scale, step.pitch) : undefined;
        for (let r = 0; r < ratchet; r++) {
          const t = baseTime + r * subDur;
          samplePlayer.trigger(track.voice, t, v, midi, effectiveGate, stepDuration);
        }
      }
    });
  }, []);

  useEffect(() => {
    scheduler.setBpm(bpm);
  }, [bpm]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      const store = useSequencerStore.getState();
      const sel = store.selectedStep;
      if (!sel) return;
      const track = store.tracks.find((t) => t.id === sel.trackId);
      const step = track?.steps[sel.index];
      if (!track || !step?.on) return;
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const mode = store.editMode;
      if (mode === 'velocity') {
        store.setStepVelocity(
          sel.trackId,
          sel.index,
          Math.max(0, Math.min(1, step.velocity + 0.05 * dir))
        );
      } else if (mode === 'chance') {
        store.setStepProbability(
          sel.trackId,
          sel.index,
          Math.max(0, Math.min(100, step.probability + 5 * dir))
        );
      } else if (mode === 'ratchet') {
        store.setStepRatchet(
          sel.trackId,
          sel.index,
          Math.max(1, Math.min(8, step.ratchet + dir))
        );
      } else if (mode === 'timing') {
        store.setStepMicroTiming(
          sel.trackId,
          sel.index,
          Math.max(-0.5, Math.min(0.5, step.microTiming + 0.05 * dir))
        );
      } else if (mode === 'gate') {
        store.setStepGate(
          sel.trackId,
          sel.index,
          Math.max(0.1, Math.min(2, step.gate + 0.05 * dir))
        );
      } else if (mode === 'note' && isMelodicVoice(track.voice)) {
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
          click selects · cmd-click toggles · drag/scroll adjusts active mode · shift = velocity · cmd = chance
        </span>
      </header>
      <main className="min-h-screen flex items-center justify-center px-[72px] py-12">
        <div className="flex flex-col gap-8 w-[1222px] max-w-full">
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
