import { useRef } from 'react';
import { useSequencerStore } from '../state/store';
import { togglePlayback, tapTempo } from '../audio/transport';
import { NOTE_NAMES, SCALES } from '../audio/scale';
import { exportProject, importProject, timestampSlug } from '../state/persist';
import { presetsForTarget } from '../instruments/library';
import { useMidiLearn } from '../hooks/useMidiLearn';

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

export function IconButton({
  title,
  onClick,
  disabled,
  className,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      className={[
        'border px-2 py-1 inline-flex items-center justify-center transition-colors',
        disabled
          ? 'border-white/10 text-white/20 cursor-not-allowed'
          : 'border-white/15 hover:border-white text-white',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

export function DownloadIcon() {
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

export function ImportIcon() {
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
  const learn = useMidiLearn('transport:play');
  const handleClick = () => {
    if (learn.onLearnClick) {
      learn.onLearnClick();
      return;
    }
    void togglePlayback();
  };
  return (
    <button
      onClick={handleClick}
      title={
        learn.isLearnTarget
          ? 'transport — learning…'
          : `${playing ? 'stop' : 'play'}${learn.learning && learn.bindingLabel ? ' · ' + learn.bindingLabel : ''}`
      }
      className={[
        'relative px-6 py-3 border uppercase tracking-widest text-xs transition-colors',
        learn.isLearnTarget
          ? 'border-white'
          : learn.learning && learn.bound
            ? 'border-white/40'
            : 'border-white/15 hover:border-white',
      ].join(' ')}
    >
      {playing ? '■ stop' : '▶ play'}
    </button>
  );
}

export function TapTempoButton() {
  const learn = useMidiLearn('transport:tap-tempo');
  const handleClick = () => {
    if (learn.onLearnClick) {
      learn.onLearnClick();
      return;
    }
    tapTempo();
  };
  return (
    <button
      onClick={handleClick}
      title={
        learn.isLearnTarget
          ? 'tap tempo — learning…'
          : `tap tempo${learn.learning && learn.bindingLabel ? ' · ' + learn.bindingLabel : ''}`
      }
      className={[
        'px-3 py-1 text-[11px] uppercase tracking-widest border transition-colors',
        learn.isLearnTarget
          ? 'border-white text-white'
          : learn.learning && learn.bound
            ? 'border-white/40 text-white/80'
            : 'border-white/15 text-white/60 hover:text-white hover:border-white',
      ].join(' ')}
    >
      tap
    </button>
  );
}

function PresetControls() {
  const applyPreset = useSequencerStore((s) => s.applyPreset);
  const viewSection = useSequencerStore((s) => s.viewSection);
  const presets = presetsForTarget(viewSection);

  return (
    <div className="flex items-center gap-3 text-xs uppercase tracking-widest opacity-70">
      <select
        value=""
        onChange={(e) => {
          const id = e.target.value;
          if (id) applyPreset(id);
          e.target.value = '';
        }}
        className="select-chevron bg-transparent border border-white/15 pl-2 py-1 focus:outline-none focus:border-white text-white"
        title={`apply a preset to the ${viewSection === 'drum' ? 'rhythm' : 'melody'} rows`}
      >
        <option value="" className="bg-[#050505]">
          preset
        </option>
        {presets.map((p) => (
          <option key={p.id} value={p.id} className="bg-[#050505]">
            {p.label}
          </option>
        ))}
      </select>
    </div>
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
    <div className="globals flex items-center gap-x-6 gap-y-2 flex-wrap w-[550px]">
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
        <TapTempoButton />
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
      <PresetControls />
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
