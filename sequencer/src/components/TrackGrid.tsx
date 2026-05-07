import { useEffect } from 'react';
import { useSequencerStore } from '../state/store';
import { scheduler } from '../audio/scheduler';
import { Track } from './Track';

export function TrackGrid() {
  const tracks = useSequencerStore((s) => s.tracks);
  const setGlobalStep = useSequencerStore((s) => s.setGlobalStep);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (scheduler.isPlaying()) {
        const audible = scheduler.getAudibleStep();
        if (audible !== null) setGlobalStep(audible);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [setGlobalStep]);

  return (
    <div className="flex flex-col gap-2">
      {tracks.map((track) => (
        <Track key={track.id} track={track} />
      ))}
    </div>
  );
}
