import { useEffect, useRef } from 'react';
import { useSequencerStore, type EditMode } from '../state/store';

function effectiveMode(
  e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  base: EditMode
): EditMode {
  if (e.shiftKey) return 'velocity';
  if (e.metaKey || e.ctrlKey) return 'chance';
  return base;
}

const HOVER_CAPABLE =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(hover: hover)').matches;

interface StepButtonProps {
  trackId: string;
  index: number;
  on: boolean;
  velocity: number;
  probability: number;
  isMelodic: boolean;
  isCurrent: boolean;
  size: number;
}

const PITCH_COOLDOWN_MS = 80;
const PITCH_MIN = -14;
const PITCH_MAX = 14;
const PROB_STEP = 5;
const VEL_STEP = 0.05;
const RATCHET_COOLDOWN_MS = 100;
const RATCHET_MIN = 1;
const RATCHET_MAX = 8;
const TIMING_STEP = 0.05;
const TIMING_MIN = -0.5;
const TIMING_MAX = 0.5;
const GATE_STEP = 0.05;
const GATE_MIN = 0.1;
const GATE_MAX = 2;
const DRAG_THRESHOLD_PX = 4;
const VEL_DRAG_PX_PER_UNIT = 100;
const PITCH_DRAG_PX_PER_DEGREE = 8;
const RATCHET_DRAG_PX_PER_UNIT = 14;
const TIMING_DRAG_PX_PER_UNIT = 100;
const GATE_DRAG_PX_PER_UNIT = 60;

export function StepButton({
  trackId,
  index,
  on,
  velocity,
  probability,
  isMelodic,
  isCurrent,
  size,
}: StepButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const didDragRef = useRef(false);

  const isSelected = useSequencerStore(
    (s) => s.selectedStep?.trackId === trackId && s.selectedStep?.index === index
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let lastPitchTime = 0;
    let lastRatchetTime = 0;
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

      if (mode === 'ratchet') {
        e.preventDefault();
        const now = performance.now();
        if (now - lastRatchetTime < RATCHET_COOLDOWN_MS) return;
        lastRatchetTime = now;
        const delta = e.deltaY > 0 ? -1 : 1;
        const next = Math.max(RATCHET_MIN, Math.min(RATCHET_MAX, s.ratchet + delta));
        if (next !== s.ratchet) store.setStepRatchet(trackId, index, next);
        return;
      }

      if (mode === 'timing') {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -TIMING_STEP : TIMING_STEP;
        const next = Math.max(TIMING_MIN, Math.min(TIMING_MAX, s.microTiming + delta));
        if (next !== s.microTiming) store.setStepMicroTiming(trackId, index, next);
        return;
      }

      if (mode === 'gate') {
        e.preventDefault();
        const delta = e.deltaY > 0 ? -GATE_STEP : GATE_STEP;
        const next = Math.max(GATE_MIN, Math.min(GATE_MAX, s.gate + delta));
        if (next !== s.gate) store.setStepGate(trackId, index, next);
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
    const startRatchet = s.ratchet;
    const startTiming = s.microTiming;
    const startGate = s.gate;

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
      } else if (mode === 'ratchet') {
        const units = Math.round(dy / RATCHET_DRAG_PX_PER_UNIT);
        const next = Math.max(RATCHET_MIN, Math.min(RATCHET_MAX, startRatchet + units));
        const cur = live.tracks.find((tr) => tr.id === trackId)?.steps[index].ratchet;
        if (next !== cur) live.setStepRatchet(trackId, index, next);
      } else if (mode === 'timing') {
        const next = Math.max(
          TIMING_MIN,
          Math.min(TIMING_MAX, startTiming + dy / TIMING_DRAG_PX_PER_UNIT)
        );
        live.setStepMicroTiming(trackId, index, next);
      } else if (mode === 'gate') {
        const next = Math.max(GATE_MIN, Math.min(GATE_MAX, startGate + dy / GATE_DRAG_PX_PER_UNIT));
        live.setStepGate(trackId, index, next);
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

  const handleClick = (e: React.MouseEvent) => {
    if (didDragRef.current) {
      didDragRef.current = false;
      return;
    }
    const store = useSequencerStore.getState();
    if (e.metaKey || e.ctrlKey) {
      store.toggleStep(trackId, index);
      return;
    }
    if (HOVER_CAPABLE) {
      store.setSelectedStep({ trackId, index });
      return;
    }
    if (store.selectedStep?.trackId === trackId && store.selectedStep.index === index) {
      store.setSelectedStep(null);
    } else {
      store.setSelectedStep({ trackId, index });
    }
  };

  const handleMouseEnter = HOVER_CAPABLE
    ? () => useSequencerStore.getState().setSelectedStep({ trackId, index })
    : undefined;

  const fillOpacity = 0.4 + 0.6 * (probability / 100);
  const fillHeightPct = Math.max(12, velocity * 100);

  const shadows: string[] = [];
  if (isCurrent) {
    shadows.push('0 0 0 2px #050505');
    shadows.push('0 0 0 4px rgb(255,255,255)');
  }
  if (isSelected) {
    shadows.push('0 0 14px 3px rgba(255,255,255,0.5)');
  }

  return (
    <button
      ref={ref}
      onMouseDown={handleMouseDown}
      onMouseEnter={handleMouseEnter}
      onClick={handleClick}
      aria-label={`step ${index + 1}`}
      className="relative overflow-hidden flex items-end justify-center transition-shadow"
      style={{
        width: size,
        height: size,
        boxShadow: shadows.length ? shadows.join(', ') : undefined,
      }}
    >
      <span className="absolute inset-0 bg-white/5" />
      {on && (
        <span
          className="absolute left-0 right-0 bottom-0 bg-white pointer-events-none"
          style={{ height: `${fillHeightPct}%`, opacity: fillOpacity }}
        />
      )}
    </button>
  );
}
