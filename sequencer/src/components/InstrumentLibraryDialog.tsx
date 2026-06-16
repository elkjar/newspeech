import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Instrument, InstrumentRole } from '../instruments/library';
import { useUserInstrumentsStore } from '../instruments/userInstrumentsStore';
import { NewInstrumentDialog } from './NewInstrumentDialog';

// Tauri's WebView won't surface a picker for a hidden <input type="file">, so
// import goes through the native open() dialog + read_text_file there (same
// path as project load); the <input> stays as the web fallback. Export uses an
// <a download> blob, which the WebView does handle — so it's left alone.
const INSTRUMENT_IMPORT_FILTER = [
  { name: 'newspeech instruments', extensions: ['midilibrary', 'midiinstrument', 'json'] },
];

// Library management modal — list of user instruments grouped by role
// with per-row edit / export / delete, plus top-bar export-all / import
// / new. Triggered from the "instruments" button in PresetControls.
//
// Visual chrome matches ConfirmDialog (portal-to-body, same backdrop +
// panel border) but wider for the list view.

const ROLE_ORDER: InstrumentRole[] = ['lead', 'bass', 'pad', 'drum'];

function downloadFile(filename: string, content: string): void {
  const blob = new Blob([content], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function InstrumentLibraryDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const userInstruments = useUserInstrumentsStore((s) => s.userInstruments);
  const removeInstrument = useUserInstrumentsStore((s) => s.removeInstrument);
  const exportInstrument = useUserInstrumentsStore((s) => s.exportInstrument);
  const exportLibrary = useUserInstrumentsStore((s) => s.exportLibrary);
  const importLibraryOrInstrumentFromJson = useUserInstrumentsStore(
    (s) => s.importLibraryOrInstrumentFromJson
  );

  const [editing, setEditing] = useState<Instrument | null>(null);
  const [creatingRole, setCreatingRole] = useState<InstrumentRole | null>(null);
  const importRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !editing && !creatingRole) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, editing, creatingRole, onClose]);

  if (!open) return null;

  const handleDelete = (inst: Instrument) => {
    if (window.confirm(`delete "${inst.label}"?`)) {
      removeInstrument(inst.id);
    }
  };

  const handleExportOne = (inst: Instrument) => {
    const out = exportInstrument(inst.id);
    if (out) downloadFile(out.filename, out.json);
  };

  const handleExportAll = () => {
    const out = exportLibrary();
    if (out) downloadFile(out.filename, out.json);
  };

  const handleImportFile = async (file: File | null | undefined) => {
    if (!file) return;
    const text = await file.text();
    const result = importLibraryOrInstrumentFromJson(text);
    if (!result.ok) {
      console.warn('[instruments] import failed:', result.error);
    }
  };

  // Native: pick + read through Tauri (the <input> picker doesn't open in the
  // WebView). Web: fall back to clicking the hidden file input.
  const handleImportClick = async () => {
    if (isTauri()) {
      try {
        const { open: pickFile } = await import('@tauri-apps/plugin-dialog');
        const picked = await pickFile({ multiple: false, filters: INSTRUMENT_IMPORT_FILTER });
        if (!picked || typeof picked !== 'string') return;
        const text = await invoke<string>('read_text_file', { path: picked });
        const result = importLibraryOrInstrumentFromJson(text);
        if (!result.ok) console.warn('[instruments] import failed:', result.error);
      } catch (err) {
        console.error('[instruments] import failed:', err);
      }
      return;
    }
    importRef.current?.click();
  };

  const grouped: Record<InstrumentRole, Instrument[]> = {
    lead: [],
    bass: [],
    pad: [],
    texture: [],
    drum: [],
  };
  for (const inst of Object.values(userInstruments)) grouped[inst.role].push(inst);

  const total = Object.values(userInstruments).length;
  const hasAny = total > 0;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/20 backdrop-blur-[6px]"
        onClick={onClose}
        role="dialog"
        aria-modal="true"
      >
        <div
          className="w-[640px] max-h-[80vh] flex flex-col p-6 bg-[#0a0a0a] border border-white/15 text-white/90 text-xs uppercase tracking-widest"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-4">
            <span className="text-white text-sm">instrument library</span>
            <span className="text-white/55 text-[11px] normal-case tracking-normal">
              {total} {total === 1 ? 'instrument' : 'instruments'}
            </span>
          </div>

          <div className="flex items-center gap-2 mb-5">
            <button
              type="button"
              onClick={() => setCreatingRole('lead')}
              className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white text-white hover:bg-white/10 transition-colors"
            >
              + new
            </button>
            <button
              type="button"
              onClick={handleExportAll}
              disabled={!hasAny}
              className={
                hasAny
                  ? 'px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors'
                  : 'px-3 py-1 text-[11px] uppercase tracking-widest border border-white/10 text-white/20 cursor-not-allowed'
              }
              title="export all instruments as a single .midilibrary file"
            >
              export all
            </button>
            <button
              type="button"
              onClick={() => void handleImportClick()}
              className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors"
              title="import a .midilibrary or .midiinstrument file"
            >
              import
            </button>
            <input
              ref={importRef}
              type="file"
              accept=".midilibrary,.midiinstrument,.json,application/json,text/plain"
              style={{ display: 'none' }}
              onChange={(e) => {
                void handleImportFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </div>

          <div className="flex-1 overflow-y-auto -mx-2 pl-2 pr-4 normal-case tracking-normal">
            {!hasAny && (
              <div className="text-white/40 text-[12px] py-6 text-center">
                no saved instruments yet — click "+ new" or import a file
              </div>
            )}
            {ROLE_ORDER.map((role) => {
              const items = grouped[role];
              if (items.length === 0) return null;
              return (
                <div key={role} className="mb-4">
                  <div className="text-[10px] uppercase tracking-widest text-white/40 mb-1.5">
                    {role}
                  </div>
                  {items.map((inst) => (
                    <Row
                      key={inst.id}
                      inst={inst}
                      onEdit={() => setEditing(inst)}
                      onExport={() => handleExportOne(inst)}
                      onDelete={() => handleDelete(inst)}
                    />
                  ))}
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-end mt-4 pt-3 border-t border-white/10">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors"
            >
              close
            </button>
          </div>
        </div>
      </div>

      <NewInstrumentDialog
        open={editing !== null || creatingRole !== null}
        defaultRole={creatingRole ?? editing?.role ?? 'lead'}
        existing={editing}
        onCancel={() => {
          setEditing(null);
          setCreatingRole(null);
        }}
        onCreated={() => {
          setEditing(null);
          setCreatingRole(null);
        }}
      />
    </>,
    document.body
  );
}

function Row({
  inst,
  onEdit,
  onExport,
  onDelete,
}: {
  inst: Instrument;
  onEdit: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/[0.04] hover:bg-white/[0.02] -mx-2 px-2 transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <span className="text-white truncate">{inst.label}</span>
        <span className="text-white/30 text-[11px] tabular-nums">
          ch {inst.channel + 1}
          {inst.program !== null ? ` · pc ${inst.program}` : ''}
          {inst.portName ? ` · ${inst.portName}` : ''}
        </span>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <RowBtn onClick={onEdit} title="edit">
          edit
        </RowBtn>
        <RowBtn onClick={onExport} title="export as .midiinstrument">
          export
        </RowBtn>
        <RowBtn onClick={onDelete} title="delete" danger>
          ×
        </RowBtn>
      </div>
    </div>
  );
}

function RowBtn({
  onClick,
  title,
  danger,
  children,
}: {
  onClick: () => void;
  title: string;
  danger?: boolean;
  children: React.ReactNode;
}) {
  const base =
    'px-2 py-0.5 text-[10px] uppercase tracking-widest border transition-colors inline-flex items-center justify-center';
  const tone = danger
    ? 'border-white/10 text-white/40 hover:text-white hover:border-white'
    : 'border-white/15 text-white/60 hover:text-white hover:border-white';
  return (
    <button type="button" onClick={onClick} title={title} className={`${base} ${tone}`}>
      {children}
    </button>
  );
}
