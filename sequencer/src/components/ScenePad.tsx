import { useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useSequencerStore, COMPOSITION_SLOT_COUNT } from '../state/store';
import {
  exportSceneAsSeqscene,
  parseSceneFromSeq,
  parseSceneFromSeqscene,
  timestampSlug,
} from '../state/persist';
import { DownloadIcon, ImportIcon } from './Transport';
import { SceneSettingsDialog } from './SceneSettingsDialog';

const PAD_SIZE = 36;
const PAD_GAP = 6;
const GAP_LINE_WIDTH = 1;

function isNoOpGap(src: number, gap: number): boolean {
  return gap === src || gap === src + 1;
}

function gapToSlot(src: number, gap: number): number {
  return gap > src ? gap - 1 : gap;
}

function gapLineX(k: number): number {
  return k * (PAD_SIZE + PAD_GAP) - PAD_GAP / 2;
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 14 14" width="12" height="12" aria-hidden>
      <circle cx="3" cy="7" r="1" fill="white" fillOpacity="0.85" />
      <circle cx="7" cy="7" r="1" fill="white" fillOpacity="0.85" />
      <circle cx="11" cy="7" r="1" fill="white" fillOpacity="0.85" />
    </svg>
  );
}

function SceneSlotButton({
  i,
  filled,
  isActive,
  isPending,
  isDragging,
  draggable,
  onShift,
  onClear,
  onPlain,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
}: {
  i: number;
  filled: boolean;
  isActive: boolean;
  isPending: boolean;
  isDragging: boolean;
  draggable: boolean;
  onShift: () => void;
  onClear: () => void;
  onPlain: () => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const fillOpacity = isActive ? 1 : filled ? 0.25 : 0;
  const handleClick = (e: React.MouseEvent) => {
    if (e.metaKey || e.ctrlKey) {
      onClear();
      return;
    }
    if (e.shiftKey) {
      onShift();
      return;
    }
    onPlain();
  };
  return (
    <button
      onClick={handleClick}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
      style={{ width: PAD_SIZE, height: PAD_SIZE, opacity: isDragging ? 0.3 : 1 }}
      className="relative overflow-hidden flex items-center justify-center"
      title={
        filled
          ? `scene ${i + 1} — click to load · shift-click to overwrite · cmd-click to clear · drag to reorder`
          : `scene ${i + 1} — shift-click to save current state as a scene`
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
}

const ALL_SCENES_MASK = (1 << COMPOSITION_SLOT_COUNT) - 1;

export function ScenePad() {
  // Bitmask of filled scene slots — primitive return short-circuits via
  // Object.is, so per-track / per-bank mutations inside an active scene
  // don't re-render the pad row. Same pattern as BankPad's bankFilledMask.
  const sceneFilledMask = useSequencerStore((s) => {
    let m = 0;
    for (let i = 0; i < COMPOSITION_SLOT_COUNT; i++) {
      if (s.composition.scenes[i]) m |= 1 << i;
    }
    return m;
  });
  const activeScene = useSequencerStore((s) => s.composition.activeScene);
  const pendingScene = useSequencerStore((s) => s.composition.pendingScene);
  const snapScene = useSequencerStore((s) => s.snapScene);
  const loadScene = useSequencerStore((s) => s.loadScene);
  const clearScene = useSequencerStore((s) => s.clearScene);
  const moveScene = useSequencerStore((s) => s.moveScene);
  const importScene = useSequencerStore((s) => s.importScene);

  const [dragSource, setDragSource] = useState<number | null>(null);
  const [dropGap, setDropGap] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const hasEmptySlot = (sceneFilledMask & ALL_SCENES_MASK) !== ALL_SCENES_MASK;

  // Try `.seqscene` strict parse first; if it doesn't match the scene
  // shape, fall back to the legacy song-extractor (`parseSceneFromSeq`)
  // which pulls the active scene out of a `.seq` / `.seqcomp` file.
  // Lets pre-split saves still drop into scene slots without manual
  // conversion.
  const importFromText = (text: string): boolean => {
    const scene = parseSceneFromSeqscene(text) ?? parseSceneFromSeq(text);
    if (!scene) {
      console.warn('[scene import] failed to parse file');
      return false;
    }
    const slot = importScene(scene);
    if (slot === null) {
      console.warn('[scene import] no empty scene slots');
      return false;
    }
    return true;
  };

  const handleImportClick = async () => {
    if (!hasEmptySlot) return;
    if (isTauri()) {
      try {
        const { open } = await import('@tauri-apps/plugin-dialog');
        const picked = await open({
          multiple: false,
          filters: [
            { name: 'Sequence scene', extensions: ['seqscene', 'seq', 'seqcomp', 'json'] },
          ],
        });
        if (!picked || typeof picked !== 'string') return;
        const text = await invoke<string>('read_text_file', { path: picked });
        importFromText(text);
      } catch (err) {
        console.error('[scene import] tauri picker failed:', err);
      }
      return;
    }
    fileInputRef.current?.click();
  };

  const handleSaveSceneClick = async () => {
    const code = exportSceneAsSeqscene();
    const defaultName = `newspeech-scene-${timestampSlug()}.seqscene`;
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
        const picked = await save({
          defaultPath,
          filters: [{ name: 'Sequence scene', extensions: ['seqscene'] }],
        });
        if (!picked) return;
        await invoke('save_text_file', { path: picked, contents: code });
      } catch (err) {
        console.error('[scene save] failed:', err);
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

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const text = await file.text();
    importFromText(text);
    e.target.value = '';
  };

  const handlePadDragOver = (i: number, e: React.DragEvent) => {
    if (dragSource === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const halfLeft = x < rect.width / 2;
    const preferred = halfLeft ? i : i + 1;
    const fallback = halfLeft ? i + 1 : i;
    let gap: number;
    if (!isNoOpGap(dragSource, preferred)) {
      gap = preferred;
    } else if (!isNoOpGap(dragSource, fallback)) {
      gap = fallback;
    } else {
      if (dropGap !== null) setDropGap(null);
      return;
    }
    if (dropGap !== gap) setDropGap(gap);
  };

  const handlePadDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (
      dragSource !== null &&
      dropGap !== null &&
      !isNoOpGap(dragSource, dropGap)
    ) {
      moveScene(dragSource, gapToSlot(dragSource, dropGap));
    }
    setDragSource(null);
    setDropGap(null);
  };

  const showGapLine =
    dragSource !== null && dropGap !== null && !isNoOpGap(dragSource, dropGap);

  return (
    <div className="flex items-center" style={{ gap: PAD_GAP * 2 }}>
      <span className="text-[11px] uppercase tracking-widest opacity-55">
        scene
      </span>
      <div className="relative flex items-center" style={{ gap: PAD_GAP }}>
        {Array.from({ length: COMPOSITION_SLOT_COUNT }, (_, i) => {
          const filled = (sceneFilledMask & (1 << i)) !== 0;
          return (
            <SceneSlotButton
              key={i}
              i={i}
              filled={filled}
              isActive={activeScene === i}
              isPending={pendingScene === i}
              isDragging={dragSource === i}
              draggable={filled}
              onShift={() => snapScene(i)}
              onClear={() => clearScene(i)}
              onPlain={() => loadScene(i)}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData('text/plain', String(i));
                setDragSource(i);
              }}
              onDragEnd={() => {
                setDragSource(null);
                setDropGap(null);
              }}
              onDragOver={(e) => handlePadDragOver(i, e)}
              onDrop={handlePadDrop}
            />
          );
        })}
        {showGapLine && (
          <div
            className="absolute bg-white pointer-events-none"
            style={{
              left: gapLineX(dropGap!) - GAP_LINE_WIDTH / 2,
              top: 0,
              height: PAD_SIZE,
              width: GAP_LINE_WIDTH,
            }}
          />
        )}
        <button
          onClick={() => void handleSaveSceneClick()}
          title="export the current state as a .seqscene file"
          style={{ width: PAD_SIZE, height: PAD_SIZE }}
          className="relative overflow-hidden flex items-center justify-center opacity-55 hover:opacity-100 transition-opacity"
        >
          <span className="absolute inset-0 bg-white/5" />
          <span className="relative">
            <DownloadIcon />
          </span>
        </button>
        <button
          onClick={handleImportClick}
          disabled={!hasEmptySlot}
          title={
            hasEmptySlot
              ? 'import a .seq file as a scene into the next empty slot'
              : 'all scene slots full — clear a slot first'
          }
          style={{ width: PAD_SIZE, height: PAD_SIZE }}
          className={[
            'relative overflow-hidden flex items-center justify-center transition-opacity',
            hasEmptySlot
              ? 'opacity-55 hover:opacity-100'
              : 'opacity-15 cursor-not-allowed',
          ].join(' ')}
        >
          <span className="absolute inset-0 bg-white/5" />
          <span className="relative">
            <ImportIcon />
          </span>
        </button>
        <button
          onClick={() => setSettingsOpen(true)}
          title="scene settings — shape, length, bank order, dwell locks"
          style={{ width: PAD_SIZE, height: PAD_SIZE }}
          className="relative overflow-hidden flex items-center justify-center opacity-55 hover:opacity-100 transition-opacity"
        >
          <span className="absolute inset-0 bg-white/5" />
          <span className="relative">
            <SettingsIcon />
          </span>
        </button>
      </div>
      <SceneSettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
      <input
        ref={fileInputRef}
        type="file"
        accept=".seqscene,.seq,.seqcomp,.json,application/json"
        className="hidden"
        onChange={handleFileChange}
      />
    </div>
  );
}
