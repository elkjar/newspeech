import { useSequencerStore, BANK_SLOT_COUNT } from '../state/store';

const PAD_SIZE = 36;
const PAD_GAP = 6;

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
        {Array.from({ length: BANK_SLOT_COUNT }, (_, i) => {
          const filled = !!banks[i];
          const isActive = activeBank === i;
          const isPending = pendingBank === i;
          const fillOpacity = isActive ? 1 : filled ? 0.25 : 0;
          return (
            <button
              key={i}
              onClick={(e) => {
                if (e.metaKey || e.ctrlKey) {
                  clearBank(i);
                  return;
                }
                if (e.shiftKey) {
                  snapBank(i);
                  return;
                }
                queueBank(i);
              }}
              style={{ width: PAD_SIZE, height: PAD_SIZE }}
              className="relative overflow-hidden flex items-center justify-center transition-shadow"
              title={
                filled
                  ? `pattern ${i + 1} — click to queue · shift-click to overwrite · cmd-click to clear`
                  : `pattern ${i + 1} — shift-click to save`
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
            </button>
          );
        })}
      </div>
    </div>
  );
}
