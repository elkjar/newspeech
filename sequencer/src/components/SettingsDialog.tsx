import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  getConfiguredRecordingsDir,
  setConfiguredRecordingsDir,
} from '../audio/recorder';
import {
  getConfiguredUserSamplesDir,
  setConfiguredUserSamplesDir,
  resolveUserSamplesDir,
  scanAndLoadUserSamples,
} from '../instruments/userSamplesDir';
import { MidiBar } from './MidiBar';
import { ProjectFileControls } from './Transport';
import { InstrumentLibraryPane } from './InstrumentLibraryPane';
import { SampleLibraryPane } from './SampleLibraryPane';
import pkg from '../../package.json';

const NATIVE = isTauri();
const APP_VERSION: string = pkg.version;

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
  const [userSamplesDir, setUserSamplesDir] = useState<string | null>(null);
  const [isCustomUserSamplesDir, setIsCustomUserSamplesDir] = useState(false);
  const [rescanStatus, setRescanStatus] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [view, setView] = useState<'main' | 'instruments' | 'samples'>('main');

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

  const refreshUserSamplesDir = async () => {
    if (!NATIVE) return;
    const override = getConfiguredUserSamplesDir();
    setIsCustomUserSamplesDir(!!override);
    const dir = await resolveUserSamplesDir();
    setUserSamplesDir(dir);
  };

  useEffect(() => {
    if (!open) return;
    if (NATIVE) {
      void refreshRecordingsDir();
      void refreshUserSamplesDir();
    }
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

  const revealUserSamples = async () => {
    if (!userSamplesDir) return;
    try {
      await invoke('reveal_in_finder', { path: userSamplesDir });
    } catch (err) {
      console.warn('[settings] reveal_in_finder failed:', err);
    }
  };

  const changeUserSamples = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        directory: true,
        multiple: false,
        defaultPath: userSamplesDir ?? undefined,
      });
      if (picked && typeof picked === 'string') {
        setConfiguredUserSamplesDir(picked);
        await refreshUserSamplesDir();
        await runRescan();
      }
    } catch (err) {
      console.warn('[settings] change user samples dir failed:', err);
    }
  };

  const resetUserSamples = async () => {
    setConfiguredUserSamplesDir(null);
    await refreshUserSamplesDir();
    await runRescan();
  };

  const runRescan = async () => {
    if (!NATIVE) return;
    setScanning(true);
    setRescanStatus('scanning…');
    try {
      const result = await scanAndLoadUserSamples();
      if (result.errors.length > 0) {
        setRescanStatus(
          `loaded ${result.loaded}, ${result.errors.length} failed — see console`,
        );
        for (const err of result.errors) console.warn('[user samples]', err);
      } else if (result.skipped > 0) {
        setRescanStatus('no user samples dir configured');
      } else {
        setRescanStatus(`loaded ${result.loaded} ${result.loaded === 1 ? 'kit' : 'kits'}`);
      }
    } catch (err) {
      console.warn('[settings] rescan failed:', err);
      setRescanStatus(`error — see console`);
    } finally {
      setScanning(false);
    }
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
            {view === 'main' ? 'settings' : view === 'instruments' ? 'midi instruments' : 'sample instruments'}
          </span>
        </div>

        {view === 'main' ? (
          <div className="flex-1 overflow-y-auto -mx-2 pl-2 pr-4 flex flex-col normal-case tracking-normal text-[12px]">
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

            {NATIVE && (
              <Section label="user samples">
                <SettingRow
                  label="folder"
                  description="drop sample packs /type/<name>/sample-<note>.wav"
                  value={userSamplesDir ?? '…'}
                  actions={[
                    { label: 'open in finder', onClick: revealUserSamples, disabled: !userSamplesDir },
                    { label: 'change…', onClick: changeUserSamples },
                    { label: scanning ? 'scanning…' : 'rescan', onClick: runRescan, disabled: scanning || !userSamplesDir },
                    ...(isCustomUserSamplesDir
                      ? [{ label: 'reset', onClick: resetUserSamples }]
                      : []),
                  ]}
                />
                {rescanStatus && (
                  <div className="text-white/50 text-[11px]">{rescanStatus}</div>
                )}
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
                <span>manage midi instruments</span>
                <span className="text-white/40">→</span>
              </button>
              <button
                type="button"
                onClick={() => setView('samples')}
                className="flex items-center justify-between w-full px-3 py-2 border border-white/15 hover:border-white text-white/70 hover:text-white transition-colors text-[12px] normal-case tracking-normal"
              >
                <span>manage sample instruments</span>
                <span className="text-white/40">→</span>
              </button>
            </Section>

          </div>
        ) : view === 'instruments' ? (
          <div className="flex-1 overflow-y-auto -mx-2 pl-2 pr-4">
            <InstrumentLibraryPane />
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto -mx-2 pl-2 pr-4">
            <SampleLibraryPane />
          </div>
        )}

        <div className="flex items-center justify-between mt-5">
          <span className="text-[10px] uppercase tracking-widest text-white/30 tabular-nums">
            v{APP_VERSION}
          </span>
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
