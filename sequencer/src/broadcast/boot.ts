// Station standby → GO → initializing → on air. The broadcast doesn't just
// appear, it comes on air — and it waits for the operator first: launch
// lands in STANDBY (desktop collapsed, a panel with the set facts and a GO
// button) so Loopback / the recorder can be set up against the running
// app; GO (or space) replays the boot log from the top, typed, then the
// first downbeat, then the reboot. `--autostart` skips standby for the
// unattended box (Login Item).
// From launch until the first downbeat the desktop is collapsed (same
// as an interstitial hold, a little less static) and the BootPanel types a
// log of the station finding itself: version, engine, audio device, samples,
// the set, the first pick. When the transport starts the OS reboots window
// by window exactly as it does after an interstitial. The set loader holds
// the first downbeat until the sequence has had at least BOOT_MIN_SECS on
// screen (Chris: this is a slow machine).
import { create } from 'zustand';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { useSequencerStore } from '../state/store';
import { useGap, startGapPhase, pickInterstitial, REBOOT_SECS } from './gap';
import { useCards } from './cards';
import { loadSample, triggerSample, fadeTextures } from '../audio/nativeEngine';

export interface BootLine {
  t: number; // ms since boot start
  text: string;
}

export type StationPhase = 'standby' | 'booting' | 'onair';

interface StationBootState {
  lines: BootLine[];
  startedAt: number; // performance.now()
  phase: StationPhase;
  goAt: number; // performance.now() when GO was pressed (typed replay origin)
  autostart: boolean;
  ready: boolean; // set loaded + first song staged — GO does something
  // Autostart: standby still shows, with a countdown to GO. Esc / "hold"
  // cancels it and leaves the config up (how autostart gets turned off).
  autoGoAt: number | null; // performance.now()
}

export const BOOT_MIN_SECS = 12;
// Typed replay pace after GO.
export const BOOT_LINE_MS = 650;
// Boot static: GO fires a random interstitial under the typed log; the first
// downbeat waits for it, capped here (long WAVs fade out into the downbeat).
export const BOOT_WAV_CAP_SECS = 32;
const BOOT_WAV_FADE_SECS = 3.5;

export const useStationBoot = create<StationBootState>(() => ({
  lines: [],
  startedAt: performance.now(),
  phase: 'standby',
  goAt: 0,
  autostart: false,
  ready: false,
  autoGoAt: null,
}));

export const AUTO_GO_SECS = 10;
let autoGoTimer: number | null = null;

export function cancelAutoGo(): void {
  if (autoGoTimer !== null) window.clearTimeout(autoGoTimer);
  autoGoTimer = null;
  if (useStationBoot.getState().autoGoAt !== null) {
    useStationBoot.setState({ autoGoAt: null });
    console.info('[boot] autostart held');
  }
}

let goWaiters: Array<() => void> = [];

// The operator's one control. Space or the GO button.
export function stationGo(): void {
  const s = useStationBoot.getState();
  if (s.phase !== 'standby') return;
  useStationBoot.setState({ phase: 'booting', goAt: performance.now(), autoGoAt: null });
  if (autoGoTimer !== null) window.clearTimeout(autoGoTimer);
  autoGoTimer = null;
  console.info('[boot] GO');
  const w = goWaiters;
  goWaiters = [];
  for (const r of w) r();
}

export function bootLog(text: string): void {
  const s = useStationBoot.getState();
  if (s.phase === 'onair') return;
  useStationBoot.setState({ lines: [...s.lines, { t: performance.now() - s.startedAt, text }].slice(-40) });
  console.info(`[boot] ${text}`);
}

// The set loader calls this before the first downbeat. Autostart: at least
// BOOT_MIN_SECS on screen. Standby: wait for GO, then long enough for the
// typed replay of everything logged so far to finish.
export async function stationBootGate(): Promise<void> {
  const s = useStationBoot.getState();
  if (s.phase === 'onair') return;
  useStationBoot.setState({ ready: true });
  if (useStationBoot.getState().phase === 'standby') {
    bootLog('ready');
    if (s.autostart && autoGoTimer === null && useStationBoot.getState().autoGoAt === null) {
      // Unattended: count down in standby, then GO by itself. Esc holds.
      useStationBoot.setState({ autoGoAt: performance.now() + AUTO_GO_SECS * 1000 });
      autoGoTimer = window.setTimeout(() => {
        autoGoTimer = null;
        if (useStationBoot.getState().autoGoAt !== null) stationGo();
      }, AUTO_GO_SECS * 1000);
    }
    await new Promise<void>((r) => goWaiters.push(r));
  }
  // The static under the boot: one random interstitial, fired as a texture
  // voice so it can be faded into the downbeat if it's longer than the cap.
  let wavMs = 0;
  const wav = pickInterstitial();
  if (wav) {
    try {
      const info = await loadSample(wav);
      wavMs = info.durationSecs * 1000;
      await triggerSample(wav, { gain: 1, isTexture: true });
      bootLog(`static: ${wav.split('/').pop()} (${info.durationSecs.toFixed(0)} s)`);
    } catch (err) {
      console.warn('[boot] boot static failed:', err);
      wavMs = 0;
    }
  }
  const goAt = useStationBoot.getState().goAt;
  const n = useStationBoot.getState().lines.length;
  const typedMs = n * BOOT_LINE_MS + 1200;
  const holdMs = Math.max(typedMs, Math.min(wavMs, BOOT_WAV_CAP_SECS * 1000));
  if (wavMs > holdMs) {
    // Longer than the hold: fade it under the downbeat rather than cut.
    window.setTimeout(() => void fadeTextures(BOOT_WAV_FADE_SECS), Math.max(0, holdMs - BOOT_WAV_FADE_SECS * 1000 - (performance.now() - goAt)));
  }
  const left = holdMs - (performance.now() - goAt);
  if (left > 0) await new Promise((r) => window.setTimeout(r, left));
}

interface BootArgs {
  set: string[];
  samples: string | null;
  device: string | null;
  autostart: boolean;
}

let installed = false;
export function installStationBoot(args: BootArgs): () => void {
  if (installed) return () => {};
  installed = true;
  const unsubs: Array<() => void> = [];
  const fresh = useStationBoot.getState().lines.length === 0;
  useStationBoot.setState({ phase: 'standby', goAt: 0, autostart: args.autostart, ready: false, autoGoAt: null });
  if (fresh) useStationBoot.setState({ startedAt: performance.now() });
  startGapPhase('boot', 1);

  // Header once — a re-run of the install effect (dev double mount) keeps
  // the lines already logged rather than repeating them.
  if (fresh) {
    bootLog(`NEWSPEECH // BROADCAST v${__BROADCAST_VERSION__}`);
    bootLog('station initializing');
    if (args.device) bootLog(`device requested: ${args.device}`);
    if (args.samples) bootLog(`samples: ${args.samples.split('/').filter(Boolean).slice(-2).join('/')}`);
  }
  // No set yet → standby stays up: it's the config surface (pick a folder).
  if (args.set.length === 0) bootLog('no set — pick a set folder');

  // Engine + audio device.
  let engineLogged = false;
  const onStore = (s: ReturnType<typeof useSequencerStore.getState>) => {
    if (s.bootDone && !engineLogged) {
      engineLogged = true;
      bootLog('engine: ready');
      if (isTauri()) {
        // The device opens a beat after the engine reports ready — poll until
        // it has a real rate rather than logging zeros.
        let tries = 0;
        const probe = () => {
          void invoke<{ channels: number; sample_rate: number }>('audio_status')
            .then((st) => {
              if (st.sample_rate > 0) bootLog(`audio: ${st.channels} ch · ${(st.sample_rate / 1000).toFixed(1)} kHz`);
              else if (++tries < 40) window.setTimeout(probe, 250);
              else bootLog('audio: device not open');
            })
            .catch(() => {
              if (++tries < 40) window.setTimeout(probe, 250);
              else bootLog('audio: device not open');
            });
        };
        probe();
      }
    }
    // First downbeat → on air → reboot the OS.
    if (s.playing && useGap.getState().phase === 'boot') {
      bootLog('on air');
      useStationBoot.setState({ phase: 'onair' });
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
  useStationBoot.setState({ lines: [], startedAt: performance.now(), phase: 'standby', goAt: 0, autostart: false, ready: false, autoGoAt: null });
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
    [9000, 'ready'],
  ];
  for (const [t, text] of script) window.setTimeout(() => bootLog(text), t);
  window.setTimeout(() => useStationBoot.setState({ ready: true }), 9000);
  // GO (space / button) → typed replay → then pretend the downbeat lands.
  const unsub = useStationBoot.subscribe((s) => {
    if (s.phase !== 'booting') return;
    unsub();
    const n = s.lines.length;
    window.setTimeout(() => bootLog('transport: start'), n * BOOT_LINE_MS + 600);
    window.setTimeout(() => {
      bootLog('on air');
      useStationBoot.setState({ phase: 'onair' });
      startGapPhase('reboot', REBOOT_SECS);
    }, n * BOOT_LINE_MS + 1400);
  });
}
