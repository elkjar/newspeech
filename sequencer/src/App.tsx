import { useEffect } from 'react';
import { Transport } from './components/Transport';
import { TrackGrid } from './components/TrackGrid';
import { StepInspector } from './components/StepInspector';
import { useSequencerStore, type EditMode } from './state/store';
import { scheduler } from './audio/scheduler';
import { samplePlayer } from './audio/samplePlayer';
import { quantize } from './audio/scale';

const MODES: EditMode[] = ['note', 'velocity', 'chance'];

function ModeSwitcher() {
  const editMode = useSequencerStore((s) => s.editMode);
  const setEditMode = useSequencerStore((s) => s.setEditMode);
  return (
    <div className="fixed top-[64px] right-[72px] z-10 flex gap-2 text-[11px] uppercase tracking-widest">
      {MODES.map((m) => (
        <button
          key={m}
          onClick={() => setEditMode(m)}
          className={[
            'px-3 py-1.5 border transition-colors',
            editMode === m
              ? 'bg-white text-ink border-white'
              : 'border-white/30 text-white/60 hover:text-white hover:border-white/70',
          ].join(' ')}
        >
          {m}
        </button>
      ))}
    </div>
  );
}

export function App() {
  const bpm = useSequencerStore((s) => s.bpm);

  useEffect(() => {
    return scheduler.onStep((globalStep, when) => {
      const { tracks, rootNote, scale } = useSequencerStore.getState();
      const anySolo = tracks.some((t) => t.solo);
      for (const track of tracks) {
        if (track.mute) continue;
        if (anySolo && !track.solo) continue;
        const localStep = globalStep % track.length;
        const step = track.steps[localStep];
        if (!step?.on) continue;
        if (step.probability < 100 && Math.random() * 100 >= step.probability) continue;
        const v = step.velocity;
        if (track.type === 'melodic') {
          const midi = quantize(rootNote, scale, step.pitch);
          samplePlayer.trigger(track.voice, when, v, midi);
        } else {
          samplePlayer.trigger(track.voice, when, v);
        }
      }
    });
  }, []);

  useEffect(() => {
    scheduler.setBpm(bpm);
  }, [bpm]);

  return (
    <div className="min-h-full w-full flex flex-col">
      <header className="crumb">
        <span className="label">
          <a href="/">newspeech</a>
          <span className="sep"> / </span>sequence
        </span>
        <span className="aux">
          phase 3 — click selects · cmd-click toggles · drag/scroll adjusts active mode · shift = velocity · cmd = chance
        </span>
      </header>
      <ModeSwitcher />
      <main className="flex flex-col items-center gap-10 px-[72px] pt-12 pb-20">
        <div className="flex items-center gap-8 flex-wrap justify-center">
          <Transport />
          <StepInspector />
        </div>
        <TrackGrid />
      </main>
    </div>
  );
}
