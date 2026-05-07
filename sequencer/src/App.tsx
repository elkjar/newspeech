import { useEffect } from 'react';
import { Transport } from './components/Transport';
import { TrackGrid } from './components/TrackGrid';
import { useSequencerStore } from './state/store';
import { scheduler } from './audio/scheduler';
import { samplePlayer } from './audio/samplePlayer';
import { quantize } from './audio/scale';

export function App() {
  const bpm = useSequencerStore((s) => s.bpm);

  useEffect(() => {
    return scheduler.onStep((stepIndex, when) => {
      const { tracks, rootNote, scale } = useSequencerStore.getState();
      const anySolo = tracks.some((t) => t.solo);
      for (const track of tracks) {
        if (track.mute) continue;
        if (anySolo && !track.solo) continue;
        const step = track.steps[stepIndex];
        if (!step?.on) continue;
        const v = step.velocity * track.volume;
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
          phase 2 — 8 tracks · drum + melodic · scroll a melodic step to change pitch
        </span>
      </header>
      <main className="flex flex-col items-center gap-10 px-[72px] pt-12 pb-20">
        <Transport />
        <TrackGrid />
      </main>
    </div>
  );
}
