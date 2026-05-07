import { useEffect, useRef } from 'react';
import { useSequencerStore } from '../state/store';
import { quantize, midiToName, type Scale } from '../audio/scale';

interface StepButtonProps {
  trackId: string;
  index: number;
  on: boolean;
  pitch: number;
  velocity: number;
  probability: number;
  isMelodic: boolean;
  isCurrent: boolean;
  rootNote: number;
  scale: Scale;
  size: number;
}

const VELOCITY_DRAG_RANGE_PX = 100;
const PITCH_COOLDOWN_MS = 80;
const PITCH_MIN = -14;
const PITCH_MAX = 14;
const PROB_STEP = 5;

export function StepButton({
  trackId,
  index,
  on,
  pitch,
  velocity,
  probability,
  isMelodic,
  isCurrent,
  rootNote,
  scale,
  size,
}: StepButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastPitchTime = 0;
    const handleWheel = (e: WheelEvent) => {
      const { tracks, setStepPitch, setStepProbability } = useSequencerStore.getState();
      const t = tracks.find((tr) => tr.id === trackId);
      if (!t) return;
      const s = t.steps[index];
      if (!s?.on) return;

      if (e.altKey) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -PROB_STEP : PROB_STEP;
        const next = Math.max(0, Math.min(100, s.probability + delta));
        if (next !== s.probability) setStepProbability(trackId, index, next);
        return;
      }

      if (!isMelodic) return;
      e.preventDefault();
      const now = performance.now();
      if (now - lastPitchTime < PITCH_COOLDOWN_MS) return;
      lastPitchTime = now;
      const delta = e.deltaY > 0 ? -1 : 1;
      const next = Math.max(PITCH_MIN, Math.min(PITCH_MAX, s.pitch + delta));
      if (next !== s.pitch) setStepPitch(trackId, index, next);
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [trackId, index, isMelodic]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (!e.shiftKey) return;
    const { tracks } = useSequencerStore.getState();
    const t = tracks.find((tr) => tr.id === trackId);
    if (!t) return;
    const s = t.steps[index];
    if (!s?.on) return;
    e.preventDefault();
    const startY = e.clientY;
    const startVel = s.velocity;
    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY;
      const next = Math.max(0, Math.min(1, startVel + dy / VELOCITY_DRAG_RANGE_PX));
      useSequencerStore.getState().setStepVelocity(trackId, index, next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleClick = (e: React.MouseEvent) => {
    if (e.shiftKey) return;
    useSequencerStore.getState().toggleStep(trackId, index);
  };

  const noteLabel = isMelodic && on ? midiToName(quantize(rootNote, scale, pitch)) : '';
  const showLabel = on && size >= 24;
  const fillOpacity = 0.4 + 0.6 * (probability / 100);
  const fillHeightPct = Math.max(12, velocity * 100);

  return (
    <button
      ref={ref}
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      aria-label={`step ${index + 1}`}
      className={[
        'relative overflow-hidden flex items-end justify-center',
        'transition-shadow',
        isCurrent ? 'ring-2 ring-white ring-offset-2 ring-offset-[#050505]' : '',
      ].join(' ')}
      style={{ width: size, height: size }}
    >
      <span className="absolute inset-0 bg-white/5" />
      {on && (
        <span
          className="absolute left-0 right-0 bottom-0 bg-white pointer-events-none"
          style={{ height: `${fillHeightPct}%`, opacity: fillOpacity }}
        />
      )}
      {showLabel && noteLabel && (
        <span
          className="relative text-[9px] leading-none pb-1 tracking-tight tabular-nums select-none pointer-events-none"
          style={{ mixBlendMode: 'difference', color: '#fff' }}
        >
          {noteLabel}
        </span>
      )}
    </button>
  );
}
