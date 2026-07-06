import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { invoke } from '@tauri-apps/api/core';
import {
  useSequencerStore,
  PERFORMANCE_SLOT_COUNT,
  type Song,
} from '../state/store';
import {
  exportPerformance,
  filenameSlug,
  parseSeqset,
  parseSongFromSeq,
  resolveRelativePath,
  songToSeqText,
} from '../state/persist';
import { ensureWorkingSongSaved, switchToSong } from '../state/songFileSync';
import { NOTE_NAMES } from '../audio/scale';

// Performance dialog — modal authoring + live-trigger surface for the
// outermost layer of the hierarchy (scene → composition/song →
// performance). Songs are slotted here; clicking one during playback
// queues a tail-out swap, while shift-click snaps the live state into
// the slot (save-first gated — every slot is backed by a .seq on disk).
// A .seqset persists REFERENCES to those files, so songs resolve fresh
// from disk on set load; legacy embedded sets still parse and extract
// their songs to files on the next save.

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

// Derive a song title from an imported .seq file path/name: drop any
// directory prefix and the known extension. Handles both the Tauri full
// path (forward + back slashes) and a bare web filename.
function songNameFromFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  return base.replace(/\.(seq|seqcomp|json)$/i, '');
}

function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

// Existence probe via the read command — no dedicated stat IPC, and at
// most 8 small .seq reads behind an explicit save gesture.
async function fileExists(path: string): Promise<boolean> {
  try {
    await invoke<string>('read_text_file', { path });
    return true;
  } catch {
    return false;
  }
}

function SongSlotCard({
  i,
  song,
  path,
  isActive,
  isPending,
  isTailingOut,
  isDragging,
  isDragOver,
  draggable,
  onClick,
  onShiftClick,
  onCmdClick,
  onRename,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  i: number;
  song: Song | null;
  path: string | null;
  isActive: boolean;
  isPending: boolean;
  isTailingOut: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  draggable: boolean;
  onClick: () => void;
  onShiftClick: () => void;
  onCmdClick: () => void;
  onRename: (name: string) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
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
  // A reference whose .seq didn't resolve at set load — the slot keeps the
  // path (it round-trips on the next save) but can't play.
  const missing = !song && !!path;
  const stateLabel = isActive
    ? isTailingOut
      ? 'ending…'
      : 'playing'
    : isPending
      ? 'queued'
      : filled
        ? 'loaded'
        : missing
          ? 'missing'
          : 'empty';
  return (
    <div
      role="button"
      tabIndex={0}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={handleClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          handleClick(e as unknown as React.MouseEvent);
        }
      }}
      title={
        filled
          ? `${path ?? ''}\nclick to load · shift-click to overwrite · cmd-click to clear · drag to reorder`.trim()
          : missing
            ? `${path} — file not found at set load · cmd-click to clear`
            : `shift-click to snap current state into this slot`
      }
      style={{ opacity: isDragging ? 0.3 : 1 }}
      className={[
        'relative text-left p-3 border transition-colors h-[78px] flex flex-col justify-between cursor-pointer select-none',
        isDragOver
          ? 'border-white bg-white/15 text-white'
          : isActive
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
        <input
          type="text"
          value={song?.name ?? ''}
          placeholder={filled ? `song ${i + 1}` : '—'}
          onChange={(e) => onRename(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          draggable={false}
          disabled={!filled}
          className={[
            'w-full bg-transparent border-none p-0 text-[11px] uppercase tracking-widest truncate focus:outline-none focus:ring-0',
            filled
              ? 'text-white/90 placeholder:text-white/40'
              : 'text-white/40 placeholder:text-white/25 cursor-not-allowed',
          ].join(' ')}
        />
        {song && (
          <div className="text-[9px] tracking-widest opacity-55 mt-0.5">
            {songSummary(song)}
          </div>
        )}
        {missing && (
          <div className="text-[9px] tracking-widest opacity-40 mt-0.5 normal-case truncate">
            {path?.split('/').pop()}
          </div>
        )}
      </div>
    </div>
  );
}

export function PerformanceDialog({ open, onClose }: PerformanceDialogProps) {
  const performance = useSequencerStore((s) => s.performance);
  const playing = useSequencerStore((s) => s.playing);
  const snapSong = useSequencerStore((s) => s.snapSong);
  const setSongPath = useSequencerStore((s) => s.setSongPath);
  const clearSong = useSequencerStore((s) => s.clearSong);
  const moveSong = useSequencerStore((s) => s.moveSong);
  const importSong = useSequencerStore((s) => s.importSong);
  const replacePerformance = useSequencerStore((s) => s.replacePerformance);
  const setPerformanceTailOutBars = useSequencerStore(
    (s) => s.setPerformanceTailOutBars,
  );
  const setPerformanceName = useSequencerStore((s) => s.setPerformanceName);
  const setSongName = useSequencerStore((s) => s.setSongName);

  const [importError, setImportError] = useState<string | null>(null);
  // Drag-to-reorder state. dragSource is the slot the user picked up;
  // dragOverSlot is the card the cursor is currently hovering over with
  // a valid drop (different from source, source is filled). Both reset
  // on dragEnd / drop.
  const [dragSource, setDragSource] = useState<number | null>(null);
  const [dragOverSlot, setDragOverSlot] = useState<number | null>(null);

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

  // Snapping is save-first gated: the slot's identity IS the .seq on disk,
  // so an unbound working song runs the save-as dialog before it can land.
  const handleSnapIntoSlot = async (i: number) => {
    const path = await ensureWorkingSongSaved();
    if (!path) return;
    snapSong(i);
    setSongPath(i, path);
  };

  const handleSnapIntoNextEmpty = () => {
    const idx = performance.songs.findIndex((s) => s === null);
    if (idx === -1) return;
    void handleSnapIntoSlot(idx);
  };

  const handleImportSongClick = async () => {
    if (!hasEmptySlot) return;
    try {
      const { open: pickFile } = await import('@tauri-apps/plugin-dialog');
      const picked = await pickFile({
        multiple: false,
        filters: SONG_FILTER,
      });
      if (!picked || typeof picked !== 'string') return;
      const text = await invoke<string>('read_text_file', { path: picked });
      setImportError(null);
      const song = parseSongFromSeq(text);
      if (!song) {
        setImportError('could not parse this .seq file');
        return;
      }
      // .seq files may carry no title — use the filename (sans path +
      // extension) so imported songs land labeled in the set. The picked
      // path becomes the slot's reference.
      const named = song.name
        ? song
        : { ...song, name: songNameFromFilename(picked) };
      const slot = importSong(named, picked);
      if (slot === null) {
        setImportError('all song slots are full — clear one first');
      }
    } catch (err) {
      console.error('[performance] import song failed:', err);
      setImportError('import failed — see console');
    }
  };

  const handleSavePerformanceAsSeqset = async () => {
    setImportError(null);
    const defaultName = `${filenameSlug(performance.name, 'newspeech-set')}.seqset`;
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const { documentDir, join } = await import('@tauri-apps/api/path');
      let defaultPath: string | undefined;
      try {
        defaultPath = await join(await documentDir(), defaultName);
      } catch {
        defaultPath = defaultName;
      }
      // Location first — legacy embedded slots extract to .seq files
      // BESIDE the set, so the folder has to be known before serializing.
      const picked = await save({ defaultPath, filters: SEQSET_FILTER });
      if (!picked) return;
      // The active song IS the live working state — flush it to its .seq
      // (save-as if unbound) so the set references what's audible now.
      const st = useSequencerStore.getState();
      if (
        st.performance.activeSong !== null &&
        st.performance.songs[st.performance.activeSong]
      ) {
        const songPath = await ensureWorkingSongSaved();
        if (!songPath) return;
        setSongPath(st.performance.activeSong, songPath);
      }
      // Extract path-less slots (embedded songs from a legacy .seqset, or
      // pre-reference sessions) into real files — one save fully migrates.
      const setDir = dirOf(picked);
      const perf = useSequencerStore.getState().performance;
      const extracted: string[] = [];
      for (let i = 0; i < PERFORMANCE_SLOT_COUNT; i++) {
        const song = perf.songs[i];
        if (!song || perf.songPaths[i]) continue;
        const base = filenameSlug(song.name, `song-${i + 1}`);
        let path = `${setDir}/${base}.seq`;
        for (let n = 2; (await fileExists(path)); n++) {
          path = `${setDir}/${base}-${n}.seq`;
        }
        await invoke('save_text_file', { path, contents: songToSeqText(song) });
        setSongPath(i, path);
        extracted.push(path.split('/').pop() ?? path);
      }
      await invoke('save_text_file', {
        path: picked,
        contents: exportPerformance(picked),
      });
      useSequencerStore.getState().pushToast({
        kind: 'success',
        text: extracted.length
          ? `set saved · extracted ${extracted.join(' · ')}`
          : 'set saved',
        revealPath: setDir,
      });
    } catch (err) {
      console.error('[performance] save seqset failed:', err);
      useSequencerStore.getState().pushToast({
        kind: 'error',
        text: `set save failed · ${String(err)}`,
      });
    }
  };

  const handleLoadSeqsetClick = async () => {
    try {
      const { open: pickFile } = await import('@tauri-apps/plugin-dialog');
      const picked = await pickFile({
        multiple: false,
        filters: SEQSET_FILTER,
      });
      if (!picked || typeof picked !== 'string') return;
      const text = await invoke<string>('read_text_file', { path: picked });
      setImportError(null);
      const parsed = parseSeqset(text);
      if (!parsed) {
        setImportError('could not parse this .seqset file');
        return;
      }
      if (parsed.kind === 'embedded') {
        // Legacy set — songs hydrate from the file itself; saving it in
        // the new format extracts them to .seq files.
        replacePerformance(parsed.performance);
        return;
      }
      // Reference set: resolve every song fresh from disk, absolute path
      // first, then relative to the set's folder (survives folder moves).
      const setDir = dirOf(picked);
      const songs: (Song | null)[] = Array.from(
        { length: PERFORMANCE_SLOT_COUNT },
        () => null,
      );
      const songPaths: (string | null)[] = Array.from(
        { length: PERFORMANCE_SLOT_COUNT },
        () => null,
      );
      const missing: string[] = [];
      for (let i = 0; i < PERFORMANCE_SLOT_COUNT; i++) {
        const ref = parsed.refs[i];
        if (!ref) continue;
        let resolvedPath = ref.path;
        let songText: string | null = null;
        try {
          songText = await invoke<string>('read_text_file', { path: resolvedPath });
        } catch {
          if (ref.rel) {
            const alt = resolveRelativePath(setDir, ref.rel);
            try {
              songText = await invoke<string>('read_text_file', { path: alt });
              resolvedPath = alt;
            } catch {
              // stays missing
            }
          }
        }
        // Keep the reference either way — a temporarily-missing file (e.g.
        // un-synced folder) must survive a load→save round trip.
        songPaths[i] = resolvedPath;
        if (songText === null) {
          missing.push(ref.path.split('/').pop() ?? ref.path);
          continue;
        }
        const song = parseSongFromSeq(songText);
        if (!song) {
          missing.push(ref.path.split('/').pop() ?? ref.path);
          continue;
        }
        songs[i] = {
          ...song,
          name: ref.name ?? song.name ?? songNameFromFilename(resolvedPath),
        };
      }
      replacePerformance({
        name: parsed.name,
        songs,
        songPaths,
        activeSong:
          parsed.activeSong !== null && songs[parsed.activeSong]
            ? parsed.activeSong
            : null,
        pendingSong: null,
        tailOutBarsRemaining: 0,
        tailOutBars: parsed.tailOutBars,
      });
      if (missing.length) {
        setImportError(
          `missing song file${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`,
        );
      }
    } catch (err) {
      console.error('[performance] load seqset failed:', err);
      setImportError('load failed — see console');
    }
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
        <div className="mb-5">
          <div className="text-white text-sm mb-3">performance</div>
          <input
            type="text"
            value={performance.name ?? ''}
            placeholder="untitled set"
            onChange={(e) => setPerformanceName(e.target.value)}
            className="w-full bg-transparent border border-white/15 px-2 text-[12px] tracking-widest text-white placeholder:text-white/30 focus:outline-none focus:border-white h-[28px] mb-2"
          />
          <div className="text-[10px] normal-case tracking-normal text-white/40">
            songs make up a performance · click to load · shift-click to snap
            current · cmd-click to clear · type in a slot to name it
          </div>
        </div>

        {/* SONG SLOTS */}
        <div className="grid grid-cols-2 gap-2 mb-6">
          {Array.from({ length: PERFORMANCE_SLOT_COUNT }, (_, i) => {
            const filled = !!performance.songs[i];
            return (
              <SongSlotCard
                key={i}
                i={i}
                song={performance.songs[i]}
                path={performance.songPaths[i]}
                isActive={performance.activeSong === i}
                isPending={performance.pendingSong === i}
                isTailingOut={performance.pendingSong === i && isTailingOut}
                isDragging={dragSource === i}
                isDragOver={dragOverSlot === i && dragSource !== null && dragSource !== i}
                draggable={filled}
                onClick={() => switchToSong(i)}
                onShiftClick={() => void handleSnapIntoSlot(i)}
                onCmdClick={() => clearSong(i)}
                onRename={(name) => setSongName(i, name)}
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(i));
                  setDragSource(i);
                }}
                onDragEnd={() => {
                  setDragSource(null);
                  setDragOverSlot(null);
                }}
                onDragOver={(e) => {
                  if (dragSource === null || dragSource === i) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  if (dragOverSlot !== i) setDragOverSlot(i);
                }}
                onDragLeave={() => {
                  if (dragOverSlot === i) setDragOverSlot(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragSource !== null && dragSource !== i) {
                    moveSong(dragSource, i);
                  }
                  setDragSource(null);
                  setDragOverSlot(null);
                }}
              />
            );
          })}
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
            save set (.seqset)
          </button>
          <button
            type="button"
            onClick={() => void handleLoadSeqsetClick()}
            title="load a .seqset file — replaces the current performance"
            className="px-3 py-1 text-[11px] uppercase tracking-widest border border-white/15 text-white/80 hover:border-white hover:text-white transition-colors"
          >
            load set
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
