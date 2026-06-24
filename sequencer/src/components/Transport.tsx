import { useEffect, useRef, useState } from 'react';
import { useSequencerStore } from '../state/store';
import { togglePlayback, tapTempo } from '../audio/transport';
import { NOTE_NAMES, SCALES } from '../audio/scale';
import { exportProject, importProject, filenameSlug } from '../state/persist';
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

// .seqcomp accepted on import for back-compat with the short-lived
// 2026-05-24 intermediate naming; save always writes .seq going forward.
const SONG_FILTER = [{ name: 'newspeech song', extensions: ['seq', 'seqcomp'] }];

// Canonical "save current song as .seq" action — single source of truth
// for the song-save flow. Uses the active song's name (if any) for the
// default filename so successive saves of the same song reuse the slug.
export async function saveProject() {
  const state = useSequencerStore.getState();
  const code = exportProject();
  const activeSong =
    state.performance.activeSong !== null
      ? state.performance.songs[state.performance.activeSong]
      : null;
  const defaultName = `${filenameSlug(activeSong?.name, 'newspeech-song')}.seq`;
  if (isTauri()) {
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
    try {
      await invoke('save_text_file', { path: picked, contents: code });
    } catch (err) {
      console.error('[song save] failed:', err);
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

// Load .seq text into the CURRENT working state (replaces tracks/banks/macros).
// Shared by the import button, its web file-input fallback, and drag-and-drop.
export function loadProjectFromText(text: string): boolean {
  const ok = importProject(text);
  if (!ok) console.error('[song load] invalid or unparseable .seq');
  return ok;
}

// Open a .seq via the native picker (Tauri). Web import goes through the
// button's hidden <input> instead — WKWebView ignores <input type=file>.
export async function loadProjectFromPicker(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { open: pickFile } = await import('@tauri-apps/plugin-dialog');
    const picked = await pickFile({ multiple: false, filters: SONG_FILTER });
    if (!picked || typeof picked !== 'string') return;
    const text = await invoke<string>('read_text_file', { path: picked });
    loadProjectFromText(text);
  } catch (err) {
    console.error('[song load] failed:', err);
  }
}

// Toolbar — save / load the current song as a single .seq file. Two icon
// buttons (download = save, upload = load) mirroring the .midimap pair in the
// MIDI bar. Save is the primary authoring action; load replaces the working
// state directly (the perf dialog handles SET-level / per-slot song loads).
export function SongFileButtons() {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="flex items-center gap-1">
      <IconButton
        title="save the current song as a .seq file"
        className="h-[28px]"
        onClick={() => void saveProject()}
      >
        <DownloadIcon />
      </IconButton>
      <IconButton
        title="load a .seq file into the current song"
        className="h-[28px]"
        onClick={() => {
          if (isTauri()) void loadProjectFromPicker();
          else fileRef.current?.click();
        }}
      >
        <ImportIcon />
      </IconButton>
      <input
        ref={fileRef}
        type="file"
        accept=".seq,.seqcomp,.json,application/json,text/plain"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          loadProjectFromText(await file.text());
        }}
      />
    </div>
  );
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
  const following = useSequencerStore((s) => s.syncSource === 'external');
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
      disabled={following}
      title={
        following
          ? 'following external transport — start/stop from the master'
          : learn.isLearnTarget
            ? 'transport — learning…'
            : `${playing ? 'stop' : 'play'}${learn.learning && learn.bindingLabel ? ' · ' + learn.bindingLabel : ''}`
      }
      className={[
        'relative px-6 py-3 border uppercase tracking-widest text-xs transition-colors',
        following
          ? 'border-white/10 text-white/30 cursor-default'
          : learn.isLearnTarget
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

// MultitrackButton removed 2026-05-22 — multi-out routing (per-track to
// separate physical channels) handles this workflow better than 16 WAV
// files. The store's `multitrack` flag stays so old session files load
// cleanly, but the button + the recording flow are gone.

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

// MetronomeButton — toggles the universal metronome: the same click voice as
// the count-in, sounding on every beat for as long as transport runs. Labeled
// circle modifier, same family as CountInButton. Native click is SECTION_NONE
// so it plays live but stays out of recordings.
export function MetronomeButton() {
  const metronome = useSequencerStore((s) => s.metronome);
  const toggleMetronome = useSequencerStore((s) => s.toggleMetronome);
  return (
    <button
      onClick={toggleMetronome}
      title={
        metronome
          ? 'metronome on — click on every beat (not recorded)'
          : 'metronome off'
      }
      className={[
        'px-2 py-1 text-[11px] uppercase tracking-widest transition-colors',
        metronome ? 'text-white' : 'text-white/40 hover:text-white',
      ].join(' ')}
    >
      {metronome ? '●' : '○'} metro
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
        title="init — reset all tracks, LFOs, and macros to a blank state (keeps bpm, root, scale, master FX, and saved banks)"
        className="px-2 text-[11px] uppercase tracking-widest border border-white/15 text-white/60 hover:text-white hover:border-white transition-colors inline-flex items-center justify-center h-[28px]"
      >
        I
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

// Buffered BPM field. The store's setBpm clamps to 40–240, so binding a
// controlled input straight to it makes intermediate keystrokes
// un-typeable (typing "2" toward "200" clamps to 40 and snaps the field
// back). Instead we hold a local string draft while editing and commit
// (parse + clamp via setBpm) only on blur or Enter. The draft re-syncs
// from the store when bpm changes externally (tap tempo, scene load).
function BpmInput({
  bpm,
  setBpm,
  following = false,
}: {
  bpm: number;
  setBpm: (n: number) => void;
  // When following an external clock the tempo is owned by the master — the
  // field becomes a read-only readout of the tracked BPM, shown at reduced
  // weight (displaced-indicator convention) rather than disappearing.
  following?: boolean;
}) {
  const [draft, setDraft] = useState(String(bpm));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(String(bpm));
  }, [bpm, editing]);

  const commit = () => {
    setEditing(false);
    const parsed = Number(draft);
    if (Number.isFinite(parsed)) setBpm(parsed);
    else setDraft(String(bpm));
  };

  if (following) {
    return (
      <input
        type="number"
        value={Math.round(bpm)}
        readOnly
        tabIndex={-1}
        title="tempo follows the external clock master"
        className="w-20 bg-transparent border border-white/10 px-2 tabular-nums text-[11px] text-white/50 focus:outline-none h-[28px] cursor-default"
      />
    );
  }

  return (
    <input
      type="number"
      min={40}
      max={240}
      value={draft}
      onFocus={() => setEditing(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      className="w-20 bg-transparent border border-white/15 px-2 tabular-nums text-[11px] focus:outline-none focus:border-white h-[28px]"
    />
  );
}

export function TransportControls() {
  const bpm = useSequencerStore((s) => s.bpm);
  const rootNote = useSequencerStore((s) => s.rootNote);
  const scale = useSequencerStore((s) => s.scale);
  const setBpm = useSequencerStore((s) => s.setBpm);
  const setRootNote = useSequencerStore((s) => s.setRootNote);
  const setScale = useSequencerStore((s) => s.setScale);
  const following = useSequencerStore((s) => s.syncSource === 'external');

  const rootName = NOTE_NAMES[rootNote % 12];

  return (
    <div className="globals flex items-center gap-4 flex-wrap">
      <label className="flex items-center gap-2 text-[11px] uppercase tracking-widest">
        <span className="opacity-55">bpm</span>
        <BpmInput bpm={bpm} setBpm={setBpm} following={following} />
        {!following && <TapTempoButton />}
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
