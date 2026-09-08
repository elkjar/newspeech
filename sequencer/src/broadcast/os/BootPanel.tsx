// The station coming on air. While the gap phase is `boot` the desktop is
// collapsed and this terminal types the boot log (boot.ts) line by line,
// cursor blinking, then hands to the reboot when the first downbeat lands.
// Fixed size, above the signal overlay, same chrome as the next panel.
import { useEffect, useState } from 'react';
import { useGap } from '../gap';
import { useStationBoot } from '../boot';

const ROWS = 14;
const ROW_H = 18;

export function BootPanel() {
  const phase = useGap((s) => s.phase);
  const progress = useGap((s) => s.progress);
  const lines = useStationBoot((s) => s.lines);
  const [blink, setBlink] = useState(true);
  useEffect(() => {
    const id = window.setInterval(() => setBlink((b) => !b), 530);
    return () => window.clearInterval(id);
  }, []);

  const visible = phase === 'boot' || (phase === 'reboot' && progress < 0.1);
  if (!visible) return null;
  const fade = phase === 'reboot' ? 1 - progress / 0.1 : 1;
  const shown = lines.slice(-ROWS);
  const flicker = 0.84 + 0.16 * Math.random();

  return (
    <div className="fixed inset-0 pointer-events-none flex items-center justify-center" style={{ zIndex: 20001 }}>
      <div
        className="font-mono text-white"
        style={{
          width: 560,
          height: 22 + 14 + ROWS * ROW_H + 14 + 2,
          background: 'rgba(5,5,5,0.9)',
          border: '1px solid rgba(255,255,255,0.28)',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.9), 0 18px 40px rgba(0,0,0,0.55)',
          opacity: flicker * fade,
        }}
      >
        <div className="flex items-center gap-3 px-3" style={{ height: 22, borderBottom: '1px solid rgba(255,255,255,0.22)', background: 'rgba(255,255,255,0.04)' }}>
          <span className="text-[8px] tracking-[0.2em] opacity-40">··</span>
          <span className="font-sans text-[10px] tracking-[0.18em] lowercase">station</span>
          <span className="ml-auto text-[8px] tracking-[0.16em] uppercase text-white/45">initializing</span>
        </div>
        <div className="px-4 py-[7px] text-[10px]" style={{ height: ROWS * ROW_H + 14 }}>
          {shown.map((l, i) => {
            const last = i === shown.length - 1;
            return (
              <div key={`${l.t}-${i}`} className="flex gap-3 whitespace-nowrap overflow-hidden text-ellipsis" style={{ height: ROW_H, lineHeight: `${ROW_H}px` }}>
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
          <div className="h-full bg-white/40" style={{ width: `${Math.min(100, (shown.length / ROWS) * 100).toFixed(0)}%` }} />
        </div>
      </div>
    </div>
  );
}
