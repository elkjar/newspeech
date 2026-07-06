import { useEffect } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useSequencerStore, type Toast as ToastEntry } from '../state/store';

const NATIVE = isTauri();
const AUTO_DISMISS_MS = 5000;

function revealPathInFinder(path: string): void {
  if (!NATIVE) return;
  void invoke('reveal_in_finder', { path }).catch((err) => {
    console.warn('[toast] reveal_in_finder failed:', err);
  });
}

function ToastItem({ toast }: { toast: ToastEntry }) {
  const dismiss = useSequencerStore((s) => s.dismissToast);

  // Success toasts auto-dismiss after AUTO_DISMISS_MS. Errors are sticky.
  // Cleared on unmount so dismissing manually before the timer fires
  // doesn't leave a stale dismiss queued.
  useEffect(() => {
    if (toast.kind !== 'success') return;
    const id = window.setTimeout(() => dismiss(toast.id), AUTO_DISMISS_MS);
    return () => window.clearTimeout(id);
  }, [toast.id, toast.kind, dismiss]);

  const isError = toast.kind === 'error';
  return (
    <div
      className={[
        'flex items-center gap-3 px-3 py-2 border text-[11px] uppercase tracking-widest',
        'bg-[#0a0a0a]',
        isError ? 'border-white/60' : 'border-white/25',
      ].join(' ')}
      style={{ minWidth: 280, maxWidth: 480 }}
      role="status"
    >
      <span
        className="block"
        style={{
          width: 6,
          height: 6,
          background: isError ? 'rgba(255,255,255,0.85)' : 'rgba(255,255,255,0.55)',
        }}
      />
      <span className="flex-1 truncate">{toast.text}</span>
      {toast.revealPath && NATIVE && (
        <button
          onClick={() => {
            revealPathInFinder(toast.revealPath!);
            dismiss(toast.id);
          }}
          className="text-white/55 hover:text-white transition-colors"
        >
          reveal
        </button>
      )}
      <button
        onClick={() => dismiss(toast.id)}
        aria-label="dismiss"
        className="text-white/40 hover:text-white transition-colors"
        style={{ lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useSequencerStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div
      className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-2 pointer-events-none"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastItem toast={t} />
        </div>
      ))}
    </div>
  );
}
