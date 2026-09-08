// The BROADCAST desktop — a fake operating system whose windows each show
// one thing about the running set. Monochrome, zxx wordmark, the site's grid
// and grain, invented chrome. Windows drag/resize/raise/close; the layout
// persists so the machine boots into the same face every time.
import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Visualizer } from '../../stream/Visualizer';
import { useLayout, WINDOW_ORDER, WINDOW_TITLES, type WindowId } from './layout';
import { OSWindow } from './Window';
import { SetWindow } from './windows/SetWindow';
import { NowWindow } from './windows/NowWindow';
import { BanksWindow } from './windows/BanksWindow';
import { ShapeWindow } from './windows/ShapeWindow';
import { GhostWindow } from './windows/GhostWindow';
import { VisualWindow } from './windows/VisualWindow';
import { SysWindow } from './windows/SysWindow';

const CONTENT: Record<WindowId, () => JSX.Element> = {
  set: SetWindow,
  now: NowWindow,
  banks: BanksWindow,
  shape: ShapeWindow,
  ghost: GhostWindow,
  visual: VisualWindow,
  sys: SysWindow,
};

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
  useEffect(() => {
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [clamp]);
  const clock = useClockText();
  const [menu, setMenu] = useState(false);

  return (
    <div className="fixed inset-0 overflow-hidden text-white font-mono select-none" style={{ background: '#050505', cursor: 'default' }}>
      {/* grid + grain ground */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            'radial-gradient(rgba(255,255,255,0.10) 0.6px, transparent 0.7px)',
          backgroundSize: '24px 24px',
          backgroundPosition: '12px 12px',
        }}
      />
      <svg className="absolute inset-0 w-full h-full pointer-events-none" style={{ opacity: 0.07, mixBlendMode: 'screen' }}>
        <filter id="ns-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch" />
          <feColorMatrix values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0 0 0 1 0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#ns-grain)" />
      </svg>

      {backdrop && isTauri() && (
        <div className="absolute inset-0" style={{ opacity: 0.55 }}>
          <Visualizer />
        </div>
      )}

      {/* menubar — wordmark, what's playing, clock. Window management lives
          behind one item so the bar stays quiet on a stream. */}
      <div
        className="absolute top-0 inset-x-0 flex items-center gap-5 px-4 text-[9px] tracking-[0.16em] uppercase"
        style={{ height: 28, background: 'rgba(5,5,5,0.85)', borderBottom: '1px solid rgba(255,255,255,0.22)', zIndex: 10000 }}
      >
        <span className="font-sans text-[12px] tracking-[0.22em] normal-case">NEWSPEECH // BROADCAST</span>
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
              </div>
            )}
          </span>
          <span className="tabular-nums text-white/70">{clock}</span>
        </span>
      </div>

      {/* windows */}
      {WINDOW_ORDER.map((id, i) => {
        if (id === 'visual' && backdrop) return null;
        const C = CONTENT[id];
        return (
          <OSWindow key={id} id={id} index={i + 1}>
            <C />
          </OSWindow>
        );
      })}
    </div>
  );
}
