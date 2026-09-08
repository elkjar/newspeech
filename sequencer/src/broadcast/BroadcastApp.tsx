// BROADCAST — autonomous set player over Sequence's engine. Phase 1 shell:
// boots the engine (same install order as App.tsx, minus editor-only
// pieces), loads a set from launch args / Finder open / drop, turns Ghost
// on and plays forever. The face is the stream window promoted to the whole
// app; the "65dos OS" desktop lands in Phase 2 (docs/broadcast-set.md).
import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSequencerStore } from '../state/store';
import { installDispatcher } from '../engine/dispatcher';
import { installParamPush } from '../engine/paramPush';
import { installLfoPush } from '../engine/lfoPush';
import { installSamplePreload } from '../engine/samplePreload';
import {
  bootEngine,
  startSamplesBoot,
  installNativeAudio,
  installMixRoutingPush,
  installBpmSync,
  installClockSync,
  installChordRevoice,
  installGlitchDice,
} from '../engine/boot';
import {
  installStreamPresence,
  installStreamSnapshot,
  installStreamInteractionEmit,
} from '../stream/streamBridge';
import { announceStreamPresence } from '../stream/streamEvents';
import { presetNativeDeviceName } from '../audio/nativeEngine';
import {
  getConfiguredUserSamplesDir,
  setConfiguredUserSamplesDir,
  resolveUserSamplesDir,
  scanAndLoadUserSamples,
} from '../instruments/userSamplesDir';
import { togglePlayback, panicKill } from '../audio/transport';
import { Datafeed } from '../stream/Datafeed';
import { Visualizer } from '../stream/Visualizer';
import { GlitchWrap } from '../stream/GlitchWrap';
import { TransitionCue } from '../stream/TransitionCue';
import { useTransitionCountIn } from '../stream/useTransitionCountIn';
import { useBroadcast, loadAndStartSet, addToSet } from './setlist';

const NATIVE = isTauri();

// Mirror console.* into the Rust log so unattended runs leave a trail
// (projectfs::js_log). Fire-and-forget; never throws into the caller.
if (NATIVE && !(window as { __nsLogMirror?: boolean }).__nsLogMirror) {
  (window as { __nsLogMirror?: boolean }).__nsLogMirror = true;
  const fmt = (args: unknown[]) =>
    args
      .map((a) => {
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ');
  for (const level of ['info', 'warn', 'error'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      void invoke('js_log', { level, message: fmt(args) }).catch(() => {});
    };
  }
  window.addEventListener('error', (e) => {
    void invoke('js_log', { level: 'error', message: `uncaught: ${e.message} @ ${e.filename}:${e.lineno}` }).catch(() => {});
  });
  window.addEventListener('unhandledrejection', (e) => {
    void invoke('js_log', { level: 'error', message: `unhandled rejection: ${String(e.reason)}` }).catch(() => {});
  });
}

interface LaunchArgs {
  set: string[];
  samples: string | null;
  device: string | null;
  // Dev: force every song to N bars.
  songBars: number | null;
}

function parseLaunchArgs(argv: string[]): LaunchArgs {
  const out: LaunchArgs = { set: [], samples: null, device: null, songBars: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? null;
    if (a === '--set') {
      const v = next();
      if (v) out.set.push(v);
    } else if (a.startsWith('--set=')) out.set.push(a.slice(6));
    else if (a === '--samples') out.samples = next();
    else if (a.startsWith('--samples=')) out.samples = a.slice(10);
    else if (a === '--device') out.device = next();
    else if (a.startsWith('--device=')) out.device = a.slice(9);
    else if (a === '--song-bars') out.songBars = Number(next()) || null;
    else if (a.startsWith('--song-bars=')) out.songBars = Number(a.slice(12)) || null;
    else if (!a.startsWith('-')) out.set.push(a); // bare path
  }
  return out;
}

// Engine wiring — mounted once launch args are known (samples dir and
// device must be seeded before the scan / device open). Same order as
// App.tsx so the two binaries behave identically.
function BroadcastEngine({ args }: { args: LaunchArgs }) {
  const bootDone = useSequencerStore((s) => s.bootDone);

  useEffect(() => {
    if (NATIVE) document.body.classList.add('tauri-native');
    return bootEngine({ initProject: false, controllers: false });
  }, []);
  useEffect(() => {
    if (args.samples) setConfiguredUserSamplesDir(args.samples);
    if (args.device) presetNativeDeviceName(args.device);
    useBroadcast.getState().setDevSongBars(args.songBars);
    startSamplesBoot();
  }, [args]);
  useEffect(() => installStreamPresence(), []);
  useEffect(() => {
    // Same webview is both emitter and listener — announce so the presence
    // gate lets our own emits through (see streamEvents.ts).
    let cleanup: (() => void) | undefined;
    void announceStreamPresence().then((fn) => {
      cleanup = fn;
    });
    return () => cleanup?.();
  }, []);
  useEffect(() => installDispatcher(), []);
  useEffect(() => installChordRevoice(), []);
  useEffect(() => installBpmSync(), []);
  useEffect(() => installClockSync(), []);
  useEffect(() => installStreamSnapshot(), []);
  useEffect(() => installStreamInteractionEmit(), []);
  useEffect(() => installNativeAudio({ recorder: false }), []);
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

  // Set sources: launch args, Finder open (buffered Rust-side), drops.
  useEffect(() => {
    if (!bootDone || !NATIVE) return;
    let disposed = false;
    const drain = async () => {
      try {
        const paths = await invoke<string[]>('take_pending_open_files');
        if (disposed || paths.length === 0) return;
        await addToSet(paths);
      } catch (err) {
        console.error('[broadcast] open-files drain failed:', err);
      }
    };
    if (args.set.length) void loadAndStartSet(args.set);
    const unlisten = listen('open-files-pending', () => void drain());
    void drain();
    return () => {
      disposed = true;
      void unlisten.then((u) => u());
    };
  }, [bootDone, args]);

  return null;
}

function useDropTarget(onPaths: (paths: string[]) => void) {
  useEffect(() => {
    const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
    const onOver = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      void (async () => {
        // HTML5 drops carry no filesystem paths; the macOS drag pasteboard
        // still does at drop time (same trick as Sequence's song drop).
        try {
          const paths = await invoke<string[]>('drag_pasteboard_paths');
          if (paths.length) onPaths(paths);
        } catch (err) {
          console.warn('[broadcast] pasteboard lookup failed:', err);
        }
      })();
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('drop', onDrop);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('drop', onDrop);
    };
  }, [onPaths]);
}

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function useUptime(startedAt: number | null): string {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (startedAt === null) return '--:--:--';
  const s = Math.floor((Date.now() - startedAt) / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

async function pickFolder(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const picked = await open({ directory: true, multiple: false });
  return typeof picked === 'string' ? picked : null;
}

export function BroadcastApp() {
  const [args, setArgs] = useState<LaunchArgs | null>(null);
  const [samplesDir, setSamplesDir] = useState<string | null>(null);
  const bootDone = useSequencerStore((s) => s.bootDone);
  const playing = useSequencerStore((s) => s.playing);
  const songTitle = useSequencerStore((s) => s.songTitle);
  const bpm = useSequencerStore((s) => s.bpm);
  const rootNote = useSequencerStore((s) => s.rootNote);
  const scale = useSequencerStore((s) => s.scale);
  const b = useBroadcast();
  const uptime = useUptime(b.startedAt);
  const count = useTransitionCountIn();

  useEffect(() => {
    void (async () => {
      let argv: string[] = [];
      if (NATIVE) {
        try {
          argv = await invoke<string[]>('launch_args');
        } catch (err) {
          console.warn('[broadcast] launch_args failed:', err);
        }
      }
      setArgs(parseLaunchArgs(argv));
    })();
  }, []);

  useEffect(() => {
    if (!bootDone) return;
    void resolveUserSamplesDir().then(setSamplesDir);
  }, [bootDone]);

  useDropTarget((paths) => void addToSet(paths));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === '.' || e.code === 'Period')) {
        e.preventDefault();
        panicKill();
        return;
      }
      if (e.code === 'Space' && b.status === 'running') {
        e.preventDefault();
        void togglePlayback();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [b.status]);

  const changeSamples = async () => {
    const dir = await pickFolder();
    if (!dir) return;
    setConfiguredUserSamplesDir(dir);
    setSamplesDir(dir);
    const r = await scanAndLoadUserSamples();
    console.info(`[broadcast] rescanned samples: ${r.loaded} kit(s)`);
  };
  const chooseSet = async () => {
    const dir = await pickFolder();
    if (dir) void loadAndStartSet([dir]);
  };

  const idx = b.current !== null ? b.current + 1 : 0;
  const key = `${NOTE_NAMES[((rootNote % 12) + 12) % 12]} ${scale}`;

  return (
    <div className="fixed inset-0 bg-[#050505] text-white overflow-hidden font-mono" style={{ cursor: 'default' }}>
      <GlitchWrap count={count}>
        <Visualizer />
      </GlitchWrap>
      <div className="absolute inset-y-0 left-0" style={{ width: '34%', pointerEvents: 'none' }}>
        <Datafeed />
      </div>
      <TransitionCue count={count} />

      {/* top strip — now playing */}
      <div className="absolute top-0 inset-x-0 h-10 flex items-center gap-6 px-4 text-[11px] tracking-[0.18em] uppercase bg-[#050505]/70 border-b border-white/15">
        <span className="font-sans text-[15px] tracking-[0.2em] normal-case">BROADCAST</span>
        <span className="text-white/45">
          {b.status === 'running' ? (
            <>
              {idx}/{b.entries.length} · {songTitle ?? 'untitled'} · {Math.round(bpm)} bpm · {key}
              {b.next !== null && b.entries[b.next] ? ` · next ${b.entries[b.next].name}` : ''}
            </>
          ) : b.status === 'loading' ? 'loading set…' : bootDone ? 'no set loaded' : 'booting…'}
        </span>
        <span className="ml-auto flex items-center gap-5 text-white/45">
          <button
            className="hover:text-white"
            onClick={() => b.setMode(b.mode === 'random' ? 'sequence' : 'random')}
            title="pick mode"
          >
            {b.mode === 'random' ? '● random' : '○ sequence'}
          </button>
          <span>{playing ? '▶' : '■'} {uptime}</span>
          <span>played {b.played}</span>
        </span>
      </div>

      {/* empty state — the loading surface */}
      {b.status !== 'running' && (
        <div className="absolute inset-0 flex items-center justify-center" style={{ pointerEvents: 'none' }}>
          <div
            className="border border-white/25 bg-[#050505]/85 px-10 py-8 text-center text-[12px] tracking-[0.12em] uppercase text-white/70"
            style={{ pointerEvents: 'auto', minWidth: 460 }}
          >
            <div className="font-sans text-[26px] tracking-[0.2em] normal-case text-white mb-4">BROADCAST</div>
            {!bootDone ? (
              <div>booting engine…</div>
            ) : (
              <>
                <div className="mb-5">drop a folder of .seq files here</div>
                <button
                  className="border border-white/40 px-4 py-2 hover:bg-white hover:text-black"
                  onClick={() => void chooseSet()}
                >
                  choose folder…
                </button>
                <div className="mt-6 text-[10px] text-white/40 normal-case tracking-normal">
                  samples: {samplesDir ?? '…'}{' '}
                  <button className="underline hover:text-white" onClick={() => void changeSamples()}>
                    change
                  </button>
                  {getConfiguredUserSamplesDir() ? '' : ' (default)'}
                </div>
                {b.error && <div className="mt-4 text-red-400 normal-case tracking-normal">{b.error}</div>}
                <div className="mt-6 text-[10px] text-white/30 normal-case tracking-normal">
                  launch flags: --set &lt;folder|.seqset&gt; · --samples &lt;dir&gt; · --device &lt;name&gt; · --song-bars &lt;n&gt; (dev)
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {args && <BroadcastEngine args={args} />}
    </div>
  );
}
