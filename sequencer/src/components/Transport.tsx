import { useRef, useState } from 'react';
import { useSequencerStore } from '../state/store';
import { togglePlayback, tapTempo } from '../audio/transport';
import { NOTE_NAMES, SCALES } from '../audio/scale';
import { exportProject, importProject, timestampSlug } from '../state/persist';
import { presetsForTarget } from '../instruments/library';
import { useMidiLearn } from '../hooks/useMidiLearn';
import { ConfirmDialog } from './ConfirmDialog';
import { InstrumentLibraryDialog } from './InstrumentLibraryDialog';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  getActiveAudioOutputId,
  isSetSinkIdSupported,
  requestDeviceLabels,
  setActiveAudioOutput,
} from '../audio/audioOutput';
import { useAudioOutputs } from '../hooks/useAudioOutputs';

const SEQ_FILTER = [{ name: 'newspeech sequence', extensions: ['seq'] }];

async function saveProject() {
  const code = exportProject();
  const defaultName = `newspeech-${timestampSlug()}.seq`;
  if (isTauri()) {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { documentDir, join } = await import('@tauri-apps/api/path');
    let defaultPath: string | undefined;
    try {
      defaultPath = await join(await documentDir(), defaultName);
    } catch {
      defaultPath = defaultName;
    }
    const picked = await save({ defaultPath, filters: SEQ_FILTER });
    if (!picked) return;
    try {
      await invoke('save_text_file', { path: picked, contents: code });
    } catch (err) {
      console.error('[project] save failed:', err);
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
}

async function openProjectViaDialog(): Promise<void> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ multiple: false, filters: SEQ_FILTER });
  if (!picked || typeof picked !== 'string') return;
  try {
    const text = await invoke<string>('read_text_file', { path: picked });
    const ok = importProject(text);
    if (!ok) console.warn('[project] failed to import sequence file');
  } catch (err) {
    console.error('[project] open failed:', err);
  }
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

// SplitsButton — toggles two-WAV split recording (rhythm + melody). Forces
// sample-bus tap territory, so the `raw` toggle is implicit-on while this
// is active. Count-in clicks land in both files for DAW alignment.
// Mutually exclusive with `multitrack`.
export function SplitsButton() {
  const splits = useSequencerStore((s) => s.splits);
  const toggleSplits = useSequencerStore((s) => s.toggleSplits);
  return (
    <button
      onClick={toggleSplits}
      title={
        splits
          ? 'splits on — take exports rhythm + melody as separate WAVs (clicks land in both for alignment)'
          : 'splits off — take exports a single combined WAV'
      }
      className={[
        'px-2 py-1 text-[11px] uppercase tracking-widest transition-colors',
        splits ? 'text-white' : 'text-white/40 hover:text-white',
      ].join(' ')}
    >
      {splits ? '●' : '○'} splits
    </button>
  );
}

// MultitrackButton — toggles per-track recording. On = one WAV per audio
// track (16+ files for the default kit), each tapped pre-FX/pre-master from
// a dedicated per-track bus. Forces `raw` on as a UX coherence move since
// multitrack output is always raw signal. Mutually exclusive with `splits`.
// App-only: browser anchor-download would fire 16+ save prompts. Tauri
// streams each file to disk directly. Returns null in browser builds.
export function MultitrackButton() {
  const multitrack = useSequencerStore((s) => s.multitrack);
  const toggleMultitrack = useSequencerStore((s) => s.toggleMultitrack);
  if (!isTauri()) return null;
  return (
    <button
      onClick={toggleMultitrack}
      title={
        multitrack
          ? 'multitrack on — one WAV per voice track, pre-FX/pre-master. Raw is implicit-on.'
          : 'multitrack off — single combined WAV (or splits if enabled)'
      }
      className={[
        'px-2 py-1 text-[11px] uppercase tracking-widest transition-colors',
        multitrack ? 'text-white' : 'text-white/40 hover:text-white',
      ].join(' ')}
    >
      {multitrack ? '●' : '○'} multi
    </button>
  );
}

// AudioOutSelector — picks which physical output device gets the
// sequencer's audio. Backed by AudioContext.setSinkId (Safari 17+,
// Chromium 110+). Device labels are gated by media-permission state —
// browser/WKWebView returns empty labels until getUserMedia has been
// granted once. Selecting the "request names" sentinel triggers the
// permission prompt; from then on labels populate normally.
const REQUEST_LABELS_SENTINEL = '__request-labels__';
export function AudioOutSelector() {
  const outputs = useAudioOutputs();
  const [active, setActive] = useState<string | null>(() => getActiveAudioOutputId());
  const supported = isSetSinkIdSupported();
  // De-dupe the hardcoded "default" option from enumerateDevices output
  // (the OS often reports a device literally named "default" which would
  // otherwise duplicate the empty-value first option).
  const extra = outputs.filter((o) => o.deviceId !== 'default' && o.deviceId !== '');
  // Show the reveal-names button whenever extra devices exist but labels
  // are missing, AND whenever we only see "default" (which is the symptom
  // of media permission not yet granted in WKWebView).
  const labelsLookEmpty =
    extra.length === 0 || extra.some((o) => /^output \d+$/.test(o.label));
  if (!supported) {
    return (
      <span
        className="px-2 text-[11px] uppercase tracking-widest text-white/30 inline-flex items-center h-[28px]"
        title="setSinkId not supported by this browser/webview"
      >
        out: system
      </span>
    );
  }
  return (
    <select
      value={active ?? ''}
      onChange={async (e) => {
        const v = e.target.value;
        if (v === REQUEST_LABELS_SENTINEL) {
          await requestDeviceLabels();
          return;
        }
        try {
          await setActiveAudioOutput(v);
          setActive(v);
        } catch (err) {
          console.warn('[audioOut] setSinkId failed:', err);
        }
      }}
      className="select-chevron bg-transparent border border-white/15 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white max-w-[180px] h-[28px]"
      title="audio output device"
    >
      <option value="" className="bg-[#050505]">
        default
      </option>
      {extra.map((o) => (
        <option key={o.deviceId} value={o.deviceId} className="bg-[#050505]">
          {o.label}
        </option>
      ))}
      {labelsLookEmpty && (
        <option value={REQUEST_LABELS_SENTINEL} className="bg-[#050505]">
          + reveal device names
        </option>
      )}
    </select>
  );
}

// RawRecordButton — toggles the recorder's tap point. Off (default) =
// recorder captures master output (what the user hears). On = recorder
// captures voicesBus pre-FX (raw samples, no master / tape / glitch /
// reverb / saturation processing). Audible output is identical either
// way — this only swaps where the WAV's data comes from. For DAW
// workflows where the user wants the sequencer's character live but a
// clean source to process downstream.
export function RawRecordButton() {
  const recordRaw = useSequencerStore((s) => s.recordRaw);
  const toggleRecordRaw = useSequencerStore((s) => s.toggleRecordRaw);
  return (
    <button
      onClick={toggleRecordRaw}
      title={
        recordRaw
          ? 'recording the raw sample bus — master + FX bypassed in the WAV (you still hear the full mix)'
          : 'recording the full mix — master + FX baked into the WAV'
      }
      className={[
        'px-2 py-1 text-[11px] uppercase tracking-widest transition-colors',
        recordRaw ? 'text-white' : 'text-white/40 hover:text-white',
      ].join(' ')}
    >
      {recordRaw ? '●' : '○'} raw
    </button>
  );
}

// CountInButton — toggles the one-bar count-in cued before the first
// pattern step on the next play press. Visually a labeled circle, not a
// full button — sits next to PlayButton/RecordButton as a modifier rather
// than a primary action.
export function CountInButton() {
  const clickIn = useSequencerStore((s) => s.clickIn);
  const toggleClickIn = useSequencerStore((s) => s.toggleClickIn);
  return (
    <button
      onClick={toggleClickIn}
      title={
        clickIn
          ? 'count-in on — one bar of clicks before each play'
          : 'count-in off — play starts the pattern immediately'
      }
      className={[
        'px-2 py-1 text-[11px] uppercase tracking-widest transition-colors',
        clickIn ? 'text-white' : 'text-white/40 hover:text-white',
      ].join(' ')}
    >
      {clickIn ? '●' : '○'} count
    </button>
  );
}

// RecordButton — three visual states driven by (armed, playing):
//   idle  (!armed)            — dim border, hollow circle, "rec"
//   armed (armed, !playing)   — bright border, hollow circle, ready
//   recording (armed, playing) — inverted (white bg), filled circle
// The recorder module owns the actual capture lifecycle; this is purely a
// state-toggling control surface.
export function RecordButton() {
  const armed = useSequencerStore((s) => s.armed);
  const playing = useSequencerStore((s) => s.playing);
  const toggleArmed = useSequencerStore((s) => s.toggleArmed);
  const recording = armed && playing;

  const title = recording
    ? 'recording — click to stop and save the take'
    : armed
      ? 'armed — recording starts on next play'
      : 'arm recorder';

  return (
    <button
      onClick={toggleArmed}
      title={title}
      className={[
        'relative px-6 py-3 border uppercase tracking-widest text-xs transition-colors',
        recording
          ? 'bg-white text-ink border-white'
          : armed
            ? 'border-white text-white'
            : 'border-white/15 text-white/60 hover:border-white hover:text-white',
      ].join(' ')}
    >
      {recording ? '● rec' : '○ rec'}
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
        'px-2 text-[11px] uppercase tracking-widest border transition-colors inline-flex items-center justify-center h-[28px]',
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

export function InitButton() {
  const initProject = useSequencerStore((s) => s.initProject);
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setConfirming(true)}
        title="reset all tracks, LFOs, and macros to a blank state (keeps bpm, root, scale, master FX, and saved banks)"
        className="px-2 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors inline-flex items-center justify-center h-[28px]"
      >
        init
      </button>
      {confirming && (
        <ConfirmDialog
          title="init project"
          body="reset all tracks, LFOs, macros, and saved patterns to a blank state? bpm, root, scale, and master FX are preserved."
          confirmLabel="reset"
          onConfirm={() => {
            initProject();
            setConfirming(false);
          }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

export function PresetControls() {
  const applyPreset = useSequencerStore((s) => s.applyPreset);
  const viewSection = useSequencerStore((s) => s.viewSection);
  const presets = presetsForTarget(viewSection);

  return (
    <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest">
      <label className="flex items-center gap-2">
        <span className="opacity-55">preset</span>
        <select
          value=""
          onChange={(e) => {
            const id = e.target.value;
            if (id) applyPreset(id);
            e.target.value = '';
          }}
          className="select-chevron bg-transparent border border-white/15 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white h-[28px]"
          title={`apply a preset to the ${viewSection === 'drum' ? 'rhythm' : 'melody'} rows`}
        >
          <option value="" className="bg-[#050505]">
            select..
          </option>
          {presets.map((p) => (
            <option key={p.id} value={p.id} className="bg-[#050505]">
              {p.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export function ProjectFileControls() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const handleImport = async (file: File | null | undefined) => {
    if (!file) return;
    const text = await file.text();
    const ok = importProject(text);
    if (!ok) console.warn('failed to import sequence file');
  };
  const btn =
    'flex items-center gap-2 px-3 h-[28px] text-[11px] uppercase tracking-widest border border-white/15 text-white/70 hover:text-white hover:border-white transition-colors';
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button type="button" onClick={() => void saveProject()} className={btn}>
        <DownloadIcon />
        save current scene
      </button>
      <button
        type="button"
        onClick={() => {
          if (isTauri()) {
            void openProjectViaDialog();
          } else {
            fileInputRef.current?.click();
          }
        }}
        className={btn}
      >
        <ImportIcon />
        load saved scene
      </button>
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
  );
}

export function InstrumentLibraryButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="manage user MIDI instruments — edit, delete, export, import"
        className="px-2 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors inline-flex items-center justify-center h-[28px]"
      >
        instruments
      </button>
      <InstrumentLibraryDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function TransportControls() {
  const bpm = useSequencerStore((s) => s.bpm);
  const rootNote = useSequencerStore((s) => s.rootNote);
  const scale = useSequencerStore((s) => s.scale);
  const setBpm = useSequencerStore((s) => s.setBpm);
  const setRootNote = useSequencerStore((s) => s.setRootNote);
  const setScale = useSequencerStore((s) => s.setScale);

  const rootName = NOTE_NAMES[rootNote % 12];

  return (
    <div className="globals flex items-center gap-4 flex-wrap">
      <label className="flex items-center gap-2 text-[11px] uppercase tracking-widest">
        <span className="opacity-55">bpm</span>
        <input
          type="number"
          min={40}
          max={240}
          value={bpm}
          onChange={(e) => setBpm(Number(e.target.value))}
          className="w-20 bg-transparent border border-white/15 px-2 tabular-nums text-[11px] focus:outline-none focus:border-white h-[28px]"
        />
        <TapTempoButton />
      </label>
      <label className="flex items-center gap-2 text-[11px] uppercase tracking-widest">
        <span className="opacity-55">root</span>
        <select
          value={rootName}
          onChange={(e) => {
            const idx = NOTE_NAMES.indexOf(e.target.value);
            if (idx >= 0) setRootNote(60 + idx);
          }}
          className="select-chevron bg-transparent border border-white/15 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white h-[28px]"
        >
          {NOTE_NAMES.map((n) => (
            <option key={n} value={n} className="bg-[#050505]">
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 text-[11px] uppercase tracking-widest">
        <span className="opacity-55">scale</span>
        <select
          value={scale}
          onChange={(e) => setScale(e.target.value as typeof scale)}
          className="select-chevron bg-transparent border border-white/15 pl-2 text-[11px] uppercase tracking-widest text-white focus:outline-none focus:border-white h-[28px]"
        >
          {SCALES.map((s) => (
            <option key={s} value={s} className="bg-[#050505]">
              {s}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
