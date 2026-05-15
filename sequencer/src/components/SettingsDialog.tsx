import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  getConfiguredRecordingsDir,
  setConfiguredRecordingsDir,
} from '../audio/recorder';
import { MidiBar } from './MidiBar';
import { ProjectFileControls } from './Transport';
import { InstrumentLibraryPane } from './InstrumentLibraryPane';

const NATIVE = isTauri();

// Tauri-only settings panel. Shell first — recordings directory now;
// sample directory + default .seq dir get added later as those features
// land. Visual chrome matches ConfirmDialog / NewInstrumentDialog
// (portal-to-body, same backdrop + panel border).

export function SettingsDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [recordingsDir, setRecordingsDir] = useState<string | null>(null);
  const [isCustomRecordingsDir, setIsCustomRecordingsDir] = useState(false);
  const [view, setView] = useState<'main' | 'instruments'>('main');

  // Reset to main view whenever the dialog closes so reopening always
  // lands on the top-level sections.
  useEffect(() => {
    if (!open) setView('main');
  }, [open]);

  const refreshRecordingsDir = async () => {
    if (!NATIVE) return;
    const override = getConfiguredRecordingsDir();
    if (override) {
      setRecordingsDir(override);
      setIsCustomRecordingsDir(true);
      return;
    }
    try {
      const dir = await invoke<string>('get_recordings_dir');
      setRecordingsDir(dir);
      setIsCustomRecordingsDir(false);
    } catch (err) {
      console.warn('[settings] get_recordings_dir failed:', err);
    }
  };

  useEffect(() => {
    if (!open) return;
    if (NATIVE) void refreshRecordingsDir();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        if (view !== 'main') setView('main');
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, onClose, view]);

  if (!open) return null;

  const revealRecordings = async () => {
    if (!recordingsDir) return;
    try {
      await invoke('reveal_in_finder', { path: recordingsDir });
    } catch (err) {
      console.warn('[settings] reveal_in_finder failed:', err);
    }
  };

  const changeRecordings = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: recordingsDir ?? undefined,
      });
      if (picked && typeof picked === 'string') {
        setConfiguredRecordingsDir(picked);
        await refreshRecordingsDir();
      }
    } catch (err) {
      console.warn('[settings] change recordings dir failed:', err);
    }
  };

  const resetRecordings = async () => {
    setConfiguredRecordingsDir(null);
    await refreshRecordingsDir();
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[6px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-[680px] max-h-[85vh] flex flex-col p-6 bg-[#0a0a0a] border border-white/15 text-white/90 text-xs uppercase tracking-widest"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 mb-4">
          {view !== 'main' && (
            <button
              type="button"
              onClick={() => setView('main')}
              title="back to settings"
              aria-label="back"
              className="px-2 h-[24px] text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors inline-flex items-center justify-center"
            >
              ←
            </button>
          )}
          <span className="text-white text-sm">
            {view === 'main' ? 'settings' : 'instruments'}
          </span>
        </div>

        {view === 'main' ? (
          <div className="flex-1 overflow-y-auto -mx-2 px-2 flex flex-col normal-case tracking-normal text-[12px]">
            {NATIVE && (
              <Section label="recordings">
                <SettingRow
                  label="folder"
                  description="where take .wav files land when you record"
                  value={recordingsDir ?? '…'}
                  actions={[
                    { label: 'open in finder', onClick: revealRecordings, disabled: !recordingsDir },
                    { label: 'change…', onClick: changeRecordings },
                    ...(isCustomRecordingsDir
                      ? [{ label: 'reset', onClick: resetRecordings }]
                      : []),
                  ]}
                />
              </Section>
            )}

            <Section label="midi">
              <MidiBar />
            </Section>

            <Section label="scene">
              <ProjectFileControls />
            </Section>

            <Section label="instruments">
              <button
                type="button"
                onClick={() => setView('instruments')}
                className="flex items-center justify-between w-full px-3 py-2 border border-white/15 hover:border-white text-white/70 hover:text-white transition-colors text-[12px] normal-case tracking-normal"
              >
                <span>manage instrument library</span>
                <span className="text-white/40">→</span>
              </button>
            </Section>

          </div>
        ) : (
          <div className="flex-1 overflow-y-auto -mx-2 px-2">
            <InstrumentLibraryPane />
          </div>
        )}

        <div className="flex items-center justify-end mt-5">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors"
          >
            close
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 py-5 border-t border-white/10 first:border-t-0 first:pt-0">
      <div className="text-[10px] uppercase tracking-widest text-white/40">{label}</div>
      {children}
    </div>
  );
}

function SettingRow({
  label,
  description,
  value,
  actions,
}: {
  label: string;
  description: string;
  value: string;
  actions: { label: string; onClick: () => void; disabled?: boolean }[];
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[10px] uppercase tracking-widest text-white/55">{label}</span>
        <div className="flex items-center gap-1">
          {actions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={a.onClick}
              disabled={a.disabled}
              className={
                a.disabled
                  ? 'px-2 py-0.5 text-[10px] uppercase tracking-widest border border-white/10 text-white/20 cursor-not-allowed'
                  : 'px-2 py-0.5 text-[10px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors'
              }
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
      <div className="text-white/80 font-mono text-[11px] break-all">{value}</div>
      <div className="text-white/40 text-[11px]">{description}</div>
    </div>
  );
}
