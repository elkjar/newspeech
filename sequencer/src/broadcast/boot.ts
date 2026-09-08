// Station initializing — the broadcast doesn't just appear, it comes on
// air. From launch until the first downbeat the desktop is collapsed (same
// as an interstitial hold, a little less static) and the BootPanel types a
// log of the station finding itself: version, engine, audio device, samples,
// the set, the first pick. When the transport starts the OS reboots window
// by window exactly as it does after an interstitial. The set loader holds
// the first downbeat until the sequence has had at least BOOT_MIN_SECS on
// screen (Chris: this is a slow machine).
import { create } from 'zustand';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useSequencerStore } from '../state/store';
import { useGap, startGapPhase, REBOOT_SECS } from './gap';
import { useCards } from './cards';

export interface BootLine {
  t: number; // ms since boot start
  text: string;
}

interface StationBootState {
  lines: BootLine[];
  startedAt: number; // performance.now()
  onAir: boolean; // first downbeat reached
}

export const BOOT_MIN_SECS = 12;

export const useStationBoot = create<StationBootState>(() => ({
  lines: [],
  startedAt: performance.now(),
  onAir: false,
}));

export function bootLog(text: string): void {
  const s = useStationBoot.getState();
  if (s.onAir) return;
  useStationBoot.setState({ lines: [...s.lines, { t: performance.now() - s.startedAt, text }].slice(-40) });
  console.info(`[boot] ${text}`);
}

// Resolves once the boot sequence has been on screen for BOOT_MIN_SECS.
export function stationBootGate(): Promise<void> {
  const s = useStationBoot.getState();
  const left = BOOT_MIN_SECS * 1000 - (performance.now() - s.startedAt);
  if (s.onAir || left <= 0) return Promise.resolve();
  return new Promise((r) => window.setTimeout(r, left));
}

interface BootArgs {
  set: string[];
  samples: string | null;
  device: string | null;
}

let installed = false;
export function installStationBoot(args: BootArgs): () => void {
  if (installed) return () => {};
  installed = true;
  const unsubs: Array<() => void> = [];
  useStationBoot.setState({ lines: [], startedAt: performance.now(), onAir: false });
  startGapPhase('boot', 1);

  bootLog(`NEWSPEECH // BROADCAST v${__BROADCAST_VERSION__}`);
  bootLog('station initializing');
  if (args.device) bootLog(`device requested: ${args.device}`);
  if (args.samples) bootLog(`samples: ${args.samples.split('/').filter(Boolean).slice(-2).join('/')}`);
  if (args.set.length === 0) {
    // Nothing to come on air with: show the desktop (and its "no set" window)
    // after a moment instead of holding a boot screen forever.
    bootLog('no set given — drop a folder of .seq files');
    window.setTimeout(() => {
      if (useGap.getState().phase === 'boot') {
        useStationBoot.setState({ onAir: true });
        startGapPhase('reboot', REBOOT_SECS);
      }
    }, 6000);
  }

  // Engine + audio device.
  let engineLogged = false;
  const onStore = (s: ReturnType<typeof useSequencerStore.getState>) => {
    if (s.bootDone && !engineLogged) {
      engineLogged = true;
      bootLog('engine: ready');
      if (isTauri()) {
        void invoke<{ channels: number; sample_rate: number }>('audio_status')
          .then((st) => bootLog(`audio: ${st.channels} ch · ${(st.sample_rate / 1000).toFixed(1)} kHz`))
          .catch(() => bootLog('audio: device not open yet'));
      }
    }
    // First downbeat → on air → reboot the OS.
    if (s.playing && useGap.getState().phase === 'boot') {
      bootLog('on air');
      useStationBoot.setState({ onAir: true });
      startGapPhase('reboot', REBOOT_SECS);
    }
  };
  onStore(useSequencerStore.getState());
  unsubs.push(useSequencerStore.subscribe(onStore));

  // Sibling folders as they're scanned (log each count once it's known).
  let lastFiles = -1;
  unsubs.push(
    useGap.subscribe((g) => {
      if (g.files.length !== lastFiles && (g.files.length > 0 || lastFiles > 0)) bootLog(`interstitials: ${g.files.length}`);
      lastFiles = g.files.length;
    }),
  );
  let lastCards = -1;
  unsubs.push(
    useCards.subscribe((c) => {
      if (c.cards.length !== lastCards && (c.cards.length > 0 || lastCards > 0)) bootLog(`cards: ${c.cards.length}`);
      lastCards = c.cards.length;
    }),
  );

  return () => {
    installed = false;
    for (const u of unsubs) u();
  };
}

// Demo / screenshots: replay the sequence with canned lines, then reboot.
export function demoBoot(): void {
  useStationBoot.setState({ lines: [], startedAt: performance.now(), onAir: false });
  startGapPhase('boot', 1);
  const script: Array<[number, string]> = [
    [0, `NEWSPEECH // BROADCAST v${__BROADCAST_VERSION__}`],
    [400, 'station initializing'],
    [1200, 'samples: __SEQUENCE/SAMPLES'],
    [2200, 'engine: ready'],
    [2600, 'audio: 2 ch · 48.0 kHz'],
    [3400, 'set: 17 songs · SEQ_01'],
    [3900, 'mode: random · ghost: on'],
    [4600, 'interstitials: 8'],
    [4900, 'cards: 4'],
    [5600, 'loading 15 voices for piper-maru-EXT'],
    [7800, 'first: piper-maru-EXT'],
    [8600, 'staged: test-wave'],
    [11000, 'transport: start'],
    [11600, 'on air'],
  ];
  for (const [t, text] of script) window.setTimeout(() => bootLog(text), t);
  window.setTimeout(() => {
    useStationBoot.setState({ onAir: true });
    startGapPhase('reboot', REBOOT_SECS);
  }, 11800);
}
