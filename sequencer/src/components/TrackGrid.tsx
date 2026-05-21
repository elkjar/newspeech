import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSequencerStore } from '../state/store';
import { scheduler } from '../audio/scheduler';
import { Track } from './Track';

const HOVER_CAPABLE =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(hover: hover)').matches;

export function TrackGrid() {
  // Encode {id, trackIndex} as a single string per visible row so useShallow
  // can compare element-wise via Object.is and skip parent re-render on
  // per-track mutations. Without this the parent re-rendered on every knob
  // drag frame, cascading into all visible Track children. trackIndex stays
  // the full-tracks-array index — MIDI-learn slot bindings are positional
  // against the full array, not the visible subset.
  const visibleKeys = useSequencerStore(
    useShallow((s) =>
      s.tracks.flatMap((t, i) =>
        t.section === s.viewSection ? [`${t.id}:${i}`] : []
      )
    )
  );
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
      {visibleKeys.map((key) => {
        const sep = key.lastIndexOf(':');
        const id = key.slice(0, sep);
        const trackIndex = Number(key.slice(sep + 1));
        return <Track key={id} trackId={id} trackIndex={trackIndex} />;
      })}
    </div>
  );
}
