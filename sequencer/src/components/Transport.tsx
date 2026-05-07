import { useRef } from 'react';
import { useSequencerStore } from '../state/store';
import { togglePlayback } from '../audio/transport';
import { NOTE_NAMES, SCALES } from '../audio/scale';
import { exportProject, importProject, timestampSlug } from '../state/persist';

function downloadProject() {
  const code = exportProject();
  const blob = new Blob([code], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `newspeech-${timestampSlug()}.seq`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function IconButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="border border-white/15 hover:border-white px-2 py-1 inline-flex items-center justify-center text-white transition-colors"
    >
      {children}
    </button>
  );
}

function DownloadIcon() {
  return (
    <svg
      viewBox="0 0 14 14"
      width="12"
      height="12"
      stroke="currentColor"
      strokeWidth="1.4"
      fill="none"
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      <path d="M7 2 L7 9" />
      <path d="M3.5 6 L7 9.5 L10.5 6" />
      <path d="M2.5 12 L11.5 12" />
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg
      viewBox="0 0 14 14"
      width="12"
      height="12"
      stroke="currentColor"
      strokeWidth="1.4"
      fill="none"
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      <path d="M7 12 L7 5" />
      <path d="M3.5 8 L7 4.5 L10.5 8" />
      <path d="M2.5 2 L11.5 2" />
    </svg>
  );
}

export function PlayButton() {
  const playing = useSequencerStore((s) => s.playing);
  return (
    <button
      onClick={() => togglePlayback()}
      className="px-6 py-3 border border-white/15 hover:border-white uppercase tracking-widest text-xs transition-colors"
    >
      {playing ? '■ stop' : '▶ play'}
    </button>
  );
}

export function TransportControls() {
  const bpm = useSequencerStore((s) => s.bpm);
  const rootNote = useSequencerStore((s) => s.rootNote);
  const scale = useSequencerStore((s) => s.scale);
  const setBpm = useSequencerStore((s) => s.setBpm);
  const setRootNote = useSequencerStore((s) => s.setRootNote);
  const setScale = useSequencerStore((s) => s.setScale);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const rootName = NOTE_NAMES[rootNote % 12];

  const handleImport = async (file: File | null | undefined) => {
    if (!file) return;
    const text = await file.text();
    const ok = importProject(text);
    if (!ok) {
      // eslint-disable-next-line no-console
      console.warn('failed to import sequence file');
    }
  };

  return (
    <div className="flex items-center gap-6 flex-wrap">
      <label className="flex items-center gap-3 text-xs uppercase tracking-widest opacity-70">
        <span>bpm</span>
        <input
          type="number"
          min={40}
          max={240}
          value={bpm}
          onChange={(e) => setBpm(Number(e.target.value))}
          className="w-20 bg-transparent border border-white/15 px-2 py-1 tabular-nums focus:outline-none focus:border-white"
        />
      </label>
      <label className="flex items-center gap-3 text-xs uppercase tracking-widest opacity-70">
        <span>root</span>
        <select
          value={rootName}
          onChange={(e) => {
            const idx = NOTE_NAMES.indexOf(e.target.value);
            if (idx >= 0) setRootNote(60 + idx);
          }}
          className="select-chevron bg-transparent border border-white/15 pl-2 py-1 focus:outline-none focus:border-white text-white"
        >
          {NOTE_NAMES.map((n) => (
            <option key={n} value={n} className="bg-[#050505]">
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-3 text-xs uppercase tracking-widest opacity-70">
        <span>scale</span>
        <select
          value={scale}
          onChange={(e) => setScale(e.target.value as typeof scale)}
          className="select-chevron bg-transparent border border-white/15 pl-2 py-1 focus:outline-none focus:border-white text-white"
        >
          {SCALES.map((s) => (
            <option key={s} value={s} className="bg-[#050505]">
              {s}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <IconButton title="download .seq" onClick={downloadProject}>
          <DownloadIcon />
        </IconButton>
        <IconButton title="import .seq" onClick={() => fileInputRef.current?.click()}>
          <ImportIcon />
        </IconButton>
        <input
          ref={fileInputRef}
          type="file"
          accept=".seq,.json,application/json,text/plain"
          style={{ display: 'none' }}
          onChange={(e) => {
            handleImport(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
    </div>
  );
}
