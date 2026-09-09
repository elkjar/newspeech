// The BROADCAST desktop — a fake operating system whose windows each show
// one thing about the running set. Monochrome, zxx wordmark, the site's grid
// and grain, invented chrome. Windows drag/resize/raise/close; the layout
// persists so the machine boots into the same face every time.
import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Visualizer } from '../../stream/Visualizer';
import { ReactiveVisual } from './ReactiveVisual';
import { SignalOverlay, TRANSMISSION_ID } from './SignalOverlay';
import { setSignalEnabled } from './signal';
import { setTubeEnabled } from './TubeLayer';
import { useLayout, useStage, FORMATS, LOOKS, MENUBAR_H, WINDOW_ORDER, WINDOW_TITLES, type WindowId } from './layout';
import { OSWindow } from './Window';
import { SetWindow } from './windows/SetWindow';
import { NowWindow } from './windows/NowWindow';
import { BanksWindow } from './windows/BanksWindow';
import { ShapeWindow } from './windows/ShapeWindow';
import { GhostWindow } from './windows/GhostWindow';
import { VisualWindow } from './windows/VisualWindow';
import { SysWindow } from './windows/SysWindow';
import { CardWindow } from './windows/CardWindow';
import { NextPanel } from './NextPanel';
import { BootPanel } from './BootPanel';
import { EndPanel } from './EndPanel';
import { useGap } from '../gap';
import { useCards } from '../cards';
import { useStationBoot } from '../boot';
import desktopBg from './assets/desktop-bg.png';

const CONTENT: Record<WindowId, () => JSX.Element | null> = {
  set: SetWindow,
  now: NowWindow,
  banks: BanksWindow,
  shape: ShapeWindow,
  ghost: GhostWindow,
  visual: VisualWindow,
  sys: SysWindow,
  card: CardWindow,
};

// The collapse and the reboot. During an interstitial hold the windows fall
// away one by one (then the menubar, then the visual); on reboot they come
// back one by one over REBOOT_SECS. Order is rolled fresh per gap. Only the
// hidden-set changes cause a render — not the 20 Hz progress.
type Falls = 'menubar' | 'backdrop' | WindowId;
const FALLERS: Falls[] = ['ghost', 'visual', 'set', 'now', 'banks', 'shape', 'sys', 'card', 'menubar', 'backdrop'];
function rollOrder(): Record<Falls, { fall: number; rise: number }> {
  const out = {} as Record<Falls, { fall: number; rise: number }>;
  for (const id of FALLERS) {
    out[id] = { fall: 0.04 + Math.random() * 0.34, rise: 0.06 + Math.random() * 0.88 };
  }
  // The chrome goes last and comes back first.
  out.menubar = { fall: 0.42, rise: 0.02 };
  out.backdrop = { fall: 0.4, rise: 0.05 };
  return out;
}
function useCollapse(): Set<Falls> {
  const [hidden, setHidden] = useState<Set<Falls>>(() => new Set());
  useEffect(() => {
    let order = rollOrder();
    let lastPhase = useGap.getState().phase;
    let lastKey = '';
    return useGap.subscribe((g) => {
      if (g.phase !== lastPhase) {
        if (g.phase === 'hold' || g.phase === 'swap') order = rollOrder();
        lastPhase = g.phase;
      }
      const next = new Set<Falls>();
      if (g.phase === 'boot') for (const id of FALLERS) next.add(id);
      if (g.phase === 'off') for (const id of FALLERS) if (g.progress >= order[id].fall * 0.5) next.add(id);
      if (g.phase === 'hold') for (const id of FALLERS) if (g.progress >= order[id].fall) next.add(id);
      // The short swap gap: everything falls within its first couple of seconds.
      if (g.phase === 'swap') for (const id of FALLERS) if (g.progress >= order[id].fall * 0.6) next.add(id);
      if (g.phase === 'reboot') for (const id of FALLERS) if (g.progress < order[id].rise) next.add(id);
      const key = [...next].sort().join(',');
      if (key !== lastKey) {
        lastKey = key;
        setHidden(next);
      }
    });
  }, []);
  return hidden;
}

function useClockText(): string {
  const [t, setT] = useState('');
  useEffect(() => {
    const f = () => {
      const d = new Date();
      setT(
        `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`,
      );
    };
    f();
    const id = window.setInterval(f, 1000);
    return () => window.clearInterval(id);
  }, []);
  return t;
}

export function Desktop() {
  const windows = useLayout((s) => s.windows);
  const backdrop = useLayout((s) => s.backdrop);
  const toggle = useLayout((s) => s.toggle);
  const clamp = useLayout((s) => s.clamp);
  const look = useLayout((s) => s.look);
  const setLook = useLayout((s) => s.setLook);
  useEffect(() => clamp(), [clamp]);
  const fit = useStage();
  const clock = useClockText();
  const [menu, setMenu] = useState(false);
  const collapsed = useCollapse();
  // Standby's arrange mode: the whole desktop up, ident window included, so
  // the layout can be set before GO. Only meaningful in standby. The
  // transmission (static, scanlines) and the ground image are off while
  // arranging so the windows read plainly (Chris 2026-09-08).
  const station = useStationBoot((s) => s.phase);
  const arranging = useLayout((s) => s.arranging) && station === 'standby';
  // 16:9 or 4:3 — follows the window (layout.ts). The 4:3 picture has no
  // menubar on air (the wordmark would be 9% of a CRT's height) and a
  // title-safe area the windows keep to; both are drawn while arranging.
  const format = useLayout((s) => s.format);
  const spec = FORMATS[format];
  const menubarUp = spec.menubarOnAir || arranging;
  // The look: clean = nothing over the picture (CRT chain); signal = the 2D
  // overlay; tube = overlay + the WebGL treatment on the visual.
  useEffect(() => {
    setSignalEnabled(look !== 'clean' && !arranging);
    setTubeEnabled(look === 'tube' && !arranging);
  }, [look, arranging]);
  const hidden = arranging ? new Set<Falls>() : collapsed;
  const cardUp = useCards((s) => s.active !== null) || arranging;
  // An ident always comes to the front — its saved z is whatever it was
  // when last dragged, and a raised visual window otherwise buries it.
  const raise = useLayout((s) => s.raise);
  useEffect(() => {
    if (cardUp) raise('card');
  }, [cardUp, raise]);

  return (
    <div data-tauri-drag-region className="fixed inset-0 overflow-hidden" style={{ background: '#050505' }}>
      {/* the stage: the picture (1512×850 or 800×600), scaled to fit the
          window (letterboxed in a browser; the Tauri window is aspect-locked
          to its display so it fills) */}
      <div
        className="absolute overflow-hidden"
        style={{ left: fit.ox, top: fit.oy, width: fit.w, height: fit.h, transform: `scale(${fit.scale})`, transformOrigin: '0 0' }}
      >
      {/* the transmission root: the picture the signal layer sits over (the
          overlay is a sibling, never a filter on this — see SignalOverlay) */}
      {/* Empty ground drags the window (data-tauri-drag-region applies to
          the element itself, not its children — the windows, menubar and
          panels keep their own pointer behaviour) */}
      <div
        id={TRANSMISSION_ID}
        data-tauri-drag-region
        className="absolute inset-0 overflow-hidden text-white font-mono select-none"
        style={{ background: '#050505', cursor: 'default' }}
      >
      {/* ground: Chris's desktop-bg (a glitched light streak on dark), full
          bleed, with a breath of grain over it so the windows sit in it */}
      {!arranging && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{ backgroundImage: `url(${desktopBg})`, backgroundSize: 'cover', backgroundPosition: 'center', filter: 'grayscale(1)' }}
        />
      )}
      {look !== 'clean' && (
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ opacity: 0.05, mixBlendMode: 'screen' }}>
        <filter id="ns-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#ns-grain)" />
      </svg>
      )}

      {backdrop && isTauri() && !hidden.has('backdrop') && (
        <div className="absolute inset-0" style={{ opacity: 0.55 }}>
          <ReactiveVisual>
            <Visualizer />
          </ReactiveVisual>
        </div>
      )}

      {/* menubar — wordmark, what's playing, clock. Window management lives
          behind one item so the bar stays quiet on a stream. */}
      <div
        data-tauri-drag-region
        className="absolute top-0 inset-x-0 flex items-center gap-5 px-4 text-[9px] tracking-[0.16em] uppercase"
        style={{
          height: MENUBAR_H,
          background: 'rgba(5,5,5,0.85)',
          borderBottom: '1px solid rgba(255,255,255,0.07)',
          zIndex: 10000,
          visibility: hidden.has('menubar') || !menubarUp ? 'hidden' : 'visible',
        }}
      >
        <span className="font-sans text-[12px] tracking-[0.22em] normal-case">NEWSPEECH // BROADCAST</span>
        <span className="text-[8px] tracking-[0.14em] text-white/30 tabular-nums normal-case -ml-2">v{__BROADCAST_VERSION__}</span>
        <span className="ml-auto flex items-center gap-5 text-white/45">
          <span className="relative">
            <button className="hover:text-white" style={{ color: menu ? '#fff' : undefined }} onClick={() => setMenu((m) => !m)}>
              windows {menu ? '▴' : '▾'}
            </button>
            {menu && (
              <div
                className="absolute right-0 top-[22px] flex flex-col py-1 min-w-[150px] normal-case tracking-[0.08em] text-[10px]"
                style={{ background: 'rgba(5,5,5,0.97)', border: '1px solid rgba(255,255,255,0.28)' }}
                onPointerLeave={() => setMenu(false)}
              >
                {WINDOW_ORDER.map((id) => (
                  <button
                    key={id}
                    className="flex items-center gap-2 px-3 leading-[22px] text-left hover:bg-white/10"
                    style={{ color: windows[id].open ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)' }}
                    onClick={() => toggle(id)}
                  >
                    <span className="w-3">{windows[id].open ? '■' : '□'}</span>
                    {WINDOW_TITLES[id]}
                  </button>
                ))}
                <div className="my-1" style={{ borderTop: '1px solid rgba(255,255,255,0.14)' }} />
                <div className="px-3 leading-[18px] text-[8px] tracking-[0.18em] uppercase text-white/35">look</div>
                {LOOKS.map((l) => (
                  <button
                    key={l}
                    className="flex items-center gap-2 px-3 leading-[22px] text-left hover:bg-white/10"
                    style={{ color: look === l ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)' }}
                    onClick={() => setLook(l)}
                  >
                    <span className="w-3">{look === l ? '●' : '○'}</span>
                    {l}
                  </button>
                ))}
              </div>
            )}
          </span>
          <span className="tabular-nums text-white/70">{clock}</span>
        </span>
      </div>

      {/* arranging: the safe area the windows clamp to, and the picture's
          format, so the 4:3 overscan margin reads as intended rather than as
          wasted space */}
      {arranging && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: spec.safe.x,
            top: spec.safe.y,
            width: spec.safe.w,
            height: spec.safe.h,
            border: '1px dashed rgba(255,255,255,0.28)',
            zIndex: 9999,
          }}
        >
          <span
            className="absolute right-0 text-[8px] tracking-[0.18em] uppercase text-white/40 px-1"
            style={{ bottom: -14, background: '#050505' }}
          >
            {format} · {spec.w}×{spec.h}{format === '4:3' ? ' · title safe' : ''}
          </span>
        </div>
      )}

      {/* windows */}
      {WINDOW_ORDER.map((id, i) => {
        if (id === 'visual' && backdrop) return null;
        if (id === 'card' && !cardUp) return null;
        if (hidden.has(id)) return null;
        const C = CONTENT[id];
        return (
          <OSWindow key={id} id={id} index={i + 1}>
            <C />
          </OSWindow>
        );
      })}
      </div>
      {!arranging && look !== 'clean' && <SignalOverlay />}
      <NextPanel />
      <BootPanel />
      <EndPanel />
      </div>
    </div>
  );
}
