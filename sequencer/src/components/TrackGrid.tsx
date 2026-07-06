import { useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSequencerStore } from '../state/store';
import { scheduler } from '../audio/scheduler';
import { Track } from './Track';

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

  useEffect(() => {
    let raf = 0;
    // The audible 32nd-step only changes ~16-32×/s but this RAF runs at
    // 60-120Hz — the store `set` is unguarded, so an unconditional write
    // re-ran every globalStep subscriber per frame. Skip unchanged values.
    let lastSent: number | null = null;
    const tick = () => {
      if (scheduler.isPlaying()) {
        const audible = scheduler.getAudibleStep();
        if (audible !== null && audible !== lastSent) {
          lastSent = audible;
          setGlobalStep(audible);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [setGlobalStep]);

  return (
    <div className="flex flex-col gap-2">
      {visibleKeys.map((key) => {
        const sep = key.lastIndexOf(':');
        const id = key.slice(0, sep);
        const trackIndex = Number(key.slice(sep + 1));
        return <Track key={id} trackId={id} trackIndex={trackIndex} />;
      })}
    </div>
  );
}
