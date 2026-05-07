import { useEffect, useRef } from 'react';
import { useSequencerStore, type EditMode } from '../state/store';
import { quantize, midiToName, type Scale } from '../audio/scale';

function effectiveMode(
  e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  base: EditMode
): EditMode {
  if (e.shiftKey) return 'velocity';
  if (e.metaKey || e.ctrlKey) return 'chance';
  return base;
}

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

const PITCH_COOLDOWN_MS = 80;
const PITCH_MIN = -14;
const PITCH_MAX = 14;
const PROB_STEP = 5;
const VEL_STEP = 0.05;
const DRAG_THRESHOLD_PX = 4;
const VEL_DRAG_PX_PER_UNIT = 100;
const PITCH_DRAG_PX_PER_DEGREE = 8;

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
  const didDragRef = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastPitchTime = 0;
    const handleWheel = (e: WheelEvent) => {
      const store = useSequencerStore.getState();
      const t = store.tracks.find((tr) => tr.id === trackId);
      if (!t) return;
      const s = t.steps[index];
      if (!s?.on) return;
      const mode = effectiveMode(e, store.editMode);

      if (mode === 'velocity') {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -VEL_STEP : VEL_STEP;
        const next = Math.max(0, Math.min(1, s.velocity + delta));
        if (next !== s.velocity) store.setStepVelocity(trackId, index, next);
        return;
      }

      if (mode === 'chance') {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -PROB_STEP : PROB_STEP;
        const next = Math.max(0, Math.min(100, s.probability + delta));
        if (next !== s.probability) store.setStepProbability(trackId, index, next);
        return;
      }

      if (mode === 'note' && isMelodic) {
        e.preventDefault();
        const now = performance.now();
        if (now - lastPitchTime < PITCH_COOLDOWN_MS) return;
        lastPitchTime = now;
        const delta = e.deltaY > 0 ? -1 : 1;
        const next = Math.max(PITCH_MIN, Math.min(PITCH_MAX, s.pitch + delta));
        if (next !== s.pitch) store.setStepPitch(trackId, index, next);
      }
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [trackId, index, isMelodic]);

  const handleMouseDown = (e: React.MouseEvent) => {
    didDragRef.current = false;
    const store = useSequencerStore.getState();
    const t = store.tracks.find((tr) => tr.id === trackId);
    if (!t) return;
    const s = t.steps[index];
    if (!s?.on) return;
    const mode = effectiveMode(e, store.editMode);
    if (mode === 'note' && !isMelodic) return;

    e.preventDefault();
    const startY = e.clientY;
    const startVel = s.velocity;
    const startPitch = s.pitch;
    const startProb = s.probability;

    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY;
      if (!didDragRef.current && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
      didDragRef.current = true;

      const live = useSequencerStore.getState();
      if (mode === 'velocity') {
        const next = Math.max(0, Math.min(1, startVel + dy / VEL_DRAG_PX_PER_UNIT));
        live.setStepVelocity(trackId, index, next);
      } else if (mode === 'chance') {
        const next = Math.max(0, Math.min(100, startProb + dy));
        live.setStepProbability(trackId, index, next);
      } else if (mode === 'note') {
        const degrees = Math.round(dy / PITCH_DRAG_PX_PER_DEGREE);
        const next = Math.max(PITCH_MIN, Math.min(PITCH_MAX, startPitch + degrees));
        if (next !== live.tracks.find((tr) => tr.id === trackId)?.steps[index].pitch) {
          live.setStepPitch(trackId, index, next);
        }
      }
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleClick = () => {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
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
