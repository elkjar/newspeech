import { useEffect } from 'react';
import { useSequencerStore } from '../state/store';
import { scheduler } from '../audio/scheduler';
import { Track } from './Track';

export function TrackGrid() {
  const tracks = useSequencerStore((s) => s.tracks);
  const setCurrentStep = useSequencerStore((s) => s.setCurrentStep);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      if (scheduler.isPlaying()) {
        const audible = scheduler.getAudibleStep();
        if (audible !== null) setCurrentStep(audible);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [setCurrentStep]);

  return (
    <div className="flex flex-col gap-2">
      {tracks.map((track) => (
        <Track key={track.id} track={track} />
      ))}
    </div>
  );
}
