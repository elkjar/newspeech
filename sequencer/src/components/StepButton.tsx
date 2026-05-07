import { useEffect, useRef } from 'react';
import { useSequencerStore } from '../state/store';
import { quantize, midiToName, type Scale } from '../audio/scale';

interface StepButtonProps {
  trackId: string;
  index: number;
  on: boolean;
  pitch: number;
  isMelodic: boolean;
  isCurrent: boolean;
  rootNote: number;
  scale: Scale;
}

export function StepButton({
  trackId,
  index,
  on,
  pitch,
  isMelodic,
  isCurrent,
  rootNote,
  scale,
}: StepButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isMelodic) return;
    const el = ref.current;
    if (!el) return;
    const COOLDOWN_MS = 80;
    const PITCH_MIN = -14;
    const PITCH_MAX = 14;
    let lastStepTime = 0;
    const handleWheel = (e: WheelEvent) => {
      const { tracks, setStepPitch } = useSequencerStore.getState();
      const t = tracks.find((tr) => tr.id === trackId);
      if (!t) return;
      const s = t.steps[index];
      if (!s?.on) return;
      e.preventDefault();
      const now = performance.now();
      if (now - lastStepTime < COOLDOWN_MS) return;
      lastStepTime = now;
      const delta = e.deltaY > 0 ? -1 : 1;
      const next = Math.max(PITCH_MIN, Math.min(PITCH_MAX, s.pitch + delta));
      if (next !== s.pitch) setStepPitch(trackId, index, next);
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [trackId, index, isMelodic]);

  const noteLabel = isMelodic && on ? midiToName(quantize(rootNote, scale, pitch)) : '';

  return (
    <button
      ref={ref}
      onClick={() => useSequencerStore.getState().toggleStep(trackId, index)}
      aria-label={`step ${index + 1}`}
      className={[
        'relative w-10 h-10 transition-colors flex items-end justify-center',
        on ? 'bg-white hover:bg-white/85 text-ink' : 'bg-white/5 hover:bg-white/15',
        isCurrent ? 'ring-2 ring-white ring-offset-2 ring-offset-[#050505]' : '',
      ].join(' ')}
    >
      {noteLabel && (
        <span className="text-[9px] leading-none pb-1 tracking-tight tabular-nums select-none">
          {noteLabel}
        </span>
      )}
    </button>
  );
}
