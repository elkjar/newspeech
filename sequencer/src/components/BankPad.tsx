import { useState } from 'react';
import {
  useSequencerStore,
  BANK_SLOT_COUNT,
  TRANSITION_SLOT_START,
} from '../state/store';
import { useMidiLearn } from '../hooks/useMidiLearn';
import type { MidiTarget } from '../midi/midiMap';

const PAD_SIZE = 36;
const PAD_GAP = 6;
const GAP_LINE_WIDTH = 1;

// Gap K = the insertion point BEFORE slot K. Valid range for scene-region
// drops is 0..TRANSITION_SLOT_START (inclusive at the upper bound — that's
// "append to end of scene region"). A move from `src` to gap K is a no-op
// when K == src or K == src+1 (the gap is immediately adjacent to source).
function isNoOpGap(src: number, gap: number): boolean {
  return gap === src || gap === src + 1;
}

// Slot the bank lands at, given source slot and target gap. Accounts for
// the source's removal shifting downstream slots left by 1.
function gapToSlot(src: number, gap: number): number {
  return gap > src ? gap - 1 : gap;
}

// Pixel X (relative to the pad row container) of gap K's center.
function gapLineX(k: number): number {
  return k * (PAD_SIZE + PAD_GAP) - PAD_GAP / 2;
}

function PadSlot({
  i,
  filled,
  isActive,
  isPending,
  isDragging,
  draggable,
  isSceneSlot,
  onShift,
  onClear,
  onPlain,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  i: number;
  filled: boolean;
  isActive: boolean;
  isPending: boolean;
  isDragging: boolean;
  draggable: boolean;
  isSceneSlot: boolean;
  onShift: () => void;
  onClear: () => void;
  onPlain: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const learn = useMidiLearn(`bank:queue:${i}` as MidiTarget);
  const fillOpacity = isActive ? 1 : filled ? 0.25 : 0;
  const handleClick = (e: React.MouseEvent) => {
    if (learn.onLearnClick) {
      learn.onLearnClick();
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      onClear();
      return;
    }
    if (e.shiftKey) {
      onShift();
      return;
    }
    onPlain();
  };
  const titleSuffix =
    learn.learning && learn.bindingLabel ? ` · ${learn.bindingLabel}` : '';
  return (
    <button
      onClick={handleClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={isSceneSlot ? onDragOver : undefined}
      onDrop={isSceneSlot ? onDrop : undefined}
      style={{ width: PAD_SIZE, height: PAD_SIZE, opacity: isDragging ? 0.3 : 1 }}
      className="relative overflow-hidden flex items-center justify-center transition-shadow"
      title={
        learn.isLearnTarget
          ? `pattern ${i + 1} — learning…`
          : filled
            ? `pattern ${i + 1} — click to queue · shift-click to overwrite · cmd-click to clear · drag to reorder${titleSuffix}`
            : `pattern ${i + 1} — click to start blank · shift-click to save current${titleSuffix}`
      }
    >
      <span className="absolute inset-0 bg-white/5" />
      {fillOpacity > 0 && (
        <span
          className="absolute inset-0 bg-white pointer-events-none"
          style={{ opacity: fillOpacity }}
        />
      )}
      {isPending && (
        <span className="absolute inset-0 bg-white pointer-events-none animate-pulse" />
      )}
      {learn.learning && (learn.isLearnTarget || learn.bound) && (
        <span
          className="absolute inset-0 pointer-events-none border border-white/70"
          style={{
            boxShadow: learn.isLearnTarget ? '0 0 0 1px #fff inset' : undefined,
          }}
        />
      )}
    </button>
  );
}

export function BankPad() {
  const banks = useSequencerStore((s) => s.banks);
  const activeBank = useSequencerStore((s) => s.activeBank);
  const pendingBank = useSequencerStore((s) => s.pendingBank);
  const snapBank = useSequencerStore((s) => s.snapBank);
  const queueBank = useSequencerStore((s) => s.queueBank);
  const clearBank = useSequencerStore((s) => s.clearBank);
  const moveBank = useSequencerStore((s) => s.moveBank);
  const startBlankBank = useSequencerStore((s) => s.startBlankBank);

  // Drag state. dragSource = the slot being dragged; dropGap = the
  // insertion point currently hovered (0..TRANSITION_SLOT_START). Only
  // scene-region slots participate; transition slots stay click-only.
  const [dragSource, setDragSource] = useState<number | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);

  const handlePadDragOver = (i: number, e: React.DragEvent) => {
    if (dragSource === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    // Left half of pad i → gap i (before pad i)
    // Right half of pad i → gap i+1 (after pad i)
    // When the preferred half lands on a no-op gap (immediately adjacent to
    // source), fall back to the other half so neighbors always show a valid
    // gap line regardless of which half the cursor is in. Without this,
    // hovering the wrong half of an adjacent pad silently kills the drag
    // feedback.
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const halfLeft = x < rect.width / 2;
    const preferred = halfLeft ? i : i + 1;
    const fallback = halfLeft ? i + 1 : i;
    let gap: number;
    if (!isNoOpGap(dragSource, preferred)) {
      gap = preferred;
    } else if (!isNoOpGap(dragSource, fallback)) {
      gap = fallback;
    } else {
      // Both halves are no-ops — hovering source itself. Clear the line.
      if (dropGap !== null) setDropGap(null);
      return;
    }
    if (dropGap !== gap) setDropGap(gap);
  };

  const handlePadDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (
      dragSource !== null &&
      dropGap !== null &&
      !isNoOpGap(dragSource, dropGap)
    ) {
      moveBank(dragSource, gapToSlot(dragSource, dropGap));
    }
    setDragSource(null);
    setDropGap(null);
  };

  const showGapLine =
    dragSource !== null && dropGap !== null && !isNoOpGap(dragSource, dropGap);

  return (
    <div className="flex items-center" style={{ gap: PAD_GAP * 2 }}>
      <span className="text-[11px] uppercase tracking-widest opacity-55">
        pattern
      </span>
      <div className="relative flex items-center" style={{ gap: PAD_GAP }}>
        {Array.from({ length: BANK_SLOT_COUNT }, (_, i) => {
          const filled = !!banks[i];
          const isSceneSlot = i < TRANSITION_SLOT_START;
          return (
            <PadSlot
              key={i}
              i={i}
              filled={filled}
              isActive={activeBank === i}
              isPending={pendingBank === i}
              isDragging={dragSource === i}
              draggable={filled && isSceneSlot}
              isSceneSlot={isSceneSlot}
              onShift={() => snapBank(i)}
              onClear={() => clearBank(i)}
              onPlain={() => (filled ? queueBank(i) : startBlankBank(i))}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(i));
                setDragSource(i);
              }}
              onDragEnd={() => {
                setDragSource(null);
                setDropGap(null);
              }}
              onDragOver={(e) => handlePadDragOver(i, e)}
              onDrop={handlePadDrop}
            />
          );
        })}
        {showGapLine && (
          <div
            className="absolute bg-white pointer-events-none"
            style={{
              left: gapLineX(dropGap!) - GAP_LINE_WIDTH / 2,
              top: 0,
              height: PAD_SIZE,
              width: GAP_LINE_WIDTH,
            }}
          />
        )}
      </div>
    </div>
  );
}
