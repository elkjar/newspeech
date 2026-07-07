import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useSequencerStore } from '../state/store';
import { sourceLabel } from '../instruments/library';
import {
  REPEAT_LADDER_LABELS,
  REPEAT_LADDER_TICKS,
  type LatchedEffect,
  activeSlot,
  armRepeat,
  nudgeSlotValue,
  performVersion,
  punchSlot,
  releaseRepeat,
  repeatHeldTicks,
  reverseOn,
  slotValues,
  subscribePerform,
  toggleReverse,
  toggleTrackMask,
  trackMaskEmpty,
  trackMaskHas,
} from '../audio/perform';

// PERFORM tab (docs/perform-mode.md P2) — mirrors the Tracker's perform
// screen: effect columns of 4 punchable value SLOTS (off + presets model)
// and the channel row — 16 even track pads — across the bottom. Engagement
// state is session-only in audio/perform.ts; slot VALUES persist as rig
// config (localStorage).
//
// Gestures: repeat slots are hold-to-punch (the catch-and-stick gesture,
// same as holding `r`); every other slot column latches (click on, click
// off — mouse can only hold one thing, and combining punches is the point);
// rev is a plain latch. The SET toggle flips the slots into assign mode:
// drag vertically (or scroll) on a slot to change its value; punching is
// suspended until set is off. Outside set mode values are LOCKED — an
// accidental wheel over a pad must never rewrite the rig.

const TRACK_PAD_COUNT = 16;
// Vertical drag pixels per value step in set mode.
const DRAG_PX_PER_STEP = 14;

// The latching effect columns, in workflow order — trigger-time mangles
// first, bus sends last (mix controls trail, per the control-layout
// convention).
const LATCH_COLUMNS: {
  key: LatchedEffect;
  header: string;
  fmt: (v: number) => string;
  title: string;
}[] = [
  {
    key: 'tune',
    header: 'tune',
    fmt: (v) => `${v > 0 ? '+' : ''}${v}`,
    title: 'tune punch (semitones, new notes only)',
  },
  {
    key: 'filter',
    header: 'filter',
    fmt: String,
    title: 'filter punch (absolute cutoff 0–100, bends ringing voices)',
  },
  {
    key: 'bits',
    header: 'bits',
    fmt: String,
    title: 'bit crush punch (new notes; only deepens an authored crush)',
  },
  {
    key: 'scrub',
    header: 'scrub',
    fmt: String,
    title:
      'sample-start scrub — each hit fires from a random point up to N% into the sample',
  },
  {
    key: 'chop',
    header: 'chop',
    fmt: String,
    title:
      'forced gate (% of step) — masked tracks turn staccato regardless of authored length',
  },
  {
    key: 'sat',
    header: 'sat',
    fmt: String,
    title:
      'saturation punch (new notes; only adds drive — tanh crushes past 50)',
  },
  {
    key: 'reverb',
    header: 'verb',
    fmt: String,
    title: 'reverb send punch (absolute 0–100, bends ringing voices)',
  },
  {
    key: 'delay',
    header: 'delay',
    fmt: String,
    title: 'delay send punch (absolute 0–100, bends ringing voices)',
  },
];

function Pad({
  label,
  sub,
  active,
  dimmed = false,
  disabled = false,
  hold = false,
  editing = false,
  onPunch,
  onRelease,
  onNudge,
  title,
  className = '',
}: {
  label: string;
  sub?: string;
  active: boolean;
  // "Implicit" state — the track row lights dimly when the empty mask means
  // ALL, so the effective selection is always visible.
  dimmed?: boolean;
  disabled?: boolean;
  // Momentary pads punch on pointerdown and release on pointerup/leave;
  // latching pads act on click.
  hold?: boolean;
  // Set mode: pointerdown starts a vertical drag-edit instead of punching.
  editing?: boolean;
  onPunch?: () => void;
  onRelease?: () => void;
  onNudge?: (dir: 1 | -1) => void;
  title?: string;
  className?: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const nudgeRef = useRef(onNudge);
  nudgeRef.current = onNudge;
  const editingRef = useRef(editing);
  editingRef.current = editing;

  // Wheel-edit needs a non-passive listener (React's root wheel handler is
  // passive, so preventDefault there can't stop the screen from scrolling).
  // Gated on SET mode — an idle mouse-wheel over a punch pad must never
  // silently rewrite a slot value.
  useEffect(() => {
    const el = ref.current;
    if (!el || !nudgeRef.current) return;
    const onWheel = (e: WheelEvent) => {
      if (!editingRef.current) return;
      e.preventDefault();
      nudgeRef.current?.(e.deltaY > 0 ? -1 : 1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const startDragEdit = (e: React.PointerEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    let applied = 0;
    const onMove = (ev: PointerEvent) => {
      const steps = Math.round((startY - ev.clientY) / DRAG_PX_PER_STEP);
      while (applied < steps) {
        nudgeRef.current?.(1);
        applied++;
      }
      while (applied > steps) {
        nudgeRef.current?.(-1);
        applied--;
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const editable = editing && !!onNudge;
  return (
    <button
      ref={ref}
      type="button"
      disabled={disabled}
      onPointerDown={
        editable
          ? startDragEdit
          : hold
            ? () => onPunch?.()
            : undefined
      }
      onPointerUp={!editable && hold ? () => onRelease?.() : undefined}
      onPointerLeave={!editable && hold ? () => onRelease?.() : undefined}
      onPointerCancel={!editable && hold ? () => onRelease?.() : undefined}
      onClick={!editable && !hold ? () => onPunch?.() : undefined}
      onContextMenu={(e) => e.preventDefault()}
      title={title}
      className={[
        'border text-[10px] uppercase tracking-widest transition-colors select-none flex flex-col items-center justify-center gap-0 min-w-0',
        editable ? 'cursor-ns-resize' : '',
        disabled
          ? 'border-white/10 text-white/20 cursor-default'
          : active
            ? 'bg-white text-ink border-white'
            : editable
              ? 'border-dashed border-white/40 text-white/80'
              : dimmed
                ? 'bg-white/15 text-white/80 border-white/40'
                : 'border-white/20 text-white/60 hover:text-white hover:border-white',
        className,
      ].join(' ')}
    >
      <span className="truncate max-w-full px-1">{label}</span>
      {sub !== undefined && (
        <span className="truncate max-w-full px-1 text-[8px] tracking-[0.14em] opacity-70">
          {sub}
        </span>
      )}
    </button>
  );
}

function ColumnHeader({ children }: { children: string }) {
  return (
    <span className="text-[10px] uppercase tracking-[0.2em] opacity-50 text-center">
      {children}
    </span>
  );
}

export function PerformPanel() {
  useSyncExternalStore(subscribePerform, performVersion);
  const tracks = useSequencerStore((s) => s.tracks);
  // Assign mode — a panel-local view state, not perform state: it only
  // changes what the pads' pointer gestures do.
  const [setMode, setSetMode] = useState(false);

  const slots = slotValues();
  const heldTicks = repeatHeldTicks();
  const maskEmpty = trackMaskEmpty();

  return (
    <div className="h-full p-3 flex flex-col gap-3 relative">
      {/* Assign-mode toggle — modifier weight (text-only labeled circle),
          not a chunky punch control. */}
      <button
        type="button"
        onClick={() => setSetMode((v) => !v)}
        className="absolute top-3 right-4 flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] bg-transparent border-0 text-white/70 hover:text-white transition-colors"
        title="assign mode — drag or scroll on a slot to change its value; punching pauses while on"
      >
        <span>{setMode ? '●' : '○'}</span>
        <span>set</span>
      </button>

      {/* Effect columns — 4 value slots each, Tracker-style. */}
      <div className="flex-1 flex items-start justify-center gap-4">
        <div className="flex flex-col gap-1.5">
          <ColumnHeader>repeat</ColumnHeader>
          {slots.repeat.map((ladderIdx, i) => (
            <Pad
              key={i}
              label={REPEAT_LADDER_LABELS[ladderIdx]}
              active={heldTicks === REPEAT_LADDER_TICKS[ladderIdx]}
              hold
              editing={setMode}
              onPunch={() => armRepeat(ladderIdx)}
              onRelease={() => releaseRepeat()}
              onNudge={(dir) => nudgeSlotValue('repeat', i, dir)}
              title="beat repeat — hold to punch in · set: drag/scroll for length"
              className="w-14 h-9"
            />
          ))}
        </div>
        <div className="flex flex-col gap-1.5">
          <ColumnHeader>rev</ColumnHeader>
          <Pad
            label="rev"
            active={reverseOn()}
            onPunch={toggleReverse}
            title="play new triggers on masked tracks as reverse one-shots"
            className="w-14 h-9"
          />
        </div>
        {LATCH_COLUMNS.map((col) => (
          <div key={col.key} className="flex flex-col gap-1.5">
            <ColumnHeader>{col.header}</ColumnHeader>
            {slots[col.key].map((value, i) => (
              <Pad
                key={i}
                label={col.fmt(value)}
                active={activeSlot(col.key) === i}
                editing={setMode}
                onPunch={() => punchSlot(col.key, i)}
                onNudge={(dir) => nudgeSlotValue(col.key, i, dir)}
                title={`${col.title} — click to latch · set: drag/scroll`}
                className="w-14 h-9"
              />
            ))}
          </div>
        ))}
      </div>

      {/* Channel row — 16 even pads, the hardware's core gesture. Empty
          selection = ALL tracks (every pad lights dim). */}
      <div className="grid grid-cols-[repeat(16,minmax(0,1fr))] gap-1">
        {Array.from({ length: TRACK_PAD_COUNT }, (_, i) => {
          const t = tracks[i];
          if (!t) {
            return (
              <Pad key={`empty-${i}`} label={`${i + 1}`} active={false} disabled className="h-10" />
            );
          }
          return (
            <Pad
              key={t.id}
              label={`${i + 1}`}
              sub={t.source.kind === 'empty' ? '—' : sourceLabel(t.source)}
              active={trackMaskHas(t.id)}
              dimmed={maskEmpty}
              onPunch={() => toggleTrackMask(t.id)}
              title="toggle this track in the punch-in mask (none selected = all)"
              className="h-10"
            />
          );
        })}
      </div>
    </div>
  );
}
