// The BROADCAST desktop — a fake operating system whose windows each show
// one thing about the running set. Monochrome, zxx wordmark, the site's grid
// and grain, invented chrome. Windows drag/resize/raise/close; the layout
// persists so the machine boots into the same face every time.
import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { useSequencerStore } from '../../state/store';
import { Visualizer } from '../../stream/Visualizer';
import { useBroadcast } from '../setlist';
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
  const setBackdrop = useLayout((s) => s.setBackdrop);
  const reset = useLayout((s) => s.reset);
  const clamp = useLayout((s) => s.clamp);
  useEffect(() => {
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [clamp]);
  const playing = useSequencerStore((s) => s.playing);
  const songTitle = useSequencerStore((s) => s.songTitle);
  const bpm = useSequencerStore((s) => s.bpm);
  const b = useBroadcast();
  const clock = useClockText();

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

      {/* menubar */}
      <div
        className="absolute top-0 inset-x-0 flex items-center gap-5 px-4 text-[8px] tracking-[0.16em] uppercase"
        style={{ height: 28, background: 'rgba(5,5,5,0.85)', borderBottom: '1px solid rgba(255,255,255,0.22)', zIndex: 10000 }}
      >
        <span className="font-sans text-[12px] tracking-[0.22em] normal-case">BROADCAST</span>
        <span className="text-white/50">
          {b.status === 'running'
            ? `${playing ? '▶' : '■'} ${songTitle ?? 'untitled'} · ${Math.round(bpm)} bpm · ${b.current !== null ? b.current + 1 : 0}/${b.entries.length}`
            : b.status === 'loading'
              ? 'loading set…'
              : 'no set'}
        </span>
        <span className="ml-auto flex items-center gap-4 text-white/45">
          {WINDOW_ORDER.map((id) => (
            <button
              key={id}
              className="hover:text-white"
              style={{ color: windows[id].open ? 'rgba(255,255,255,0.85)' : undefined }}
              onClick={() => toggle(id)}
              title={windows[id].open ? 'close' : 'open'}
            >
              {windows[id].open ? '■' : '□'} {WINDOW_TITLES[id]}
            </button>
          ))}
          <span className="text-white/20">|</span>
          <button className="hover:text-white" style={{ color: backdrop ? 'rgba(255,255,255,0.85)' : undefined }} onClick={() => setBackdrop(!backdrop)}>
            {backdrop ? '■' : '□'} backdrop
          </button>
          <button className="hover:text-white" onClick={reset} title="reset window layout">
            reset
          </button>
          <span className="text-white/20">|</span>
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
