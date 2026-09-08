import { useEffect, useState } from 'react';
import { PlayButton, RecordButton, CountInButton, MetronomeButton, MultiButton, TransportControls, InitButton, SongFileButtons, SongTitleInput, InstrumentDirtyBadge, loadProjectFromText, saveProject, loadProjectFromPicker } from './components/Transport';
import { saveAllVoiceEdits } from './instruments/saveInstrument';
import { unsavedVoiceLabels } from './instruments/voiceEditsStore';
import {
  adoptLoadedFile,
  computeDocDirtyNow,
  installDocumentTracking,
} from './state/document';
import { installSongDocBinding } from './state/songFileSync';
import { listen } from '@tauri-apps/api/event';
// Static import (not dynamic) — a dynamic import of a not-yet-optimized dep
// makes vite dev re-optimize and force-reload the page MID-BOOT, which boots
// the app twice and stacks two cpal streams (the zombie-stream noise mode).
import { getCurrentWindow, currentMonitor, LogicalSize } from '@tauri-apps/api/window';
import { PerformanceButton } from './components/PerformanceDialog';
import { ConfirmDialog } from './components/ConfirmDialog';
import { SettingsDialog } from './components/SettingsDialog';
import { TrackGrid } from './components/TrackGrid';
import { ChannelScreen, ScreenModeTabs } from './components/ChannelScreen';
import { MacroStrip } from './components/MacroStrip';
import { Toasts } from './components/Toasts';
import { BankPad } from './components/BankPad';
import { ScenePad } from './components/ScenePad';
import {
  useSequencerStore,
  type EditMode,
  type TrackSection,
} from './state/store';
import {
  armRepeat,
  releaseRepeat,
  repeatHeld,
} from './audio/perform';
import { sourceIsMelodic } from './instruments/library';
import type { ChordDegree } from './audio/chords';
import { togglePlayback, panicKill } from './audio/transport';
import { SongView } from './components/SongView';
import { isTauri, invoke } from '@tauri-apps/api/core';
import { installDispatcher } from './engine/dispatcher';
import { installParamPush } from './engine/paramPush';
import { installLfoPush } from './engine/lfoPush';
import { installSamplePreload } from './engine/samplePreload';
import {
  bootEngine,
  startSamplesBoot,
  installNativeAudio,
  installMixRoutingPush,
  installBpmSync,
  installClockSync,
  installChordRevoice,
  installGlitchDice,
} from './engine/boot';
import {
  installStreamPresence,
  installStreamSnapshot,
  installStreamInteractionEmit,
} from './stream/streamBridge';

const NATIVE = isTauri();


const MODE_KEYS: Record<string, EditMode> = {
  '1': 'live',
  '2': 'velocity',
  '3': 'chance',
  '4': 'ratchet',
  '5': 'timing',
  '6': 'gate',
};

const MODES: EditMode[] = ['live', 'velocity', 'chance', 'ratchet', 'timing', 'gate'];
// Display labels — the 'live' literal is kept for persistence compatibility,
// but the mode now shows the static authored pattern, so it reads as "notes".
const MODE_LABELS: Record<EditMode, string> = {
  live: 'notes',
  velocity: 'velocity',
  chance: 'chance',
  ratchet: 'ratchet',
  timing: 'timing',
  gate: 'gate',
};

const SECTIONS: { id: TrackSection; label: string }[] = [
  { id: 'drum', label: 'rhythm' },
  { id: 'melodic', label: 'melody' },
];

function SamplesSplash() {
  // Cover the whole window. z-[100] sits above modals/portals; the splash owns
  // the screen until bootDone. Terminal-style minimal text matching the rest of
  // the app's aesthetic. The samples dir scan reports no incremental count, so
  // this is an indeterminate loading state (near-instant on native pathsOnly).
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-[#050505]">
      <div className="flex flex-col items-center gap-3 text-white">
        <div className="text-[11px] uppercase tracking-[0.3em] opacity-70">
          newspeech sequence
        </div>
        <div className="text-[10px] uppercase tracking-widest opacity-40">
          loading samples …
        </div>
      </div>
    </div>
  );
}

function SectionToggle() {
  const viewSection = useSequencerStore((s) => s.viewSection);
  const setViewSection = useSequencerStore((s) => s.setViewSection);
  return (
    <div className="flex gap-2 text-[11px] uppercase tracking-widest">
      {SECTIONS.map((s) => (
        <button
          key={s.id}
          onClick={() => setViewSection(s.id)}
          className={[
            'px-3 py-1.5 border transition-colors',
            viewSection === s.id
              ? 'bg-white text-ink border-white'
              : 'border-white/15 text-white/60 hover:text-white hover:border-white',
          ].join(' ')}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}

function ModeSwitcher() {
  const editMode = useSequencerStore((s) => s.editMode);
  const setEditMode = useSequencerStore((s) => s.setEditMode);
  return (
    <div className="flex gap-2 text-[11px] uppercase tracking-widest">
      {MODES.map((m) => (
        <button
          key={m}
          onClick={() => setEditMode(m)}
          className={[
            'px-3 py-1.5 border transition-colors',
            editMode === m
              ? 'bg-white text-ink border-white'
              : 'border-white/15 text-white/60 hover:text-white hover:border-white',
          ].join(' ')}
        >
          {MODE_LABELS[m]}
        </button>
      ))}
    </div>
  );
}

export function App() {
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Sample-load splash. Covers the brief window while the samples dir is
  // scanned + manifests register on boot, so the user never sees a half-loaded
  // library. Near-instant on native (pathsOnly — no decode pass).
  const bootDone = useSequencerStore((s) => s.bootDone);
  // Unsaved-changes prompt: which close path is being held while the user
  // decides. 'window' = red button / Cmd+W (we preventDefault'ed the close);
  // 'quit' = Cmd+Q (Rust prevent_exit'ed and pinged quit-requested).
  const [closeIntent, setCloseIntent] = useState<null | 'window' | 'quit'>(null);
  const instrumentGate = useSequencerStore((s) => s.instrumentGate);

  // Leave for real — resume whichever path was held. quit_app exits with
  // code Some(0), which passes straight through the Rust exit hold.
  const proceedClose = async (intent: 'window' | 'quit') => {
    if (intent === 'quit') {
      try {
        await invoke('quit_app');
      } catch (err) {
        console.error('[quit] failed:', err);
      }
    } else {
      // destroy(), not close() — close() re-fires CloseRequested, and the
      // store's docDirty is still true at this point, so it would just
      // re-open the prompt. Needs core:window:allow-destroy in capabilities.
      try {
        await getCurrentWindow().destroy();
      } catch (err) {
        console.error('[close] destroy failed:', err);
      }
    }
  };

  // Fit-to-screen. The layout is designed for 1500×920 logical; 13" MacBooks
  // are 1440×900. The window can shrink below the design size (tauri.conf
  // minWidth 1024) and the whole UI zooms down uniformly — same layout,
  // slightly smaller, nothing clips. Zoom only ever scales DOWN (capped at 1).
  useEffect(() => {
    const DESIGN_W = 1500;
    const DESIGN_H = 920;
    const fit = () => {
      const zoom = Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H, 1);
      document.documentElement.style.setProperty('zoom', String(zoom));
    };
    fit();
    window.addEventListener('resize', fit);
    // The fixed 1500×960 initial window opens partially offscreen on a
    // smaller display — clamp it to the monitor once at boot (size isn't
    // persisted, so this runs every launch on small screens).
    if (NATIVE) {
      void (async () => {
        try {
          const mon = await currentMonitor();
          if (!mon) return;
          const s = mon.size.toLogical(mon.scaleFactor);
          if (s.width < 1500 || s.height < 960) {
            const win = getCurrentWindow();
            // -70 leaves room for the menu bar + window title bar.
            await win.setSize(
              new LogicalSize(Math.min(s.width, 1500), Math.min(s.height - 70, 960)),
            );
            await win.center();
          }
        } catch (err) {
          console.error('[fit] monitor clamp failed:', err);
        }
      })();
    }
    return () => window.removeEventListener('resize', fit);
  }, []);

  useEffect(() => {
    if (NATIVE) document.body.classList.add('tauri-native');
    return bootEngine({ initProject: NATIVE, controllers: NATIVE });
  }, []);

  // Document binding — dirty tracking + native window title. The title
  // mirrors the bound file (or the song title when unbound) macOS-document
  // style: "Sequence — name — edited".
  useEffect(() => {
    installDocumentTracking();
    // Rebind the document to the incoming slot's .seq on performance song
    // swaps (manual, tail-out commit, ghost set-advance).
    installSongDocBinding();
    if (!NATIVE) return;
    const applyTitle = async (s: {
      docPath: string | null;
      docDirty: boolean;
      songTitle: string | null;
    }) => {
      const name = s.docPath
        ? s.docPath.split('/').pop()
        : s.songTitle || 'untitled';
      try {
        await getCurrentWindow().setTitle(
          `Sequence — ${name}${s.docDirty ? ' — edited' : ''}`,
        );
      } catch (err) {
        console.warn('[doc title] setTitle failed:', err);
      }
    };
    void applyTitle(useSequencerStore.getState());
    const unsub = useSequencerStore.subscribe((state, prev) => {
      if (
        state.docPath !== prev.docPath ||
        state.docDirty !== prev.docDirty ||
        state.songTitle !== prev.songTitle
      ) {
        void applyTitle(state);
      }
    });
    return unsub;
  }, []);

  // Unsaved-changes gate on both close paths. Window close (red button /
  // Cmd+W) is intercepted here via onCloseRequested; app quit (Cmd+Q) is
  // held in Rust (RunEvent::ExitRequested prevent_exit + quit-requested
  // ping) and answered here — both run the synchronous dirty compare, so
  // an edit made inside the 400ms debounce window still hits the prompt.
  useEffect(() => {
    if (!NATIVE) return;
    const unlistenClose = getCurrentWindow().onCloseRequested((e) => {
      if (computeDocDirtyNow()) {
        e.preventDefault();
        setCloseIntent('window');
      }
    });
    const unlistenQuit = listen('quit-requested', () => {
      if (computeDocDirtyNow()) {
        setCloseIntent('quit');
      } else {
        void invoke('quit_app').catch((err) =>
          console.error('[quit] failed:', err),
        );
      }
    });
    return () => {
      void unlistenClose.then((u) => u());
      void unlistenQuit.then((u) => u());
    };
  }, []);

  // Finder "open with Sequence" — .seq double-click / drop on the dock icon.
  // The Rust side buffers the paths (cold-launch opens race webview boot)
  // and pings; drain the buffer at boot and on every ping. take_* clears
  // atomically, so the boot drain and a ping-triggered drain never
  // double-load the same file.
  useEffect(() => {
    if (!NATIVE) return;
    let disposed = false;
    const drain = async () => {
      try {
        const paths = await invoke<string[]>('take_pending_open_files');
        if (disposed || paths.length === 0) return;
        // Multiple files selected → the last one wins (single-document app).
        const path = paths[paths.length - 1];
        const text = await invoke<string>('read_text_file', { path });
        if (loadProjectFromText(text)) adoptLoadedFile(path);
      } catch (err) {
        console.error('[open-file] failed:', err);
      }
    };
    const unlisten = listen('open-files-pending', () => void drain());
    void drain();
    return () => {
      disposed = true;
      void unlisten.then((u) => u());
    };
  }, []);

  // Drag-and-drop a .seq file onto the window to load it into the current
  // song. The window runs with Tauri `dragDropEnabled: false` (so in-page
  // pad-reorder DnD works), which means the WKWebView delivers OS file drops
  // as standard HTML5 drop events — same path as the web build, File.text().
  useEffect(() => {
    const isSeq = (name: string) => /\.(seq|seqcomp|json)$/i.test(name);
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    // Suppress the WebView's default "open the dropped file" navigation.
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      const file = Array.from(e.dataTransfer?.files ?? []).find((f) => isSeq(f.name));
      if (!file) return;
      void (async () => {
        if (!loadProjectFromText(await file.text())) return;
        // HTML5 File objects carry no filesystem path, but on macOS the drag
        // pasteboard still holds the dragged file URLs at drop time — ask the
        // Rust side so the drop binds the document to its real path (Cmd+S
        // then overwrites in place). Basename must match the dropped file;
        // on any mismatch/failure the load stands, just unbound (save-as).
        let path: string | null = null;
        if (NATIVE) {
          try {
            const paths = await invoke<string[]>('drag_pasteboard_paths');
            path = paths.find((p) => p.split('/').pop() === file.name) ?? null;
          } catch (err) {
            console.warn('[song drop] pasteboard path lookup failed:', err);
          }
        }
        adoptLoadedFile(path, file.name);
      })();
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, []);

  useEffect(() => {
    startSamplesBoot();
  }, []);

  useEffect(() => installStreamPresence(), []);

  useEffect(() => installDispatcher(), []);

  useEffect(() => installChordRevoice(), []);

  useEffect(() => installBpmSync(), []);

  useEffect(() => installClockSync(), []);


  useEffect(() => installStreamSnapshot(), []);

  useEffect(() => installStreamInteractionEmit(), []);

  useEffect(() => installNativeAudio({ recorder: true }), []);

  useEffect(() => installMixRoutingPush(), []);

  useEffect(() => {
    if (!bootDone) return;
    return installParamPush();
  }, [bootDone]);

  useEffect(() => {
    if (!bootDone) return;
    return installLfoPush();
  }, [bootDone]);

  useEffect(() => installGlitchDice(), []);

  useEffect(() => {
    if (!bootDone) return;
    return installSamplePreload();
  }, [bootDone]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Panic kill — Cmd/Ctrl + . — checked BEFORE the input-focus guard so it
      // fires from anywhere (a runaway delay/reverb shouldn't be un-killable
      // just because a text field has focus). Stops transport, hard-kills
      // voices, clears the FX tails.
      if ((e.metaKey || e.ctrlKey) && (e.key === '.' || e.code === 'Period')) {
        e.preventDefault();
        panicKill();
        return;
      }

      // Document shortcuts — Cmd/Ctrl+S save (silently overwrites the bound
      // .seq; Shift forces save-as), Cmd/Ctrl+O open. Also ahead of the
      // input-focus guard: saving must work while a text field has focus.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void saveProject({ as: e.shiftKey });
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void loadProjectFromPicker();
        return;
      }

      const tag = (document.activeElement?.tagName || '').toUpperCase();
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

      // Stream window — deliberately unlisted: no UI button, just this chord.
      // (After the input-focus guard so it can't shadow paste-and-match-style
      // in text fields.)
      if (NATIVE && (e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'v') {
        e.preventDefault();
        void invoke('toggle_stream_window').catch((err) =>
          console.error('toggle_stream_window failed', err)
        );
        return;
      }

      if (e.key === ' ' || e.code === 'Space') {
        e.preventDefault();
        togglePlayback();
        return;
      }

      const lower = e.key.toLowerCase();

      // Perform beat-repeat — hold `r` to punch in (momentary; released on
      // keyup/blur below), number row 1..9 switches the repeat length while
      // held (16 steps → 1/16 of a step). Checked BEFORE the edit-mode keys
      // so the digits are repeat lengths only for the duration of the hold.
      if (lower === 'r') {
        e.preventDefault();
        if (!e.repeat) armRepeat();
        return;
      }
      if (repeatHeld() && lower >= '1' && lower <= '9') {
        e.preventDefault();
        armRepeat(Number(lower) - 1);
        return;
      }

      const mode = MODE_KEYS[lower];
      if (mode) {
        e.preventDefault();
        useSequencerStore.getState().setEditMode(mode);
        return;
      }

      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      const store = useSequencerStore.getState();
      const sel = store.selectedStep;
      if (!sel) return;
      const track = store.tracks.find((t) => t.id === sel.trackId);
      const step = track?.steps[sel.index];
      if (!track || !step?.on) return;
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const editMode = store.editMode;
      if (editMode === 'velocity') {
        store.setStepVelocity(
          sel.trackId,
          sel.index,
          Math.max(0, Math.min(1, step.velocity + 0.05 * dir))
        );
      } else if (editMode === 'chance') {
        store.setStepProbability(
          sel.trackId,
          sel.index,
          Math.max(0, Math.min(100, step.probability + 5 * dir))
        );
      } else if (editMode === 'ratchet') {
        store.setStepRatchet(
          sel.trackId,
          sel.index,
          Math.max(1, Math.min(8, step.ratchet + dir))
        );
      } else if (editMode === 'timing') {
        store.setStepMicroTiming(
          sel.trackId,
          sel.index,
          Math.max(-0.5, Math.min(0.5, step.microTiming + 0.05 * dir))
        );
      } else if (editMode === 'gate') {
        store.setStepGate(
          sel.trackId,
          sel.index,
          Math.max(0.1, Math.min(2, step.gate + 0.05 * dir))
        );
      } else if (editMode === 'live' && sourceIsMelodic(track.source)) {
        // Walk the chord degree when this step is actually playing a chord
        // at dispatch: chord master (always reads voicing) OR a 'semitones'
        // follower whose effective voicing has degree > 0 (an authored chord
        // override). Other follower modes (chord-tone / root-follow /
        // scale-tone) ignore stepVoicing at dispatch, so walking degree
        // there would be silent — fall through to pitch instead.
        // Extension/inversion/spread stay mouse-only in the inspector.
        const isChordMaster =
          store.tracks.find((t) => t.section === 'melodic')?.id === track.id;
        const voicing = step.chordVoicing ?? track.defaultChordVoicing;
        const walkDegree =
          isChordMaster ||
          (track.pitchInterp === 'semitones' && voicing.degree > 0);
        if (walkDegree) {
          const nextDegree = Math.max(0, Math.min(7, voicing.degree + dir)) as ChordDegree;
          if (nextDegree !== voicing.degree) {
            store.setStepChordVoicing(sel.trackId, sel.index, {
              ...voicing,
              degree: nextDegree,
            });
          }
        } else {
          store.setStepPitch(
            sel.trackId,
            sel.index,
            Math.max(-14, Math.min(14, step.pitch + dir))
          );
        }
      }
    };
    // Momentary release for the perform repeat — keyup on `r`, plus window
    // blur so a Cmd-Tab mid-hold can't leave the repeat stuck engaged.
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === 'r') releaseRepeat();
    };
    const handleBlur = () => releaseRepeat();
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  return (
    <div className="relative w-full">
      {!bootDone && <SamplesSplash />}
      <main
        className={
          NATIVE
            ? 'min-h-screen flex items-center justify-center px-4 py-4'
            : 'min-h-screen flex items-center justify-center px-10 py-12'
        }
      >
        <div
          className={
            NATIVE
              ? 'flex flex-col gap-6'
              : 'flex flex-col gap-8 border border-white/15 rounded-[20px] p-10'
          }
        >
          <div className="flex justify-between items-center gap-8">
            <div className="flex flex-col gap-4 items-start">
            {/* Title row — logo, then song title + save/load, then the
                settings / stream-window utilities, on the 20px control
                scale. */}
            <div className="flex items-center gap-2">
              <span className="text-[12px] uppercase tracking-[0.12em] opacity-55">
                {NATIVE ? (
                  <>newspeech <span className="opacity-50">|</span> sequence</>
                ) : (
                  <>
                    <a href="/" className="hover:opacity-100 transition-opacity">newspeech</a>
                    <span className="opacity-50"> | </span>
                    <span>sequence</span>
                    <span className="opacity-50"> | </span>
                    <a href="/sequencer-readme.html" className="hover:opacity-100 transition-opacity">readme.txt</a>
                  </>
                )}
              </span>
              <SongTitleInput />
              <SongFileButtons />
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                title="settings"
                aria-label="settings"
                style={{ width: 20, height: 20 }}
                className="bg-transparent border border-white/15 hover:border-white/50 transition-colors inline-flex items-center justify-center"
              >
                <svg viewBox="0 0 14 14" width="12" height="12">
                  <circle cx="3" cy="7" r="1" fill="white" fillOpacity="0.6" />
                  <circle cx="7" cy="7" r="1" fill="white" fillOpacity="0.6" />
                  <circle cx="11" cy="7" r="1" fill="white" fillOpacity="0.6" />
                </svg>
              </button>
              {/* Stream window is deliberately unlisted here — no button.
                  Toggle via Cmd/Ctrl+Shift+V (see the keydown handler). */}
              <InstrumentDirtyBadge />
            </div>
            <ScreenModeTabs />
            </div>
            <MacroStrip />
          </div>
          {/* Multi-mode screen. Mode tabs live in the title row above (beside
              the logo); this is the body. Scope + GhostDebug removed. */}
          <ChannelScreen />
          <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
          {closeIntent && (
            <ConfirmDialog
              title="unsaved changes"
              body={
                <>
                  “{useSequencerStore.getState().songTitle || 'untitled'}” has
                  unsaved changes.
                </>
              }
              confirmLabel={closeIntent === 'quit' ? 'save & quit' : 'save & close'}
              secondaryLabel={
                closeIntent === 'quit' ? 'quit without saving' : 'close without saving'
              }
              cancelLabel="cancel"
              onConfirm={() => {
                const intent = closeIntent;
                void (async () => {
                  // Skip the unsaved-instruments gate on quit — instrument
                  // edits survive restarts (localStorage), so quitting isn't
                  // lossy for them the way a portable .seq save is.
                  await saveProject({ skipInstrumentGate: true });
                  // An unbound song runs save-as here, which can be
                  // cancelled — only leave if the save actually landed.
                  if (!useSequencerStore.getState().docDirty) {
                    await proceedClose(intent);
                  } else {
                    setCloseIntent(null);
                  }
                })();
              }}
              onSecondary={() => void proceedClose(closeIntent)}
              onCancel={() => setCloseIntent(null)}
            />
          )}
          {instrumentGate && (
            <ConfirmDialog
              title="unsaved instruments"
              body={
                <>
                  unsaved instrument edits: {unsavedVoiceLabels().join(', ')}.
                  {instrumentGate.saveSong
                    ? ' these live only on this machine until saved into their kits — a .seq saved now plays stock instruments anywhere else.'
                    : ' save them into their kits to make them permanent everywhere.'}
                </>
              }
              confirmLabel={
                instrumentGate.saveSong ? 'save instruments & song' : 'save instruments'
              }
              secondaryLabel={instrumentGate.saveSong ? 'save song only' : undefined}
              onConfirm={() => {
                const gate = instrumentGate;
                useSequencerStore.setState({ instrumentGate: null });
                void (async () => {
                  const result = await saveAllVoiceEdits();
                  if (result.skipped.length > 0 || result.errors.length > 0) {
                    console.warn('[instruments] save-all:', result);
                  }
                  if (gate.saveSong) {
                    await saveProject({ as: gate.as, skipInstrumentGate: true });
                  }
                })();
              }}
              onSecondary={
                instrumentGate.saveSong
                  ? () => {
                      const gate = instrumentGate;
                      useSequencerStore.setState({ instrumentGate: null });
                      void saveProject({ as: gate.as, skipInstrumentGate: true });
                    }
                  : undefined
              }
              onCancel={() => useSequencerStore.setState({ instrumentGate: null })}
            />
          )}
          <div className="flex justify-between items-center gap-8 -my-4">
            <div className="flex items-center gap-2">
              <InitButton />
              <PerformanceButton />
              <SongView />
            </div>
            <div className="flex items-center gap-8">
              <ScenePad />
              <BankPad />
            </div>
          </div>
          <TrackGrid />
          <div className="transport flex flex-col items-stretch gap-3">
            <div className="flex items-center justify-between gap-8">
              <div className="flex items-center gap-3">
                <PlayButton />
                <RecordButton />
                <CountInButton />
                <MetronomeButton />
                <MultiButton />
              </div>
              <div className="flex items-center gap-4">
                <SectionToggle />
                <span className="w-px h-6 bg-white/15" />
                <ModeSwitcher />
              </div>
            </div>
            <div className="flex items-center gap-8 flex-wrap">
              <TransportControls />
            </div>
          </div>
        </div>
      </main>
      <Toasts />
    </div>
  );
}
