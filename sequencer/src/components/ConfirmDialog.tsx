import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

// Centered modal confirmation dialog matching the visualizer-panel aesthetic.
// Renders into document.body via portal to escape any ancestor opacity /
// transform / filter that would otherwise break `position: fixed` or
// `backdrop-filter`. Use this for any destructive action that needs a
// "are you sure?" gate; one canonical look across the app.
//
// Caller controls visibility via conditional render (`{open && <ConfirmDialog ... />}`)
// so mount/unmount drives the escape-key listener lifecycle.

type ConfirmDialogProps = {
  title: string;
  body: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
};

export function ConfirmDialog({
  title,
  body,
  confirmLabel = 'confirm',
  cancelLabel = 'cancel',
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onCancel();
      } else if (e.key === 'Enter') {
        e.stopPropagation();
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel, onConfirm]);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[6px]"
      onClick={onCancel}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-[340px] p-6 bg-[#0a0a0a] border border-white/15 text-white/90 text-xs uppercase tracking-widest"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-white text-sm mb-3">{title}</div>
        <div className="text-white/55 leading-relaxed normal-case tracking-normal text-[12px] mb-5">
          {body}
        </div>
        <div className="flex items-center gap-2 justify-end">
          <button
            type="button"
            onClick={onCancel}
            className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white text-white hover:bg-white/10 transition-colors"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
