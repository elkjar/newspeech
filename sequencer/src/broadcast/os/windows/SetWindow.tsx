import { useEffect, useRef } from 'react';
import { useSequencerStore } from '../../../state/store';
import { useBroadcast } from '../../setlist';

const STEPS_PER_BAR = 32;

// The set: every song in the folder, the current one lit, the staged next
// one marked, recently played dimmed. Drop a folder or .seq files anywhere
// on the desktop to add to it.
export function SetWindow() {
  const b = useBroadcast();
  const globalStep = useSequencerStore((s) => s.globalStep);
  const startStep = useSequencerStore((s) => s.ghostCompositionStartStep);
  const listRef = useRef<HTMLDivElement>(null);
  const elapsedBars = Math.max(0, Math.floor((globalStep - startStep) / STEPS_PER_BAR));
  const recent = new Set(b.recent.slice(-8));

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-current="1"]') as HTMLElement | null;
    el?.scrollIntoView({ block: 'nearest' });
  }, [b.current]);

  if (b.entries.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-[10px] tracking-[0.14em] uppercase text-white/60 px-6 text-center">
        <div className="font-sans text-[16px] tracking-[0.2em] text-white normal-case">no set</div>
        <div>{b.status === 'loading' ? 'loading…' : 'drop a folder of .seq files anywhere'}</div>
        {b.error && <div className="text-red-400 normal-case tracking-normal">{b.error}</div>}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col text-[9px] font-mono">
      <div className="flex items-center gap-4 px-3 py-1.5 text-[8px] tracking-[0.18em] uppercase text-white/45 border-b border-white/10 shrink-0">
        <span>{b.entries.length} songs</span>
        <span>{b.mode}</span>
        <span>played {b.played}</span>
        <span className="ml-auto">{b.current !== null ? `bar ${String(elapsedBars + 1).padStart(3, '0')}` : ''}</span>
      </div>
      <div ref={listRef} className="flex-1 overflow-y-auto py-1">
        {b.entries.map((e, i) => {
          const isCur = i === b.current;
          const isNext = i === b.next;
          const isRecent = recent.has(i);
          return (
            <div
              key={e.path + i}
              data-current={isCur ? '1' : undefined}
              className="flex items-center gap-3 px-3 leading-[20px] whitespace-nowrap"
              style={{
                color: isCur ? '#fff' : isNext ? 'rgba(255,255,255,0.8)' : isRecent ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.55)',
                background: isCur ? 'rgba(255,255,255,0.08)' : 'transparent',
              }}
            >
              <span className="tabular-nums opacity-50 w-7 text-right">{String(i + 1).padStart(3, '0')}</span>
              <span className="w-3 text-center">{isCur ? '●' : isNext ? '○' : isRecent ? '·' : ' '}</span>
              <span className="truncate">{e.name}</span>
              <span className="ml-auto text-[8px] tracking-[0.16em] uppercase opacity-60">
                {isCur ? 'playing' : isNext ? 'next' : isRecent ? 'recent' : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
