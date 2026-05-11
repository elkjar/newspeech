import { useEffect, useRef, useState } from 'react';
import { useMidiMapStore } from '../midi/midiMapStore';
import { useSequencerStore } from '../state/store';
import { useMIDIOutputs } from '../hooks/useMIDIOutputs';
import { midiOutStatus } from '../audio/midiOut';
import { IconButton, DownloadIcon, ImportIcon } from './Transport';

const CREATE_NEW_ID = '__new__';

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

// Native <select> elements on macOS pick up extra UA chrome that makes
// them a few pixels taller than a plain button at the same padding.
// Pin every interactive control in the row to the same explicit height
// so nothing drifts.
const ROW_HEIGHT = 'h-[28px]';

function ExportButton() {
  const exportActiveMap = useMidiMapStore((s) => s.exportActiveMap);
  const activeId = useMidiMapStore((s) => s.activeMidiMapId);
  const disabled = !activeId;
  return (
    <IconButton
      title="export mapping (.midimap)"
      disabled={disabled}
      className={ROW_HEIGHT}
      onClick={() => {
        const out = exportActiveMap();
        if (!out) return;
        downloadFile(out.filename, out.json);
      }}
    >
      <DownloadIcon />
    </IconButton>
  );
}

function ImportButton() {
  const importMapFromJson = useMidiMapStore((s) => s.importMapFromJson);
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <IconButton
        title="import mapping (.midimap)"
        className={ROW_HEIGHT}
        onClick={() => ref.current?.click()}
      >
        <ImportIcon />
      </IconButton>
      <input
        ref={ref}
        type="file"
        accept=".midimap,.json,application/json,text/plain"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          const text = await file.text();
          const result = importMapFromJson(text);
          if (!result.ok) {
            // eslint-disable-next-line no-console
            console.warn('midimap import failed:', result.error);
          }
        }}
      />
    </>
  );
}

function RenameInput({ onDone }: { onDone: () => void }) {
  const activeId = useMidiMapStore((s) => s.activeMidiMapId);
  const midiMaps = useMidiMapStore((s) => s.midiMaps);
  const renameUserMap = useMidiMapStore((s) => s.renameUserMap);
  const active = activeId ? midiMaps[activeId] : null;
  const [value, setValue] = useState(active?.name ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  const commit = () => {
    const trimmed = value.trim();
    if (activeId && trimmed) renameUserMap(activeId, trimmed);
    onDone();
  };
  return (
    <input
      ref={inputRef}
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onDone();
        }
      }}
      className={`bg-transparent border border-white/40 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none max-w-[150px] ${ROW_HEIGHT}`}
    />
  );
}

function RenameUserMapButton({ onClick }: { onClick: () => void }) {
  const activeId = useMidiMapStore((s) => s.activeMidiMapId);
  const midiMaps = useMidiMapStore((s) => s.midiMaps);
  const active = activeId ? midiMaps[activeId] : null;
  const canRename = !!active && active.source === 'user';
  return (
    <button
      onClick={() => {
        if (canRename) onClick();
      }}
      disabled={!canRename}
      title={canRename ? 'rename this mapping' : 'no mapping selected'}
      className={[
        'px-2 text-[11px] uppercase tracking-widest border transition-colors inline-flex items-center justify-center',
        ROW_HEIGHT,
        canRename
          ? 'border-white/15 text-white/60 hover:text-white hover:border-white'
          : 'border-white/10 text-white/20 cursor-not-allowed',
      ].join(' ')}
    >
      ✎
    </button>
  );
}

function DeleteUserMapButton() {
  const activeId = useMidiMapStore((s) => s.activeMidiMapId);
  const midiMaps = useMidiMapStore((s) => s.midiMaps);
  const deleteUserMap = useMidiMapStore((s) => s.deleteUserMap);
  const active = activeId ? midiMaps[activeId] : null;
  const canDelete = !!active && active.source === 'user';
  return (
    <button
      onClick={() => {
        if (!canDelete || !activeId || !active) return;
        if (confirm(`delete mapping "${active.name}"?`)) deleteUserMap(activeId);
      }}
      disabled={!canDelete}
      title={canDelete ? 'delete this mapping' : 'no mapping selected'}
      className={[
        'px-2 text-[11px] uppercase tracking-widest border transition-colors inline-flex items-center justify-center',
        ROW_HEIGHT,
        canDelete
          ? 'border-white/15 text-white/60 hover:text-white hover:border-white'
          : 'border-white/10 text-white/20 cursor-not-allowed',
      ].join(' ')}
    >
      ×
    </button>
  );
}

function LearnButton() {
  const learnMode = useMidiMapStore((s) => s.learnMode);
  const learnTarget = useMidiMapStore((s) => s.learnTarget);
  const setLearnMode = useMidiMapStore((s) => s.setLearnMode);

  return (
    <button
      onClick={() => setLearnMode(!learnMode)}
      title={
        learnMode
          ? learnTarget
            ? `learning ${learnTarget} — twist a knob or tap a pad`
            : 'learn mode — click a knob or pad'
          : 'enter learn mode'
      }
      className={[
        'px-2 text-[11px] uppercase tracking-widest border transition-colors inline-flex items-center justify-center',
        ROW_HEIGHT,
        learnMode
          ? 'bg-white text-ink border-white'
          : 'border-white/15 text-white/60 hover:text-white hover:border-white',
      ].join(' ')}
    >
      L
    </button>
  );
}

function MidiInSelector() {
  const midiMaps = useMidiMapStore((s) => s.midiMaps);
  const activeId = useMidiMapStore((s) => s.activeMidiMapId);
  const setActiveMap = useMidiMapStore((s) => s.setActiveMap);
  const createUserMap = useMidiMapStore((s) => s.createUserMap);

  const entries = Object.values(midiMaps);

  return (
    <select
      value={activeId ?? ''}
      onChange={(e) => {
        const v = e.target.value;
        if (v === CREATE_NEW_ID) {
          createUserMap(`Untitled ${entries.length + 1}`);
          return;
        }
        setActiveMap(v || null);
      }}
      className={`select-chevron bg-transparent border border-white/15 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white max-w-[150px] ${ROW_HEIGHT}`}
      title="midi input mapping"
    >
      <option value="" className="bg-[#050505]">
        none
      </option>
      {entries.map((m) => (
        <option key={m.id} value={m.id} className="bg-[#050505]">
          {m.name}
        </option>
      ))}
      <option value={CREATE_NEW_ID} className="bg-[#050505]">
        + new mapping
      </option>
    </select>
  );
}

function MidiOutSelector() {
  const outputs = useMIDIOutputs();
  const deviceId = useSequencerStore((s) => s.midiOutDeviceId);
  const setDeviceId = useSequencerStore((s) => s.setMidiOutDeviceId);
  const status = midiOutStatus();
  const noOutputs = outputs.length === 0;

  return (
    <select
      value={deviceId ?? ''}
      onChange={(e) => setDeviceId(e.target.value || null)}
      disabled={status !== 'ready' || noOutputs}
      className={`select-chevron bg-transparent border border-white/15 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white max-w-[150px] ${ROW_HEIGHT}`}
      title={
        status === 'unsupported'
          ? 'web midi not supported in this browser'
          : status === 'denied'
            ? 'midi access denied'
            : noOutputs
              ? 'no midi outputs detected'
              : 'midi output device'
      }
    >
      <option value="" className="bg-[#050505]">
        {status === 'unsupported'
          ? 'unsupported'
          : status === 'denied'
            ? 'denied'
            : noOutputs
              ? 'no outputs'
              : 'none'}
      </option>
      {outputs.map((o) => (
        <option key={o.id} value={o.id} className="bg-[#050505]">
          {o.name}
        </option>
      ))}
    </select>
  );
}

function MidiInputCluster() {
  const activeId = useMidiMapStore((s) => s.activeMidiMapId);
  const [renaming, setRenaming] = useState(false);
  // Cancel rename mode when the active map changes (selector switches
  // out from under us, or the map is deleted).
  useEffect(() => {
    setRenaming(false);
  }, [activeId]);
  return (
    <div className="flex items-center gap-2">
      {renaming ? (
        <RenameInput onDone={() => setRenaming(false)} />
      ) : (
        <MidiInSelector />
      )}
      <LearnButton />
      <ExportButton />
      <ImportButton />
      <RenameUserMapButton onClick={() => setRenaming(true)} />
      <DeleteUserMapButton />
    </div>
  );
}

export function MidiBar() {
  return (
    <div className="flex items-center gap-4 flex-wrap">
      <span className="text-[11px] uppercase tracking-widest opacity-55">
        midi
      </span>
      <MidiInputCluster />
      <div className="flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-widest opacity-55">
          out
        </span>
        <MidiOutSelector />
      </div>
    </div>
  );
}
