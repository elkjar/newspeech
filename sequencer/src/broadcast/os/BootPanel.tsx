// The station coming on air. Standby first: the desktop is collapsed and
// this box shows what's loaded with one GO button — the operator's one
// control (Loopback / the recorder get set up against the running app
// here). GO (or space) replays the boot log from the top, typed at
// BOOT_LINE_MS, cursor blinking; the set loader lands the first downbeat
// after the last line and the panel hands to the reboot. Fixed size, above
// the signal overlay, same chrome as the next panel.
import { useEffect, useState } from 'react';
import { useGap } from '../gap';
import { useStationBoot, stationGo, BOOT_LINE_MS } from '../boot';
import { useBroadcast } from '../setlist';

const ROWS = 14;
const ROW_H = 18;

export function BootPanel() {
  const phase = useGap((s) => s.phase);
  const progress = useGap((s) => s.progress);
  const station = useStationBoot((s) => s.phase);
  const ready = useStationBoot((s) => s.ready);
  const goAt = useStationBoot((s) => s.goAt);
  const lines = useStationBoot((s) => s.lines);
  const b = useBroadcast();
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
  const box = {
    width: 560,
    height: 22 + 14 + ROWS * ROW_H + 14 + 2,
    background: 'rgba(5,5,5,0.9)',
    border: '1px solid rgba(255,255,255,0.28)',
    boxShadow: '0 0 0 1px rgba(0,0,0,0.9), 0 18px 40px rgba(0,0,0,0.55)',
    opacity: flicker * fade,
  };

  if (station === 'standby') {
    const facts: Array<[string, string]> = [
      ['set', b.status === 'running' || b.entries.length ? `${b.entries.length} songs` : b.status === 'loading' ? 'loading…' : b.error ?? 'none'],
      ['first', b.current !== null && b.entries[b.current] ? b.entries[b.current].name : '—'],
      ['staged', b.next !== null && b.entries[b.next] ? b.entries[b.next].name : '—'],
      ['mode', `${b.mode} · ghost on`],
    ];
    return (
      <div className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 20001, pointerEvents: 'none' }}>
        <div className="font-mono text-white" style={{ ...box, pointerEvents: 'auto' }}>
          <div className="flex items-center gap-3 px-3" style={{ height: 22, borderBottom: '1px solid rgba(255,255,255,0.22)', background: 'rgba(255,255,255,0.04)' }}>
            <span className="text-[8px] tracking-[0.2em] opacity-40">··</span>
            <span className="font-sans text-[10px] tracking-[0.18em] lowercase">station</span>
            <span className="ml-auto text-[8px] tracking-[0.16em] uppercase text-white/45">standby</span>
          </div>
          <div className="flex flex-col px-5 pt-5" style={{ height: ROWS * ROW_H + 14 }}>
            <div className="text-[8px] tracking-[0.18em] uppercase text-white/45">NEWSPEECH // BROADCAST</div>
            <div className="font-sans mt-1" style={{ fontSize: 34, lineHeight: '40px', letterSpacing: '0.02em' }}>
              {ready ? 'ready' : 'preparing'}
            </div>
            <div className="mt-4 grid grid-cols-[64px_1fr] gap-y-1 text-[10px]">
              {facts.map(([k, v]) => (
                <FactRow key={k} k={k} v={v} />
              ))}
            </div>
            <div className="mt-auto mb-4 flex items-center gap-4">
              <button
                onClick={stationGo}
                disabled={!ready}
                className="font-sans tracking-[0.22em] uppercase"
                style={{
                  padding: '10px 28px',
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
              <span className="text-[9px] tracking-[0.16em] uppercase text-white/40">{ready ? 'or press space · goes on air' : 'loading the set'}</span>
            </div>
          </div>
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
      <div className="font-mono text-white" style={box}>
        <div className="flex items-center gap-3 px-3" style={{ height: 22, borderBottom: '1px solid rgba(255,255,255,0.22)', background: 'rgba(255,255,255,0.04)' }}>
          <span className="text-[8px] tracking-[0.2em] opacity-40">··</span>
          <span className="font-sans text-[10px] tracking-[0.18em] lowercase">station</span>
          <span className="ml-auto text-[8px] tracking-[0.16em] uppercase text-white/45">initializing</span>
        </div>
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

function FactRow({ k, v }: { k: string; v: string }) {
  return (
    <>
      <span className="text-[8px] tracking-[0.18em] uppercase text-white/40 leading-[16px]">{k}</span>
      <span className="truncate text-white/80 leading-[16px]">{v}</span>
    </>
  );
}
