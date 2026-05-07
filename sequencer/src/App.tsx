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
      <header className="flex items-baseline gap-6 px-8 py-6 border-b border-bone/10">
        <h1 className="text-2xl tracking-wide">NEWSPEECH // sequence</h1>
        <a
          href="/"
          className="text-xs uppercase tracking-widest opacity-60 hover:opacity-100"
        >
          ← home
        </a>
      </header>
      <main className="flex-1 flex flex-col items-center justify-center gap-12 px-8">
        <Transport />
        <TrackGrid />
      </main>
      <footer className="px-8 py-4 text-xs uppercase tracking-widest opacity-40">
        phase 1 — synth kick on a 16-step grid
      </footer>
    </div>
  );
}
