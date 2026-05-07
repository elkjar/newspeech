import { useEffect } from 'react';
import { Transport } from './components/Transport';
import { TrackGrid } from './components/TrackGrid';
import { useSequencerStore } from './state/store';
import { scheduler } from './audio/scheduler';
import { samplePlayer } from './audio/samplePlayer';

export function App() {
  const bpm = useSequencerStore((s) => s.bpm);

  useEffect(() => {
    return scheduler.onStep((stepIndex, when) => {
      const { steps } = useSequencerStore.getState();
      const s = steps[stepIndex];
      if (s?.on) samplePlayer.trigger('kick', when, s.velocity);
    });
  }, []);

  useEffect(() => {
    scheduler.setBpm(bpm);
  }, [bpm]);

  return (
    <div className="h-full w-full flex flex-col">
      <header className="crumb">
        <span className="label">
          <a href="/">newspeech</a>
          <span className="sep"> / </span>sequence
        </span>
        <span className="aux">phase 1 — synth kick on a 16-step grid</span>
      </header>
      <main className="flex-1 flex flex-col items-center justify-center gap-12 px-[72px]">
        <Transport />
        <TrackGrid />
      </main>
    </div>
  );
}
