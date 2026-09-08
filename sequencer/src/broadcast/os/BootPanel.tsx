// The station coming on air. STANDBY first — and standby is the settings
// surface (Chris 2026-09-08): the desktop is collapsed and this box is where
// the operator picks the set folder, the INTERSTITIALS and CARDS folders,
// the samples folder, the output device, the run shape (songs, first song,
// autostart) — all remembered (settings.ts) so a bare double-click launch
// resumes them — and presses the one GO button. GO (or space) replays the
// boot log from the top, typed at BOOT_LINE_MS; the set loader lands the
// first downbeat after the last line and the panel hands to the reboot.
// Fixed size, above the signal overlay, same chrome as the next panel.
import { useEffect, useState, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { useGap, scanInterstitials } from '../gap';
import { useStationBoot, stationGo, cancelAutoGo, BOOT_LINE_MS, AUTO_GO_SECS } from '../boot';
import { useBroadcast, loadAndStartSet } from '../setlist';
import { useCards, scanCards } from '../cards';
import { useSettings, shortPath } from '../settings';
import { useLayout } from './layout';
import { listOutputDevices, applyOutputDeviceConfig, presetNativeDeviceName, type NativeDeviceInfo } from '../../audio/nativeEngine';
import { setConfiguredUserSamplesDir } from '../../instruments/userSamplesDir';
import { rescanAllKits } from '../../instruments/userSamplesDir';

const ROWS = 14;
const ROW_H = 18;
const W = 620;
// Standby box: header + the config block + the rule. The block is sized to
// its rows (8 × 28 + the title, the facts, the GO row) so nothing spills.
// The boxes size themselves to their fixed-height children — a hand-summed
// outer height double-counted the block's padding and left the rule floating
// a dozen px above the bottom edge (ns 2026-09-08).
const CONFIG_H = 384;

async function pickFolder(title: string): Promise<string | null> {
  if (!isTauri()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const r = await open({ directory: true, multiple: false, title });
  return typeof r === 'string' ? r : null;
}

export function BootPanel() {
  const phase = useGap((s) => s.phase);
  const progress = useGap((s) => s.progress);
  const station = useStationBoot((s) => s.phase);
  const ready = useStationBoot((s) => s.ready);
  const goAt = useStationBoot((s) => s.goAt);
  const lines = useStationBoot((s) => s.lines);
  const arranging = useLayout((s) => s.arranging);
  const setArranging = useLayout((s) => s.setArranging);
  // Arrange mode is a standby thing — GO (or autostart) ends it.
  useEffect(() => {
    if (station !== 'standby' && arranging) setArranging(false);
  }, [station, arranging, setArranging]);
  const [blink, setBlink] = useState(true);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setBlink((v) => !v), 530);
    return () => window.clearInterval(id);
  }, []);
  // Typed replay needs a clock while booting.
  useEffect(() => {
    if (station !== 'booting') return;
    const id = window.setInterval(() => tick((n) => n + 1), 100);
    return () => window.clearInterval(id);
  }, [station]);

  const visible = phase === 'boot' || (phase === 'reboot' && progress < 0.1);
  if (!visible) return null;
  const fade = phase === 'reboot' ? 1 - progress / 0.1 : 1;
  const flicker = 0.84 + 0.16 * Math.random();
  const chrome = {
    background: 'rgba(5,5,5,0.92)',
    border: '1px solid rgba(255,255,255,0.28)',
    boxShadow: '0 0 0 1px rgba(0,0,0,0.9), 0 18px 40px rgba(0,0,0,0.55)',
    opacity: flicker * fade,
  };

  if (station === 'standby' && arranging) {
    return (
      <div className="fixed inset-0 flex items-end justify-center pb-5" style={{ zIndex: 20001, pointerEvents: 'none' }}>
        <div className="font-mono text-white" style={{ ...chrome, width: W, pointerEvents: 'auto' }}>
          <Header right="arranging" />
          <ArrangeStrip onDone={() => setArranging(false)} />
          <div className="h-[2px] bg-white/10" />
        </div>
      </div>
    );
  }

  if (station === 'standby') {
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 20001, pointerEvents: 'none' }}>
        <div className="font-mono text-white" style={{ ...chrome, width: W, pointerEvents: 'auto' }}>
          <Header right="standby" />
          <StandbyConfig ready={ready} blink={blink} onArrange={() => setArranging(true)} />
          <div className="h-[2px] bg-white/10">
            <div className="h-full bg-white/40" style={{ width: ready ? '100%' : '35%' }} />
          </div>
        </div>
      </div>
    );
  }

  // Booting: typed replay of everything logged before GO; lines logged after
  // GO (transport: start / on air) appear as they land.
  const elapsed = performance.now() - goAt;
  const typed = lines.filter((l, i) => l.t >= goAt - useStationBoot.getState().startedAt || i * BOOT_LINE_MS <= elapsed);
  const shown = typed.slice(-ROWS);

  return (
    <div className="fixed inset-0 pointer-events-none flex items-center justify-center" style={{ zIndex: 20001 }}>
      <div className="font-mono text-white" style={{ ...chrome, width: 560 }}>
        <Header right="initializing" />
        <div className="px-4 py-[7px] text-[10px]" style={{ height: ROWS * ROW_H + 14 }}>
          {shown.map((l, i) => {
            const last = i === shown.length - 1;
            return (
              <div key={`${l.t}-${i}`} className="flex gap-3 whitespace-nowrap overflow-hidden" style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}>
                <span className="tabular-nums text-white/35 w-12 shrink-0">{(l.t / 1000).toFixed(2).padStart(6, ' ')}</span>
                <span className="truncate" style={{ color: last ? '#fff' : 'rgba(255,255,255,0.7)' }}>
                  {l.text}
                  {last && <span style={{ opacity: blink ? 1 : 0 }}> ▍</span>}
                </span>
              </div>
            );
          })}
        </div>
        <div className="h-[2px] bg-white/10">
          <div className="h-full bg-white/40" style={{ width: `${Math.min(100, (typed.length / Math.max(1, lines.length)) * 100).toFixed(0)}%` }} />
        </div>
      </div>
    </div>
  );
}

function Header({ right }: { right: string }) {
  return (
    <div className="flex items-center gap-3 px-3" style={{ height: 22, borderBottom: '1px solid rgba(255,255,255,0.22)', background: 'rgba(255,255,255,0.04)' }}>
      <span className="text-[8px] tracking-[0.2em] opacity-40">··</span>
      <span className="font-sans text-[10px] tracking-[0.18em] lowercase">station</span>
      <span className="ml-auto text-[8px] tracking-[0.16em] uppercase text-white/45">{right}</span>
    </div>
  );
}

// The config. Every change is remembered (settings.ts) and applied now:
// folders rescan, the set reloads, the device reopens.
// Arrange mode: the desktop is up behind this strip; drag windows by their
// title bars, the corner resizes, `windows ▾` in the menubar toggles them.
// The layout is saved as it changes, same as on air.
function ArrangeStrip({ onDone }: { onDone: () => void }) {
  const backdrop = useLayout((s) => s.backdrop);
  const setBackdrop = useLayout((s) => s.setBackdrop);
  const reset = useLayout((s) => s.reset);
  return (
    <div className="flex items-center gap-4 px-5 text-[10px]" style={{ height: 44 }}>
      <span className="text-[9px] tracking-[0.16em] uppercase text-white/45 truncate">
        drag a title to move · corner resizes · windows ▾ toggles · esc when done
      </span>
      <span className="ml-auto flex items-center gap-2 shrink-0">
        <Btn onClick={() => setBackdrop(!backdrop)}>{backdrop ? '■' : '□'} backdrop</Btn>
        <Btn onClick={reset}>reset</Btn>
        <Btn onClick={onDone}>done</Btn>
      </span>
    </div>
  );
}

function StandbyConfig({ ready, blink, onArrange }: { ready: boolean; blink: boolean; onArrange: () => void }) {
  const st = useSettings();
  const b = useBroadcast();
  const gapFiles = useGap((s) => s.files.length);
  const cards = useCards((s) => s.cards.length);
  const [devices, setDevices] = useState<NativeDeviceInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const autoGoAt = useStationBoot((s) => s.autoGoAt);
  const [, tickAuto] = useState(0);
  useEffect(() => {
    if (autoGoAt === null) return;
    const id = window.setInterval(() => tickAuto((n) => n + 1), 200);
    return () => window.clearInterval(id);
  }, [autoGoAt]);
  const autoLeft = autoGoAt === null ? null : Math.max(0, Math.ceil((autoGoAt - performance.now()) / 1000));

  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const load = () => void listOutputDevices().then((d) => alive && setDevices(d)).catch(() => {});
    load();
    const id = window.setInterval(load, 5000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);

  const setPath = b.setPaths[0] ?? st.setPaths[0] ?? null;

  const chooseSet = async () => {
    const dir = await pickFolder('Set folder (.seq files)');
    if (!dir) return;
    st.update({ setPaths: [dir], first: null });
    useBroadcast.setState({ firstPick: null });
    void loadAndStartSet([dir]);
  };
  const chooseInterstitials = async () => {
    const dir = await pickFolder('INTERSTITIALS folder (wav)');
    if (!dir) return;
    st.update({ interstitialsDir: dir });
    void scanInterstitials(useBroadcast.getState().setPaths, dir);
  };
  const chooseCards = async () => {
    const dir = await pickFolder('CARDS folder (txt)');
    if (!dir) return;
    st.update({ cardsDir: dir });
    void scanCards(useBroadcast.getState().setPaths, dir);
  };
  const chooseSamples = async () => {
    const dir = await pickFolder('Samples folder');
    if (!dir) return;
    st.update({ samplesDir: dir });
    setConfiguredUserSamplesDir(dir);
    setBusy('rescanning samples…');
    try {
      await rescanAllKits();
    } finally {
      setBusy(null);
    }
    const paths = useBroadcast.getState().setPaths;
    if (paths.length) void loadAndStartSet(paths);
  };
  const chooseDevice = async (name: string) => {
    const d = devices.find((x) => x.name === name);
    if (!d) return;
    st.update({ device: name });
    presetNativeDeviceName(name);
    setBusy(`opening ${name}…`);
    try {
      await applyOutputDeviceConfig({ deviceName: name, channels: Math.min(2, Math.max(1, d.maxOutputChannels)), sampleRate: d.defaultSampleRate });
    } catch (err) {
      console.warn('[settings] device open failed:', err);
    } finally {
      setBusy(null);
    }
  };
  const setSongs = (v: string) => {
    const n = v.trim() === '' ? null : Math.max(1, Math.floor(Number(v)) || 0) || null;
    st.update({ songs: n });
    useGap.setState({ songLimit: n });
  };
  const setFirst = (v: string) => {
    const name = v === '' ? null : v;
    st.update({ first: name });
    useBroadcast.setState({ firstPick: name });
    const paths = useBroadcast.getState().setPaths;
    if (paths.length) void loadAndStartSet(paths);
  };

  const status =
    busy ??
    (autoLeft !== null
      ? `autostart · on air in ${autoLeft} s · esc holds`
      : b.status === 'loading'
        ? 'loading the set…'
        : b.status === 'error'
          ? b.error ?? 'error'
          : ready
            ? 'ready · GO or space goes on air'
            : b.entries.length
              ? 'preparing…'
              : 'pick a set folder');

  return (
    <div className="flex flex-col px-5 pt-4 text-[10px] overflow-hidden" style={{ height: CONFIG_H }}>
      <div className="flex items-baseline gap-4">
        <div>
          <div className="text-[8px] tracking-[0.18em] uppercase text-white/45">NEWSPEECH // BROADCAST</div>
          <div className="font-sans" style={{ fontSize: 28, lineHeight: '34px', letterSpacing: '0.02em' }}>
            {ready ? 'ready' : 'standby'}
          </div>
        </div>
        <div className="ml-auto text-[8px] tracking-[0.16em] uppercase text-white/45 text-right leading-[14px]">
          {b.entries.length} songs · {gapFiles} interstitials · {cards} cards
        </div>
      </div>

      <div className="mt-3 grid grid-cols-[92px_1fr_auto] gap-x-3 gap-y-[6px] items-center">
        <Row k="set">
          <Val>{shortPath(setPath, 'none')}</Val>
          <Btn onClick={chooseSet}>choose…</Btn>
        </Row>
        <Row k="interstitials">
          <Val dim={!st.interstitialsDir}>{st.interstitialsDir ? shortPath(st.interstitialsDir) : 'beside the set'}</Val>
          <span className="flex gap-2">
            <Btn onClick={chooseInterstitials}>choose…</Btn>
            {st.interstitialsDir && (
              <Btn
                onClick={() => {
                  st.update({ interstitialsDir: null });
                  void scanInterstitials(useBroadcast.getState().setPaths, null);
                }}
              >
                ×
              </Btn>
            )}
          </span>
        </Row>
        <Row k="cards">
          <Val dim={!st.cardsDir}>{st.cardsDir ? shortPath(st.cardsDir) : 'beside the set'}</Val>
          <span className="flex gap-2">
            <Btn onClick={chooseCards}>choose…</Btn>
            {st.cardsDir && (
              <Btn
                onClick={() => {
                  st.update({ cardsDir: null });
                  void scanCards(useBroadcast.getState().setPaths, null);
                }}
              >
                ×
              </Btn>
            )}
          </span>
        </Row>
        <Row k="samples">
          <Val dim={!st.samplesDir}>{shortPath(st.samplesDir, 'default')}</Val>
          <Btn onClick={chooseSamples}>choose…</Btn>
        </Row>
        <Row k="output">
          <select
            value={st.device ?? ''}
            onChange={(e) => void chooseDevice(e.target.value)}
            className="bg-transparent border border-white/20 px-2 h-[22px] text-[10px] text-white focus:outline-none focus:border-white/60 w-full"
          >
            {!st.device && <option value="">system default</option>}
            {devices.map((d) => (
              <option key={d.name} value={d.name} className="bg-[#050505]">
                {d.name} · {d.maxOutputChannels} ch
              </option>
            ))}
            {st.device && !devices.some((d) => d.name === st.device) && <option value={st.device}>{st.device} (not connected)</option>}
          </select>
          <span />
        </Row>
        <Row k="songs">
          <span className="flex items-center gap-3">
            <input
              value={st.songs ?? ''}
              placeholder="∞"
              inputMode="numeric"
              onChange={(e) => setSongs(e.target.value)}
              className="bg-transparent border border-white/20 px-2 h-[22px] w-16 text-[10px] text-white tabular-nums focus:outline-none focus:border-white/60"
            />
            <span className="text-white/40">{st.songs ? 'then sign off' : 'forever'}</span>
          </span>
          <span />
        </Row>
        <Row k="first">
          <select
            value={st.first ?? ''}
            onChange={(e) => setFirst(e.target.value)}
            className="bg-transparent border border-white/20 px-2 h-[22px] text-[10px] text-white focus:outline-none focus:border-white/60 w-full"
          >
            <option value="" className="bg-[#050505]">
              random
            </option>
            {b.entries.map((e) => (
              <option key={e.path} value={e.name} className="bg-[#050505]">
                {e.name}
              </option>
            ))}
          </select>
          <span />
        </Row>
        <Row k="autostart">
          <button
            onClick={() => {
              if (st.autostart) cancelAutoGo();
              st.update({ autostart: !st.autostart });
            }}
            className="text-left"
            style={{ color: st.autostart ? '#fff' : 'rgba(255,255,255,0.45)' }}
          >
            <span className="inline-block w-4">{st.autostart ? '■' : '□'}</span>
            launches go on air by themselves after a {AUTO_GO_SECS} s countdown · esc holds
          </button>
          <span />
        </Row>
      </div>

      <div className="mt-auto mb-3 flex items-center gap-4">
        <button
          onClick={stationGo}
          disabled={!ready}
          className="font-sans tracking-[0.22em] uppercase"
          style={{
            padding: '9px 26px',
            border: '1px solid rgba(255,255,255,0.7)',
            color: ready ? '#050505' : 'rgba(255,255,255,0.35)',
            background: ready ? '#fff' : 'transparent',
            cursor: ready ? 'pointer' : 'default',
            fontSize: 13,
            opacity: ready || blink ? 1 : 0.7,
          }}
        >
          go
        </button>
        <span className="text-[9px] tracking-[0.16em] uppercase text-white/40 truncate">{status}</span>
        {autoLeft !== null && <Btn onClick={cancelAutoGo}>hold</Btn>}
        <span className="ml-auto shrink-0">
          <Btn onClick={onArrange}>arrange windows</Btn>
        </span>
      </div>
    </div>
  );
}

function Row({ k, children }: { k: string; children: ReactNode }) {
  return (
    <>
      <span className="text-[8px] tracking-[0.18em] uppercase text-white/40">{k}</span>
      {children}
    </>
  );
}
function Val({ children, dim }: { children: ReactNode; dim?: boolean }) {
  return <span className="truncate" style={{ color: dim ? 'rgba(255,255,255,0.4)' : 'rgba(255,255,255,0.85)' }}>{children}</span>;
}
function Btn({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="border border-white/25 px-2 h-[22px] text-[9px] tracking-[0.14em] uppercase text-white/70 hover:text-white hover:border-white/60">
      {children}
    </button>
  );
}
