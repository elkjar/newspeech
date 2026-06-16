import { useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import type { Instrument, InstrumentRole } from '../instruments/library';
import { useUserInstrumentsStore } from '../instruments/userInstrumentsStore';
import { NewInstrumentDialog } from './NewInstrumentDialog';

// Tauri's WebView won't surface a picker for a hidden <input type="file">, so
// import goes through the native open() dialog + read_text_file there (same as
// the modal InstrumentLibraryDialog); the <input> stays as the web fallback.
const INSTRUMENT_IMPORT_FILTER = [
  { name: 'newspeech instruments', extensions: ['midilibrary', 'midiinstrument', 'json'] },
];

// Inline library pane — renders the list + top-bar actions without
// modal chrome. Embedded into SettingsDialog as a sub-view. The
// NewInstrumentDialog stays as a nested modal for the form (single-
// level form stack on top of settings, OK).

const ROLE_ORDER: InstrumentRole[] = ['lead', 'bass', 'pad', 'texture', 'drum'];

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

export function InstrumentLibraryPane() {
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
  const [search, setSearch] = useState('');
  // Per-role collapsed state. All roles default-expanded — this pane is the
  // place users come to *act*, not browse, so hiding rows by default would
  // add a click before getting to work. Header click toggles.
  const [collapsed, setCollapsed] = useState<Record<InstrumentRole, boolean>>({
    lead: false,
    bass: false,
    pad: false,
    texture: false,
    drum: false,
  });

  // Reset search whenever the dialog containing this pane opens/closes —
  // SettingsDialog mounts/unmounts us on open. Mount-time effect.
  useEffect(() => {
    setSearch('');
  }, []);

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

  const q = search.trim().toLowerCase();
  const matches = (inst: Instrument): boolean => {
    if (!q) return true;
    const hay = `${inst.label} ${inst.role} ${inst.portName ?? ''} ch${inst.channel + 1} ${
      inst.program ?? ''
    }`.toLowerCase();
    return hay.includes(q);
  };

  const grouped: Record<InstrumentRole, Instrument[]> = {
    lead: [],
    bass: [],
    pad: [],
    texture: [],
    drum: [],
  };
  for (const inst of Object.values(userInstruments)) {
    if (matches(inst)) grouped[inst.role].push(inst);
  }

  const total = Object.values(userInstruments).length;
  const totalVisible = Object.values(grouped).reduce((n, list) => n + list.length, 0);
  const hasAny = total > 0;
  const searchActive = q.length > 0;

  const toggleRole = (role: InstrumentRole) => {
    setCollapsed((prev) => ({ ...prev, [role]: !prev[role] }));
  };

  return (
    <div className="flex flex-col">
      <div className="flex items-center gap-2 mb-4 normal-case tracking-normal">
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
        <span className="ml-auto text-white/55 text-[11px] normal-case tracking-normal">
          {searchActive
            ? `${totalVisible} / ${total}`
            : `${total} ${total === 1 ? 'instrument' : 'instruments'}`}
        </span>
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

      {hasAny && (
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="search…"
          className="mb-3 bg-transparent border border-white/15 px-3 py-1.5 text-[12px] normal-case tracking-normal text-white focus:outline-none focus:border-white"
        />
      )}

      <div className="normal-case tracking-normal">
        {!hasAny && (
          <div className="text-white/40 text-[12px] py-6 text-center">
            no saved instruments yet — click "+ new" or import a file
          </div>
        )}
        {hasAny && totalVisible === 0 && (
          <div className="text-white/40 text-[12px] py-6 text-center">no matches</div>
        )}
        {ROLE_ORDER.map((role) => {
          const items = grouped[role];
          if (items.length === 0) return null;
          // Search active → ignore collapsed state so hits are visible
          // without an extra click.
          const isCollapsed = !searchActive && collapsed[role];
          return (
            <div key={role} className="mb-2">
              <button
                type="button"
                onClick={() => toggleRole(role)}
                className="flex items-center gap-2 w-full text-left text-[10px] uppercase tracking-widest text-white/40 hover:text-white/80 transition-colors py-1"
              >
                <span className="inline-block w-3 text-white/50">
                  {isCollapsed ? '▸' : '▾'}
                </span>
                <span>{role}</span>
                <span className="text-white/25 tabular-nums">{items.length}</span>
              </button>
              {!isCollapsed &&
                items.map((inst) => (
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
    </div>
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
