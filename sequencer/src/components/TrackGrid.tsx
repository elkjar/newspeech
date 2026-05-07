import { useEffect } from 'react';
import { useSequencerStore } from '../state/store';
import { scheduler } from '../audio/scheduler';
import { Track } from './Track';

const HOVER_CAPABLE =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(hover: hover)').matches;

export function TrackGrid() {
  const tracks = useSequencerStore((s) => s.tracks);
  const setGlobalStep = useSequencerStore((s) => s.setGlobalStep);
  const setSelectedStep = useSequencerStore((s) => s.setSelectedStep);

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

  const handleMouseLeave = HOVER_CAPABLE ? () => setSelectedStep(null) : undefined;

  return (
    <div className="flex flex-col gap-2" onMouseLeave={handleMouseLeave}>
      {tracks.map((track) => (
        <Track key={track.id} track={track} />
      ))}
    </div>
  );
}
