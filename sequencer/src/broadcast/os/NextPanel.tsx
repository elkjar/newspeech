// The decision, on screen. During an interstitial hold the desktop has
// fallen into static and this is the one stable thing: the set's songs as
// candidates (recent ones greyed), a roll that runs through them and slows
// onto the pick over the first part of the gap, then the incoming song's
// name large, with the gap's progress underneath. Sits ABOVE the signal
// overlay so it stays legible through the noise; it carries its own faint
// flicker instead.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useGap } from '../gap';
import { useBroadcast } from '../setlist';

const ROLL_END = 0.42; // fraction of the hold spent rolling
const ROWS = 12; // list rows always drawn (padded) so the box never resizes
const ROW_H = 18;

export function NextPanel() {
  const phase = useGap((s) => s.phase);
  const progress = useGap((s) => s.progress);
  const nextIdx = useGap((s) => s.nextIdx);
  const wav = useGap((s) => s.wav);
  const entries = useBroadcast((s) => s.entries);
  const recent = useBroadcast((s) => s.recent);
  const current = useBroadcast((s) => s.current);

  // The roll: an index that hops between candidates, hops spacing out as
  // progress approaches ROLL_END, landing on nextIdx.
  const [roll, setRoll] = useState<number | null>(null);
  const lastHop = useRef(0);
  const candidates = useMemo(() => {
    const skip = new Set(recent.slice(-8));
    if (current !== null) skip.add(current);
    const c = entries.map((_, i) => i).filter((i) => !skip.has(i));
    return c.length ? c : entries.map((_, i) => i);
  }, [entries, recent, current]);

  useEffect(() => {
    if (phase !== 'hold') {
      setRoll(null);
      return;
    }
    if (progress >= ROLL_END || nextIdx === null) {
      setRoll(nextIdx);
      return;
    }
    const u = progress / ROLL_END;
    const gap = 70 + 900 * u * u; // ms between hops, slowing
    const now = performance.now();
    if (now - lastHop.current >= gap) {
      lastHop.current = now;
      const pool = candidates.filter((i) => i !== roll);
      setRoll(pool[Math.floor(Math.random() * pool.length)] ?? nextIdx);
    }
  }, [phase, progress, nextIdx, candidates, roll]);

  if (phase !== 'hold' || entries.length === 0) return null;
  const settled = progress >= ROLL_END && nextIdx !== null;
  const lit = settled ? nextIdx : roll;
  const recentSet = new Set(recent.slice(-8));
  // Window the list around the lit row if the set is long; pad short sets
  // so the box is the same size whatever the set and whatever is lit.
  let rows: Array<{ e: (typeof entries)[number]; i: number } | null> = entries.map((e, i) => ({ e, i }));
  if (rows.length > ROWS) {
    const center = lit ?? 0;
    const start = Math.max(0, Math.min(rows.length - ROWS, center - Math.floor(ROWS / 2)));
    rows = rows.slice(start, start + ROWS);
  }
  while (rows.length < ROWS) rows.push(null);
  const flicker = 0.82 + 0.18 * Math.random();

  return (
    <div className="fixed inset-0 pointer-events-none flex items-center justify-center" style={{ zIndex: 20001 }}>
      <div
        className="font-mono text-white"
        style={{
          width: 560,
          height: 22 + 84 + ROWS * ROW_H + 12 + 2,
          background: 'rgba(5,5,5,0.86)',
          border: '1px solid rgba(255,255,255,0.28)',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.9), 0 18px 40px rgba(0,0,0,0.55)',
          opacity: flicker,
        }}
      >
        <div className="flex items-center gap-3 px-3" style={{ height: 22, borderBottom: '1px solid rgba(255,255,255,0.22)', background: 'rgba(255,255,255,0.04)' }}>
          <span className="text-[8px] tracking-[0.2em] opacity-40">··</span>
          <span className="font-sans text-[10px] tracking-[0.18em] lowercase">next</span>
          <span className="ml-auto text-[8px] tracking-[0.16em] uppercase text-white/45 truncate">{wav ? wav.split('/').pop() : ''}</span>
        </div>
        <div className="px-4 pt-3" style={{ height: 84 }}>
          <div className="text-[8px] tracking-[0.18em] uppercase text-white/45">{settled ? 'incoming' : 'deciding'}</div>
          <div
            className="font-sans mt-1 whitespace-nowrap overflow-hidden text-ellipsis"
            style={{ fontSize: 34, lineHeight: '40px', height: 40, letterSpacing: '0.02em', opacity: settled ? 1 : 0.55 }}
          >
            {lit !== null && entries[lit] ? entries[lit].name : '—'}
          </div>
        </div>
        <div className="px-1 pb-2 text-[9px]" style={{ height: ROWS * ROW_H + 12 }}>
          {rows.map((row, r) => {
            if (!row) return <div key={`pad-${r}`} style={{ height: ROW_H }} />;
            const { e, i } = row;
            const isLit = i === lit;
            const isRecent = recentSet.has(i) || i === current;
            return (
              <div
                key={e.path + i}
                className="flex items-center gap-3 px-3 whitespace-nowrap"
                style={{
                  height: ROW_H,
                  lineHeight: `${ROW_H}px`,
                  color: isLit ? '#fff' : isRecent ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.55)',
                  background: isLit ? 'rgba(255,255,255,0.1)' : 'transparent',
                }}
              >
                <span className="tabular-nums opacity-50 w-7 text-right">{String(i + 1).padStart(3, '0')}</span>
                <span className="w-3 text-center">{isLit ? (settled ? '●' : '○') : isRecent ? '·' : ' '}</span>
                <span className="truncate">{e.name}</span>
                <span className="ml-auto text-[8px] tracking-[0.16em] uppercase opacity-60">{i === current ? 'ended' : isRecent ? 'recent' : ''}</span>
              </div>
            );
          })}
        </div>
        <div className="h-[2px] bg-white/10">
          <div className="h-full bg-white/70" style={{ width: `${(progress * 100).toFixed(1)}%` }} />
        </div>
      </div>
    </div>
  );
}
