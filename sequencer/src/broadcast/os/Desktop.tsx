// The BROADCAST desktop — a fake operating system whose windows each show
// one thing about the running set. Monochrome, zxx wordmark, the site's grid
// and grain, invented chrome. Windows drag/resize/raise/close; the layout
// persists so the machine boots into the same face every time.
import { useEffect, useState } from 'react';
import { isTauri, convertFileSrc } from '@tauri-apps/api/core';
import { SignalOverlay, TRANSMISSION_ID } from './SignalOverlay';
import { setSignalEnabled } from './signal';
import { useLayout, useStage, FORMATS, LOOKS, LOOK_CELL, MENUBAR_H, WINDOW_ORDER, WINDOW_TITLES, type WindowId } from './layout';
import { useDirector, frameFor, forceShot, resumeAuto, shotLabel, KEY_SHOTS, type Shot } from './director';
import { TitleLayer } from './TitleLayer';
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
import { useGround, GROUND_FADE_SECS } from '../ground';
import { useCards } from '../cards';
import { useStationBoot } from '../boot';
import desktopBg from './assets/desktop-bg.png';

// A 256×256 white-noise tile, made once at module load (blank in SSR-less
// non-DOM contexts, which never render this anyway).
const GRAIN_TILE: string = (() => {
  if (typeof document === 'undefined') return '';
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  if (!ctx) return '';
  const img = ctx.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = Math.random() * 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
})();

// One ground image, fading in over the previous one on mount when there is
// a previous one (a fresh pick), painted at once otherwise (boot).
function GroundLayer({ url, fade }: { url: string; fade: boolean }) {
  const [on, setOn] = useState(!fade);
  useEffect(() => {
    if (!fade) return;
    const id = requestAnimationFrame(() => setOn(true));
    return () => cancelAnimationFrame(id);
  }, [fade]);
  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{
        backgroundImage: `url(${url})`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        filter: 'grayscale(1)',
        opacity: on ? 1 : 0,
        transition: fade ? `opacity ${GROUND_FADE_SECS}s ease-in-out` : undefined,
      }}
    />
  );
}

// The visual window's body is empty: the one Visualizer is a separate layer
// (VisualLayer below) placed over the window's content area, so a director
// cut never remounts it — the clip keeps playing through every shot.
const CONTENT: Record<WindowId, () => JSX.Element | null> = {
  set: SetWindow,
  now: NowWindow,
  banks: BanksWindow,
  shape: ShapeWindow,
  ghost: GhostWindow,
  visual: () => null,
  sys: SysWindow,
  card: CardWindow,
};

// Window chrome: the header is 22 px, zoomed at half the content rate.
const WINDOW_HEADER_H = 22;
function headerHeight(zoom: number): number {
  return WINDOW_HEADER_H * (zoom !== 1 ? 1 + (zoom - 1) / 2 : 1);
}

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
  const setDirectorOn = useDirector((s) => s.setOn);
  const setDirectorAuto = useDirector((s) => s.setAuto);
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
  // The ground: a still from BACKGROUNDS/ beside the set, re-picked on every
  // song / record load and crossfaded (ground.ts); the built-in image when
  // the folder is empty or absent.
  const groundCurrent = useGround((s) => s.current);
  const groundPrevious = useGround((s) => s.previous);
  const groundUrl = (f: string | null) => (f ? (isTauri() ? convertFileSrc(f) : f) : desktopBg);
  // 16:9 or 4:3 — follows the window (layout.ts). The 4:3 picture has no
  // menubar on air (the wordmark would be 9% of a CRT's height) and a
  // title-safe area the windows keep to; both are drawn while arranging.
  const format = useLayout((s) => s.format);
  const spec = FORMATS[format];
  const menubarUp = spec.menubarOnAir || arranging;
  // The look, for the whole picture: clean = nothing over it (CRT chain);
  // signal = the transmission overlay.
  useEffect(() => setSignalEnabled(look !== 'clean' && !arranging), [look, arranging]);
  const hidden = arranging ? new Set<Falls>() : collapsed;
  const cardUp = useCards((s) => s.active !== null) || arranging;
  // An ident always comes to the front — its saved z is whatever it was
  // when last dragged, and a raised visual window otherwise buries it.
  const raise = useLayout((s) => s.raise);
  useEffect(() => {
    if (cardUp) raise('card');
  }, [cardUp, raise]);
  // The director's shot (director.ts): the saved arrangement is `home`;
  // any other shot is a transient frame over it. Home whenever the director
  // is off, the gap owns the picture, or the layout is being arranged.
  const dOn = useDirector((s) => s.on);
  const dAuto = useDirector((s) => s.auto);
  const dShot = useDirector((s) => s.shot);
  const gapUp = useGap((g) => g.phase !== 'none');
  const shot: Shot = !dOn || gapUp || arranging ? { kind: 'home' } : dShot;
  const frame = frameFor(shot, windows, format);
  const locked = shot.kind !== 'home';
  const bleed = backdrop || frame.bleed;
  // Where the one Visualizer sits this frame: the full picture (bleed, or
  // the layout's backdrop mode), or inside the visual window's frame. It is
  // never unmounted — hidden (still playing) when no shot shows it, so a cut
  // back to it resumes the same clip mid-stream instead of reloading. This
  // is also what the listener-teardown warnings on every cut were.
  const zoom = useLayout((s) => s.zoom);
  const visualRect = frame.rects.visual;
  const visualLayer: { x: number; y: number; w: number; h: number; z: number; opacity: number } | null =
    bleed && !hidden.has('backdrop')
      ? { x: 0, y: 0, w: spec.w, h: spec.h, z: 0, opacity: frame.bleed ? 1 : 0.55 }
      : visualRect && visualRect.open && !hidden.has('visual') && !frame.black
        ? { x: visualRect.x + 1, y: visualRect.y + 1 + headerHeight(zoom), w: visualRect.w - 2, h: visualRect.h - 2 - headerHeight(zoom), z: visualRect.z, opacity: 1 }
        : null;

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
        <>
          {groundPrevious && (
            <div
              key={`prev-${groundPrevious}`}
              className="absolute inset-0 pointer-events-none"
              style={{ backgroundImage: `url(${groundUrl(groundPrevious)})`, backgroundSize: 'cover', backgroundPosition: 'center', filter: 'grayscale(1)' }}
            />
          )}
          <GroundLayer key={groundCurrent ?? 'builtin'} url={groundUrl(groundCurrent)} fade={!!groundPrevious} />
        </>
      )}
      {/* grain: a noise tile rendered ONCE (grainTile) and repeated as a
          background — the live SVG feTurbulence filter + mix-blend-mode it
          replaces was re-rasterised by WebKit whenever the layers above it
          moved (Chris 2026-09-09: signal "absolutely crushing the rendering
          framerate"). Off in the clean look. */}
      {look !== 'clean' && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            opacity: look === 'stream' ? 0.1 : 0.07,
            backgroundImage: `url(${GRAIN_TILE})`,
            // stream: the same tile blown up to 3 px cells — grain an encoder keeps
            backgroundSize: `${256 * LOOK_CELL[look]}px ${256 * LOOK_CELL[look]}px`,
            imageRendering: 'pixelated',
          }}
        />
      )}

      {/* the visual: one layer, always mounted (see visualLayer) — full
          bleed, or framed by the visual window's chrome, or parked hidden */}
      <div
        className="absolute overflow-hidden pointer-events-none"
        style={
          visualLayer
            ? { left: visualLayer.x, top: visualLayer.y, width: visualLayer.w, height: visualLayer.h, zIndex: visualLayer.z, opacity: visualLayer.opacity }
            : { left: 0, top: 0, width: 2, height: 2, opacity: 0, visibility: 'hidden' }
        }
      >
        <VisualWindow />
      </div>

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
          visibility: hidden.has('menubar') || !menubarUp || (!frame.menubar && !arranging) ? 'hidden' : 'visible',
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
                <div className="px-3 leading-[18px] text-[8px] tracking-[0.18em] uppercase text-white/35">director</div>
                <button
                  className="flex items-center gap-2 px-3 leading-[22px] text-left hover:bg-white/10"
                  style={{ color: dOn ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)' }}
                  onClick={() => setDirectorOn(!dOn)}
                >
                  <span className="w-3">{dOn ? '■' : '□'}</span>
                  on
                </button>
                <button
                  className="flex items-center gap-2 px-3 leading-[22px] text-left hover:bg-white/10"
                  style={{ color: dAuto ? 'rgba(255,255,255,0.9)' : 'rgba(255,255,255,0.45)' }}
                  onClick={() => (dAuto ? setDirectorAuto(false) : resumeAuto())}
                >
                  <span className="w-3">{dAuto ? '●' : '○'}</span>
                  auto · {shotLabel(dShot)}
                </button>
                {KEY_SHOTS.map(([key, make, label]) => (
                  <button
                    key={key}
                    className="flex items-center gap-2 px-3 leading-[20px] text-left hover:bg-white/10 text-white/60"
                    onClick={() => forceShot(make())}
                  >
                    <span className="w-3 tabular-nums opacity-50">{key}</span>
                    {label}
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

      {/* windows — at the shot's rects (director.ts); the inset shot scales
          the whole set of them down over the bleed */}
      <div
        className="absolute"
        style={
          frame.inset
            ? { left: frame.inset.x, top: frame.inset.y, width: spec.w, height: spec.h, transform: `scale(${frame.inset.scale})`, transformOrigin: '0 0', zIndex: 5000 }
            : { inset: 0 }
        }
      >
      {WINDOW_ORDER.map((id, i) => {
        if (id === 'visual' && bleed) return null;
        if (id === 'card' && !cardUp) return null;
        if (hidden.has(id)) return null;
        const r = frame.rects[id];
        if (!r) return null;
        const C = CONTENT[id];
        return (
          <OSWindow key={id} id={id} index={i + 1} rect={locked ? r : undefined} locked={locked} hollow={id === 'visual'}>
            <C />
          </OSWindow>
        );
      })}
      </div>
      {(frame.title || frame.black) && <TitleLayer title={frame.title} />}
      </div>
      {!arranging && look !== 'clean' && <SignalOverlay />}
      <NextPanel />
      <BootPanel />
      <EndPanel />
      </div>
    </div>
  );
}
