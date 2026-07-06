import { useEffect, useRef, useState } from 'react';
import { useSequencerStore } from '../state/store';
import { togglePlayback, tapTempo } from '../audio/transport';
import { NOTE_NAMES, SCALES } from '../audio/scale';
import { exportProject, importProject, filenameSlug } from '../state/persist';
import { setDocument, adoptLoadedFile } from '../state/document';
import { presetsForTarget } from '../instruments/library';
import { useMidiLearn } from '../hooks/useMidiLearn';
import { ConfirmDialog } from './ConfirmDialog';
import { InstrumentLibraryDialog } from './InstrumentLibraryDialog';
import { invoke, isTauri } from '@tauri-apps/api/core';

// .seqcomp accepted on import for back-compat with the short-lived
// 2026-05-24 intermediate naming; save always writes .seq going forward.
const SONG_FILTER = [{ name: 'newspeech song', extensions: ['seq', 'seqcomp'] }];

// Canonical "save current song" action — single source of truth for the
// song-save flow. When the working state is bound to a .seq on disk
// (docPath — set by open, drag-in, or a prior save-as) this overwrites it
// silently, document-app style. `as: true` (Cmd+Shift+S / shift-click)
// forces the dialog; the picked path becomes the binding, so the NEXT
// save is silent. An unbound save also runs the dialog.
export async function saveProject(opts: { as?: boolean } = {}) {
  const state = useSequencerStore.getState();
  if (isTauri()) {
    const boundPath = opts.as ? null : state.docPath;
    if (boundPath) {
      const code = exportProject();
      try {
        await invoke('save_text_file', { path: boundPath, contents: code });
        setDocument(boundPath, code);
      } catch (err) {
        console.error('[song save] failed:', err);
      }
      return;
    }
    const { save } = await import('@tauri-apps/plugin-dialog');
    const { documentDir, dirname, join } = await import('@tauri-apps/api/path');
    const activeSong =
      state.performance.activeSong !== null
        ? state.performance.songs[state.performance.activeSong]
        : null;
    const defaultName = `${filenameSlug(state.songTitle ?? activeSong?.name, 'newspeech-song')}.seq`;
    let defaultPath: string | undefined;
    try {
      // Save-as of an already-bound song starts next to the original file.
      const dir = state.docPath ? await dirname(state.docPath) : await documentDir();
      defaultPath = await join(dir, defaultName);
    } catch {
      defaultPath = defaultName;
    }
    const picked = await save({ defaultPath, filters: SONG_FILTER });
    if (!picked) return;
    // An untitled song takes its title from the chosen filename — set it
    // BEFORE exporting so the written .seq carries the name.
    if (!useSequencerStore.getState().songTitle) {
      const base = picked.split('/').pop() ?? '';
      useSequencerStore
        .getState()
        .setSongTitle(base.replace(/\.(seq|seqcomp|json)$/i, ''));
    }
    const code = exportProject();
    try {
      await invoke('save_text_file', { path: picked, contents: code });
      setDocument(picked, code);
    } catch (err) {
      console.error('[song save] failed:', err);
    }
    return;
  }
  const activeSong =
    state.performance.activeSong !== null
      ? state.performance.songs[state.performance.activeSong]
      : null;
  const defaultName = `${filenameSlug(state.songTitle ?? activeSong?.name, 'newspeech-song')}.seq`;
  const code = exportProject();
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
    if (loadProjectFromText(text)) adoptLoadedFile(picked);
  } catch (err) {
    console.error('[song load] failed:', err);
  }
}

// Save / load the current song as a single .seq file. Two icon buttons
// (download = save, upload = load) living in the top logo row next to the
// song title, at that row's 20px control scale (same box as the settings /
// stream-window buttons). Save is the primary authoring action; load
// replaces the working state directly (the perf dialog handles SET-level /
// per-slot song loads).
const TOP_BAR_BUTTON =
  'bg-transparent border border-white/15 hover:border-white/50 transition-colors inline-flex items-center justify-center text-white/60 hover:text-white';

export function SongFileButtons() {
  const fileRef = useRef<HTMLInputElement>(null);
  const docPath = useSequencerStore((s) => s.docPath);
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        title={
          docPath
            ? `save — overwrite ${docPath} · shift-click: save as…`
            : 'save the current song as a .seq file'
        }
        aria-label="save song"
        style={{ width: 20, height: 20 }}
        className={TOP_BAR_BUTTON}
        onClick={(e) => void saveProject({ as: e.shiftKey })}
      >
        <SaveIcon />
      </button>
      <button
        type="button"
        title="load a .seq file into the current song"
        aria-label="load song"
        style={{ width: 20, height: 20 }}
        className={TOP_BAR_BUTTON}
        onClick={() => {
          if (isTauri()) void loadProjectFromPicker();
          else fileRef.current?.click();
        }}
      >
        <ImportIcon />
      </button>
      <input
        ref={fileRef}
        type="file"
        accept=".seq,.seqcomp,.json,application/json,text/plain"
        style={{ display: 'none' }}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (!file) return;
          if (loadProjectFromText(await file.text())) {
            // Web builds never learn a path — title from the filename only.
            adoptLoadedFile(null, file.name);
          }
        }}
      />
    </div>
  );
}


// Editable song title — the document's name. Persisted into the .seq as
// `name`, used for the default save filename, and mirrored into the window
// title. Draft-buffered like BpmInput so the store only commits on blur /
// Enter. The ● prefix marks unsaved changes against the bound file
// (displaced next to the field rather than restyling the save button).
// Lives in the top logo row (beside the settings / stream-window buttons),
// sized to that row's 20px control scale — NOT the 28px toolbar scale.
export function SongTitleInput() {
  const songTitle = useSequencerStore((s) => s.songTitle);
  const setSongTitle = useSequencerStore((s) => s.setSongTitle);
  const docPath = useSequencerStore((s) => s.docPath);
  const docDirty = useSequencerStore((s) => s.docDirty);
  const [draft, setDraft] = useState(songTitle ?? '');
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setDraft(songTitle ?? '');
  }, [songTitle, editing]);

  const commit = () => {
    setEditing(false);
    setSongTitle(draft);
  };

  return (
    <label
      // -ml-2 cancels the input's px-2 so the (borderless) title text sits
      // flush with the logo text in the row above.
      className="flex items-center gap-1.5 text-[11px] tracking-widest -ml-2"
      title={
        docPath
          ? `${docPath}${docDirty ? ' — unsaved changes' : ''}`
          : 'song title — saved into the .seq and used as the default filename'
      }
    >
      <input
        type="text"
        value={draft}
        placeholder="untitled"
        spellCheck={false}
        onFocus={() => setEditing(true)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        // Reads as plain text in the logo row — the border only surfaces on
        // hover (editability hint) and focus. Transparent border, not
        // border-none, so nothing shifts when it appears.
        className="w-40 bg-transparent border border-transparent hover:border-white/15 focus:border-white/50 px-2 text-[11px] tracking-widest text-white/70 focus:text-white placeholder:text-white/25 focus:outline-none h-[20px]"
      />
      {docDirty && <span className="text-white/60 text-[8px]">●</span>}
    </label>
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
  onClick: (e: React.MouseEvent) => void;
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

// Floppy disk — the song-save button. Distinct from DownloadIcon, which the
// MIDI bar still uses for .midimap export (a true "download"-shaped action);
// song save overwrites a bound file, so it reads as "save".
export function SaveIcon() {
  return (
    <svg
      viewBox="0 0 14 14"
      width="12"
      height="12"
      stroke="currentColor"
      strokeWidth="1.2"
      fill="none"
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      <path d="M2.5 2.5 L9.5 2.5 L11.5 4.5 L11.5 11.5 L2.5 11.5 Z" />
      <path d="M4.5 2.5 L4.5 5.5 L9 5.5 L9 2.5" />
      <path d="M4.5 11.5 L4.5 8.5 L9.5 8.5" />
    </svg>
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

// MultiButton — the recording-mode toggle ("multi"). Off = a take bounces a
// single combined "quick mix" WAV. On = the full stems suite (native only):
// a sample-locked subfolder of master + fx + reverb + delay bus WAVs plus one
// dry WAV per track. Σ(track stems) + the bus stems reconstruct the master.
// Re-enabled 2026-07-05 — native per-track capture with off-thread WAV
// encoding makes in-app stems cheap (the web worklet version was the perf
// problem). Replaced the old splits/raw toggles (removed same day): the
// workflow is now just quick-mix vs full-suite. See project-sequencer memory.
export function MultiButton() {
  const multitrack = useSequencerStore((s) => s.multitrack);
  const toggleMultitrack = useSequencerStore((s) => s.toggleMultitrack);
  return (
    <button
      onClick={toggleMultitrack}
      title={
        multitrack
          ? 'multi on — take exports the full suite: master + fx + reverb + delay + one dry WAV per track (own subfolder)'
          : 'multi off — take bounces a single combined quick-mix WAV'
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
