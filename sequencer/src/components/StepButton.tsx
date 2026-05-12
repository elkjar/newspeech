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
  ratchet: number;
  microTiming: number;
  gate: number;
  isMelodic: boolean;
  isCurrent: boolean;
  isTiedChain: boolean;
  size: number;
  // True when this step actually fired in the current cycle (overlay.gated).
  // Drives the binary "currently firing" visual in note view: thinned-out
  // authored ON cells go dark when not firing; filled-in authored OFF cells
  // light up when they do. Chance view ignores this and keeps the gradient.
  // Falls back to authored on/off when the sequencer isn't playing.
  cycleFired: boolean;
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
  ratchet,
  microTiming,
  gate,
  isMelodic,
  isCurrent,
  isTiedChain,
  size,
  cycleFired,
}: StepButtonProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const didDragRef = useRef(false);

  const isSelected = useSequencerStore(
    (s) => s.selectedStep?.trackId === trackId && s.selectedStep?.index === index
  );
  const isAnchor = useSequencerStore(
    (s) => s.tieAnchor?.trackId === trackId && s.tieAnchor?.index === index
  );
  const editMode = useSequencerStore((s) => s.editMode);

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

      if (mode === 'live' && isMelodic) {
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
    if (mode === 'live' && !isMelodic) return;

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
      } else if (mode === 'live') {
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
    if (e.shiftKey) {
      const anchor = store.tieAnchor;
      if (!anchor || anchor.trackId !== trackId || anchor.index === index) return;
      const track = store.tracks.find((t) => t.id === trackId);
      if (!track) return;
      // Tie is inert on drum rows backed by sample voices — the sample plays
      // its own envelope regardless of gate length, and "skip the next hit"
      // is already what toggling the step off does. Suppress the gesture so
      // it's not authoring data that has no audible effect.
      if (track.section === 'drum' && track.source.kind === 'voice') return;
      const start = Math.min(anchor.index, index);
      const end = Math.max(anchor.index, index);
      let allTied = true;
      for (let i = start; i < end; i++) {
        if (!track.steps[i]?.tieToNext) {
          allTied = false;
          break;
        }
      }
      const next = !allTied;
      for (let i = start; i < end; i++) {
        store.setStepTie(trackId, i, next);
      }
      store.setTieAnchor(null);
      return;
    }
    store.setTieAnchor({ trackId, index });
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

  let fillOpacity = 0;
  let label = '';
  if (on) {
    if (isTiedChain) {
      fillOpacity = (editMode === 'velocity' ? Math.max(0.15, velocity) : 1) * 0.5;
    } else {
      if (editMode === 'velocity') fillOpacity = Math.max(0.15, velocity);
      else if (editMode === 'chance') fillOpacity = Math.max(0.15, probability / 100);
      else if (editMode === 'live') fillOpacity = cycleFired ? 1 : 0;
      else fillOpacity = 1;

      if (editMode === 'ratchet') label = String(ratchet);
      else if (editMode === 'timing') {
        const pct = Math.round(microTiming * 100);
        label = pct === 0 ? '0' : pct > 0 ? `+${pct}%` : `${pct}%`;
      } else if (editMode === 'gate') {
        label = `${Math.round(gate * 100)}%`;
      }
    }
  } else if (editMode === 'chance') {
    // Chance view shows the fill-in probability gradient regardless of whether
    // the step actually fired this cycle — preserves "see the curve at a glance."
    if (probability > 0) fillOpacity = probability / 100;
  } else if (cycleFired) {
    // Note / velocity / etc. views: keep the "authored = bright, OFF = dark"
    // contract by only lighting filled steps when they actually fire this cycle.
    fillOpacity = 1;
  }

  const shadows: string[] = [];
  if (isCurrent) {
    shadows.push('0 0 0 2px #050505');
    shadows.push('0 0 0 4px rgb(255,255,255)');
  }
  if (isSelected) {
    shadows.push('0 0 0 1px rgba(255,255,255,0.4)');
  }

  return (
    <button
      ref={ref}
      onMouseDown={handleMouseDown}
      onMouseEnter={handleMouseEnter}
      onClick={handleClick}
      aria-label={`step ${index + 1}`}
      className="relative overflow-hidden flex items-center justify-center transition-shadow"
      style={{
        width: size,
        height: size,
        boxShadow: shadows.length ? shadows.join(', ') : undefined,
      }}
    >
      <span className="absolute inset-0 bg-white/5" />
      {(on || fillOpacity > 0) && (
        <span
          className="absolute inset-0 bg-white pointer-events-none"
          style={{ opacity: fillOpacity }}
        />
      )}
      {label && (
        <span
          className="relative tabular-nums select-none pointer-events-none font-bold"
          style={{
            mixBlendMode: 'difference',
            color: '#fff',
            fontSize: size <= 22 ? 8 : 10,
            lineHeight: 1,
          }}
        >
          {label}
        </span>
      )}
      {isAnchor && (
        <span className="absolute top-1 right-1 w-1.5 h-1.5 bg-white pointer-events-none" />
      )}
    </button>
  );
}
