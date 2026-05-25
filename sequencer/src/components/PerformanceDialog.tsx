import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  useSequencerStore,
  PERFORMANCE_SLOT_COUNT,
  type Song,
} from '../state/store';
import {
  exportPerformance,
  exportProject,
  parsePerformanceFromSeqset,
  parseSongFromSeq,
  timestampSlug,
} from '../state/persist';
import { NOTE_NAMES } from '../audio/scale';

// Performance dialog — modal authoring + live-trigger surface for the
// outermost layer of the hierarchy (scene → composition/song →
// performance). Songs are slotted here; clicking one during playback
// queues a tail-out swap, while shift-click snaps the live state into
// the slot. Save/load handles both .seq (single song; same shape as
// the legacy project save) and .seqset (whole performance).

type PerformanceDialogProps = {
  open: boolean;
  onClose: () => void;
};

// .seqcomp accepted on import for back-compat with the short-lived
// 2026-05-24 intermediate naming; save always writes .seq going forward.
const SONG_FILTER = [{ name: 'newspeech song', extensions: ['seq', 'seqcomp', 'json'] }];
const SEQSET_FILTER = [{ name: 'newspeech performance', extensions: ['seqset', 'json'] }];

function songSummary(s: Song): string {
  const root = NOTE_NAMES[((s.rootNote % 12) + 12) % 12];
  return `${Math.round(s.bpm)} bpm · ${root} ${s.scale}`;
}

function SongSlotCard({
  i,
  song,
  isActive,
  isPending,
  isTailingOut,
  onClick,
  onShiftClick,
  onCmdClick,
}: {
  i: number;
  song: Song | null;
  isActive: boolean;
  isPending: boolean;
  isTailingOut: boolean;
  onClick: () => void;
  onShiftClick: () => void;
  onCmdClick: () => void;
}) {
  const handleClick = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      onCmdClick();
      return;
    }
    if (e.shiftKey) {
      onShiftClick();
      return;
    }
    onClick();
  };
  const filled = !!song;
  const stateLabel = isActive
    ? isTailingOut
      ? 'ending…'
      : 'playing'
    : isPending
      ? 'queued'
      : filled
        ? 'loaded'
        : 'empty';
  return (
    <button
      type="button"
      onClick={handleClick}
      title={
        filled
          ? `${song?.name ?? `song ${i + 1}`} — click to load · shift-click to overwrite · cmd-click to clear`
          : `song ${i + 1} — shift-click to snap current state into this slot`
      }
      className={[
        'relative text-left p-3 border transition-colors h-[78px] flex flex-col justify-between',
        isActive
          ? 'border-white bg-white/10 text-white'
          : isPending
            ? 'border-white text-white animate-pulse'
            : filled
              ? 'border-white/25 text-white/90 hover:border-white'
              : 'border-white/10 text-white/40 hover:border-white/40 hover:text-white/80',
      ].join(' ')}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-widest tabular-nums opacity-55">
          {(i + 1).toString().padStart(2, '0')}
        </span>
        <span className="text-[9px] uppercase tracking-widest opacity-55">
          {stateLabel}
        </span>
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-widest truncate">
          {song?.name ?? (filled ? `song ${i + 1}` : '—')}
        </div>
        {song && (
          <div className="text-[9px] tracking-widest opacity-55 mt-0.5">
            {songSummary(song)}
          </div>
        )}
      </div>
    </button>
  );
}

export function PerformanceDialog({ open, onClose }: PerformanceDialogProps) {
  const performance = useSequencerStore((s) => s.performance);
  const playing = useSequencerStore((s) => s.playing);
  const snapSong = useSequencerStore((s) => s.snapSong);
  const loadSong = useSequencerStore((s) => s.loadSong);
  const clearSong = useSequencerStore((s) => s.clearSong);
  const importSong = useSequencerStore((s) => s.importSong);
  const replacePerformance = useSequencerStore((s) => s.replacePerformance);
  const setPerformanceTailOutBars = useSequencerStore(
    (s) => s.setPerformanceTailOutBars,
  );

  const songInputRef = useRef<HTMLInputElement>(null);
  const seqsetInputRef = useRef<HTMLInputElement>(null);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  // Reset import error when dialog opens/closes so a stale message doesn't
  // hang around the next time the user opens it.
  useEffect(() => {
    if (!open) setImportError(null);
  }, [open]);

  if (!open) return null;

  const hasEmptySlot = performance.songs.some((s) => s === null);

  const handleSnapIntoNextEmpty = () => {
    const idx = performance.songs.findIndex((s) => s === null);
    if (idx === -1) return;
    snapSong(idx);
  };

  const handleImportSongText = (text: string) => {
    setImportError(null);
    const song = parseSongFromSeq(text);
    if (!song) {
      setImportError('could not parse this .seq file');
      return;
    }
    const slot = importSong(song);
    if (slot === null) {
      setImportError('all song slots are full — clear one first');
    }
  };

  const handleImportSongClick = async () => {
    if (!hasEmptySlot) return;
    if (isTauri()) {
      try {
        const { open: pickFile } = await import('@tauri-apps/plugin-dialog');
        const picked = await pickFile({
          multiple: false,
          filters: SONG_FILTER,
        });
        if (!picked || typeof picked !== 'string') return;
        const text = await invoke<string>('read_text_file', { path: picked });
        handleImportSongText(text);
      } catch (err) {
        console.error('[performance] import song failed:', err);
        setImportError('import failed — see console');
      }
      return;
    }
    songInputRef.current?.click();
  };

  const handleSongFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    handleImportSongText(text);
    e.target.value = '';
  };

  const handleSaveCurrentAsSeqcomp = async () => {
    const code = exportProject();
    const defaultName = `newspeech-song-${timestampSlug()}.seq`;
    if (isTauri()) {
      try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const { documentDir, join } = await import('@tauri-apps/api/path');
        let defaultPath: string | undefined;
        try {
          defaultPath = await join(await documentDir(), defaultName);
        } catch {
          defaultPath = defaultName;
        }
        const picked = await save({ defaultPath, filters: SONG_FILTER });
        if (!picked) return;
        await invoke('save_text_file', { path: picked, contents: code });
      } catch (err) {
        console.error('[performance] save song failed:', err);
      }
      return;
    }
    const blob = new Blob([code], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleSavePerformanceAsSeqset = async () => {
    const code = exportPerformance();
    const defaultName = `newspeech-performance-${timestampSlug()}.seqset`;
    if (isTauri()) {
      try {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const { documentDir, join } = await import('@tauri-apps/api/path');
        let defaultPath: string | undefined;
        try {
          defaultPath = await join(await documentDir(), defaultName);
        } catch {
          defaultPath = defaultName;
        }
        const picked = await save({ defaultPath, filters: SEQSET_FILTER });
        if (!picked) return;
        await invoke('save_text_file', { path: picked, contents: code });
      } catch (err) {
        console.error('[performance] save seqset failed:', err);
      }
      return;
    }
    const blob = new Blob([code], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = defaultName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const handleLoadSeqsetText = (text: string) => {
    setImportError(null);
    const next = parsePerformanceFromSeqset(text);
    if (!next) {
      setImportError('could not parse this .seqset file');
      return;
    }
    replacePerformance(next);
  };

  const handleLoadSeqsetClick = async () => {
    if (isTauri()) {
      try {
        const { open: pickFile } = await import('@tauri-apps/plugin-dialog');
        const picked = await pickFile({
          multiple: false,
          filters: SEQSET_FILTER,
        });
        if (!picked || typeof picked !== 'string') return;
        const text = await invoke<string>('read_text_file', { path: picked });
        handleLoadSeqsetText(text);
      } catch (err) {
        console.error('[performance] load seqset failed:', err);
        setImportError('load failed — see console');
      }
      return;
    }
    seqsetInputRef.current?.click();
  };

  const handleSeqsetFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    handleLoadSeqsetText(text);
    e.target.value = '';
  };

  const isTailingOut =
    performance.pendingSong !== null && performance.tailOutBarsRemaining > 0;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 backdrop-blur-[6px]"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-[680px] max-h-[85vh] overflow-auto p-6 bg-[#0a0a0a] border border-white/15 text-white/90 text-xs uppercase tracking-widest"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-5">
          <div className="text-white text-sm">performance</div>
          <div className="text-[10px] normal-case tracking-normal text-white/40">
            songs make up a performance · click to load · shift-click to snap
            current · cmd-click to clear
          </div>
        </div>

        {/* SONG SLOTS */}
        <div className="grid grid-cols-2 gap-2 mb-6">
          {Array.from({ length: PERFORMANCE_SLOT_COUNT }, (_, i) => (
            <SongSlotCard
              key={i}
              i={i}
              song={performance.songs[i]}
              isActive={performance.activeSong === i}
              isPending={performance.pendingSong === i}
              isTailingOut={performance.pendingSong === i && isTailingOut}
              onClick={() => loadSong(i)}
              onShiftClick={() => snapSong(i)}
              onCmdClick={() => clearSong(i)}
            />
          ))}
        </div>

        {/* TAIL-OUT */}
        <div className="mb-6">
          <div className="text-white/55 mb-2 text-[10px]">tail-out bars</div>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={0}
              max={32}
              value={performance.tailOutBars}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) setPerformanceTailOutBars(n);
              }}
              className="w-20 bg-transparent border border-white/15 px-2 text-[11px] uppercase tracking-widest text-white tabular-nums focus:outline-none focus:border-white h-[28px]"
            />
            <span className="text-white/55 text-[10px] normal-case tracking-normal">
              bars to let voices ring out before snapping to the queued song.
              0 = atomic snap on next bar.
            </span>
          </div>
        </div>

        {/* ACTIONS */}
        <div className="flex items-center flex-wrap gap-2 mb-3">
          <button
            type="button"
            onClick={handleSnapIntoNextEmpty}
            disabled={!hasEmptySlot}
            title={
              hasEmptySlot
                ? 'snap the current piece into the next empty song slot'
                : 'all song slots full — clear one first'
            }
            className={[
              'px-3 py-1 text-[11px] uppercase tracking-widest border transition-colors',
              hasEmptySlot
                ? 'border-white/15 text-white/80 hover:border-white hover:text-white'
                : 'border-white/5 text-white/25 cursor-not-allowed',
            ].join(' ')}
          >
            snap current
          </button>
          <button
            type="button"
            onClick={() => void handleSaveCurrentAsSeqcomp()}
            title="export the current piece as a .seq file"
            className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/80 hover:border-white hover:text-white transition-colors"
          >
            save song (.seq)
          </button>
          <button
            type="button"
            onClick={() => void handleImportSongClick()}
            disabled={!hasEmptySlot}
            title={
              hasEmptySlot
                ? 'import a .seq file into the next empty song slot'
                : 'all song slots full — clear one first'
            }
            className={[
              'px-3 py-1 text-[11px] uppercase tracking-widest border transition-colors',
              hasEmptySlot
                ? 'border-white/15 text-white/80 hover:border-white hover:text-white'
                : 'border-white/5 text-white/25 cursor-not-allowed',
            ].join(' ')}
          >
            import song
          </button>
          <span className="w-px h-5 bg-white/15 mx-1" />
          <button
            type="button"
            onClick={() => void handleSavePerformanceAsSeqset()}
            title="export the whole performance (all songs) as a .seqset file"
            className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/80 hover:border-white hover:text-white transition-colors"
          >
            save performance (.seqset)
          </button>
          <button
            type="button"
            onClick={() => void handleLoadSeqsetClick()}
            title="load a .seqset file — replaces the current performance"
            className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/80 hover:border-white hover:text-white transition-colors"
          >
            load performance
          </button>
        </div>

        {importError && (
          <div className="text-[10px] normal-case tracking-normal text-red-400/90 mb-3">
            {importError}
          </div>
        )}

        <div className="flex items-center justify-between mt-6">
          <div className="text-[10px] normal-case tracking-normal text-white/40">
            {playing
              ? isTailingOut
                ? `ending current song — ${performance.tailOutBarsRemaining} bar${performance.tailOutBarsRemaining === 1 ? '' : 's'} until swap`
                : performance.pendingSong !== null
                  ? `queued: song ${performance.pendingSong + 1}`
                  : 'playing — clicks queue a tail-out swap at next bar'
              : 'stopped — clicks load immediately'}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white text-white hover:bg-white/10 transition-colors"
          >
            close
          </button>
        </div>

        <input
          ref={songInputRef}
          type="file"
          accept=".seq,.seqcomp,.json,application/json"
          className="hidden"
          onChange={handleSongFileChange}
        />
        <input
          ref={seqsetInputRef}
          type="file"
          accept=".seqset,.json,application/json"
          className="hidden"
          onChange={handleSeqsetFileChange}
        />
      </div>
    </div>,
    document.body,
  );
}

// Small button to mount in the toolbar that opens the performance dialog.
// Mirrors InstrumentLibraryButton's pattern — local open state, dialog
// portal'd to body, no other side effects.
export function PerformanceButton() {
  const [open, setOpen] = useState(false);
  const activeSong = useSequencerStore((s) => s.performance.activeSong);
  const pendingSong = useSequencerStore((s) => s.performance.pendingSong);
  const label =
    pendingSong !== null
      ? `perf · → ${pendingSong + 1}`
      : activeSong !== null
        ? `perf · ${activeSong + 1}`
        : 'perf';
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="performance — stack songs, switch with tail-out, save .seqset"
        className="px-2 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors inline-flex items-center justify-center h-[28px]"
      >
        {label}
      </button>
      <PerformanceDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
