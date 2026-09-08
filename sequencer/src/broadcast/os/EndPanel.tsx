// End of transmission. After the last song of a `--songs N` run the desktop
// falls into static (gap phase `off`), an interstitial plays under it, and
// this box stays up: what the station did tonight. Same chrome as the next
// and boot panels; fixed size; above the signal overlay.
import { useEffect, useState } from 'react';
import { useGap } from '../gap';
import { useBroadcast } from '../setlist';
import { useCards } from '../cards';
import { fmtUptime } from './windows/NowWindow';

export function EndPanel() {
  const phase = useGap((s) => s.phase);
  const count = useGap((s) => s.count);
  const signedOffAt = useGap((s) => s.signedOffAt);
  const b = useBroadcast();
  const cardsShown = useCards((s) => s.count);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  if (phase !== 'off') return null;
  const flicker = 0.84 + 0.16 * Math.random();
  const facts: Array<[string, string]> = [
    ['songs', String(b.played + 1)],
    ['on air', fmtUptime(b.startedAt, signedOffAt ?? Date.now())],
    ['interstitials', String(count)],
    ['idents', String(cardsShown)],
    ['last', b.current !== null && b.entries[b.current] ? b.entries[b.current].name : '—'],
  ];
  return (
    <div className="fixed inset-0 pointer-events-none flex items-center justify-center" style={{ zIndex: 20001 }}>
      <div
        className="font-mono text-white"
        style={{
          width: 560,
          background: 'rgba(5,5,5,0.9)',
          border: '1px solid rgba(255,255,255,0.28)',
          boxShadow: '0 0 0 1px rgba(0,0,0,0.9), 0 18px 40px rgba(0,0,0,0.55)',
          opacity: flicker,
        }}
      >
        <div className="flex items-center gap-3 px-3" style={{ height: 22, borderBottom: '1px solid rgba(255,255,255,0.22)', background: 'rgba(255,255,255,0.04)' }}>
          <span className="text-[8px] tracking-[0.2em] opacity-40">··</span>
          <span className="font-sans text-[10px] tracking-[0.18em] lowercase">station</span>
          <span className="ml-auto text-[8px] tracking-[0.16em] uppercase text-white/45">signed off</span>
        </div>
        <div className="flex flex-col px-5 pt-5" style={{ height: 14 * 18 + 14 }}>
          <div className="text-[8px] tracking-[0.18em] uppercase text-white/45">NEWSPEECH // BROADCAST</div>
          <div className="font-sans mt-1" style={{ fontSize: 34, lineHeight: '40px', letterSpacing: '0.02em' }}>
            end of transmission
          </div>
          <div className="mt-4 grid grid-cols-[96px_1fr] gap-y-1 text-[10px]">
            {facts.map(([k, v]) => (
              <FactRow key={k} k={k} v={v} />
            ))}
          </div>
        </div>
        <div className="h-[2px] bg-white/10" />
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
