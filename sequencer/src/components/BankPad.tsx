import { useSequencerStore, BANK_SLOT_COUNT } from '../state/store';
import { useMidiLearn } from '../hooks/useMidiLearn';
import type { MidiTarget } from '../midi/midiMap';

const PAD_SIZE = 36;
const PAD_GAP = 6;

function PadSlot({
  i,
  filled,
  isActive,
  isPending,
  onShift,
  onClear,
  onPlain,
}: {
  i: number;
  filled: boolean;
  isActive: boolean;
  isPending: boolean;
  onShift: () => void;
  onClear: () => void;
  onPlain: () => void;
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
      style={{ width: PAD_SIZE, height: PAD_SIZE }}
      className="relative overflow-hidden flex items-center justify-center transition-shadow"
      title={
        learn.isLearnTarget
          ? `pattern ${i + 1} — learning…`
          : filled
            ? `pattern ${i + 1} — click to queue · shift-click to overwrite · cmd-click to clear${titleSuffix}`
            : `pattern ${i + 1} — shift-click to save${titleSuffix}`
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

  return (
    <div className="flex items-center" style={{ gap: PAD_GAP * 2 }}>
      <span className="text-[11px] uppercase tracking-widest opacity-55">
        pattern
      </span>
      <div className="flex items-center" style={{ gap: PAD_GAP }}>
        {Array.from({ length: BANK_SLOT_COUNT }, (_, i) => (
          <PadSlot
            key={i}
            i={i}
            filled={!!banks[i]}
            isActive={activeBank === i}
            isPending={pendingBank === i}
            onShift={() => snapBank(i)}
            onClear={() => clearBank(i)}
            onPlain={() => queueBank(i)}
          />
        ))}
      </div>
    </div>
  );
}
