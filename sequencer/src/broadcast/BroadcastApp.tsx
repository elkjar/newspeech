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
import { setConfiguredUserSamplesDir } from '../instruments/userSamplesDir';
import { togglePlayback, panicKill } from '../audio/transport';
import { useBroadcast, loadAndStartSet, addToSet } from './setlist';
import { installGapConductor, scanInterstitials, useGap } from './gap';
import { installCards, scanCards } from './cards';
import { installStationBoot } from './boot';
import { startGapPhase } from './gap';
import { Desktop } from './os/Desktop';
import { installStreamState } from './os/streamState';
import { seedDemo } from './os/demo';

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
  gapEvery: number | null;
  // Dev: force every song to N bars.
  songBars: number | null;
}

function parseLaunchArgs(argv: string[]): LaunchArgs {
  const out: LaunchArgs = { set: [], samples: null, device: null, songBars: null, gapEvery: null };
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
    else if (a === '--gap-every') out.gapEvery = Number(next()) || null;
    else if (a.startsWith('--gap-every=')) out.gapEvery = Number(a.slice(12)) || null;
    else if (!a.startsWith('-')) out.set.push(a); // bare path
  }
  return out;
}

// Engine wiring — mounted once launch args are known (samples dir and
// device must be seeded before the scan / device open). Same order as
// App.tsx so the two binaries behave identically.
function BroadcastEngine({ args }: { args: LaunchArgs }) {
  const bootDone = useSequencerStore((s) => s.bootDone);

  useEffect(() => installStationBoot(args), [args]);
  useEffect(() => {
    if (NATIVE) document.body.classList.add('tauri-native');
    return bootEngine({ initProject: false, controllers: false });
  }, []);
  useEffect(() => {
    if (args.samples) setConfiguredUserSamplesDir(args.samples);
    if (args.device) presetNativeDeviceName(args.device);
    useBroadcast.getState().setDevSongBars(args.songBars);
    useGap.setState({ devEvery: args.gapEvery });
    startSamplesBoot();
  }, [args]);
  // Interstitials + idents: the conductor owns occasional song ends; cards
  // run on their own clock. Both re-scan their sibling folders whenever the
  // set's paths change (launch, drops).
  useEffect(() => installGapConductor(), []);
  useEffect(() => installCards(() => useBroadcast.getState().setPaths), []);
  useEffect(() => {
    let last = '';
    const scan = (paths: string[]) => {
      const key = paths.join('\n');
      if (key === last || paths.length === 0) return;
      last = key;
      void scanInterstitials(paths);
      void scanCards(paths);
    };
    scan(useBroadcast.getState().setPaths);
    return useBroadcast.subscribe((s) => scan(s.setPaths));
  }, []);
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

const DEMO = new URLSearchParams(window.location.search).get('demo') === '1';

export function BroadcastApp() {
  const [args, setArgs] = useState<LaunchArgs | null>(null);
  const status = useBroadcast((s) => s.status);

  useEffect(() => {
    if (DEMO) {
      seedDemo();
      return;
    }
    // Collapse the desktop before the first paint settles — the station is
    // initializing until the first downbeat (boot.ts takes it from here).
    startGapPhase('boot', 1);
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

  useEffect(() => (NATIVE ? installStreamState() : undefined), []);

  useDropTarget((paths) => void addToSet(paths));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === '.' || e.code === 'Period')) {
        e.preventDefault();
        panicKill();
        return;
      }
      if (e.code === 'Space' && status === 'running') {
        e.preventDefault();
        void togglePlayback();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [status]);

  return (
    <>
      <Desktop />
      {args && <BroadcastEngine args={args} />}
    </>
  );
}
