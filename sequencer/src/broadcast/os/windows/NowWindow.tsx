import { useEffect, useState } from 'react';
import { useSequencerStore } from '../../../state/store';
import { useBroadcast } from '../../setlist';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const STEPS_PER_BAR = 32;

function useClock(): number {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(id);
  }, []);
  return Date.now();
}

export function fmtUptime(startedAt: number | null, now: number): string {
  if (startedAt === null) return '--:--:--';
  const s = Math.floor((now - startedAt) / 1000);
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = String(s % 60).padStart(2, '0');
  return `${h}:${m}:${sec}`;
}

export function NowWindow() {
  const songTitle = useSequencerStore((s) => s.songTitle);
  const bpm = useSequencerStore((s) => s.bpm);
  const rootNote = useSequencerStore((s) => s.rootNote);
  const scale = useSequencerStore((s) => s.scale);
  const playing = useSequencerStore((s) => s.playing);
  const globalStep = useSequencerStore((s) => s.globalStep);
  const startStep = useSequencerStore((s) => s.ghostCompositionStartStep);
  const shape = useSequencerStore((s) => s.sceneGraph.shape);
  const b = useBroadcast();
  const now = useClock();
  const bars = Math.max(0, Math.floor((globalStep - startStep) / STEPS_PER_BAR));
  const key = `${NOTE_NAMES[((rootNote % 12) + 12) % 12]} ${scale}`;
  const title = b.status === 'running' ? songTitle ?? 'untitled' : '—';

  return (
    <div className="h-full flex flex-col px-4 py-3 font-mono">
      <div className="text-[8px] tracking-[0.18em] uppercase text-white/45">
        {b.status === 'running' && b.current !== null ? `${b.current + 1} / ${b.entries.length}` : 'idle'}
      </div>
      <div
        className="font-sans text-white leading-[1.05] mt-1 break-words"
        style={{ fontSize: 'clamp(16px, 4cqw, 30px)', letterSpacing: '0.02em' }}
      >
        {title}
      </div>
      <div className="mt-auto grid grid-cols-4 gap-x-4 gap-y-2 text-[10px] text-white/75 tabular-nums">
        <Cell k="bpm" v={String(Math.round(bpm))} />
        <Cell k="key" v={key} />
        <Cell k="shape" v={shape} />
        <Cell k="bar" v={String(bars + 1).padStart(3, '0')} />
        <Cell k="transport" v={playing ? 'running' : 'stopped'} />
        <Cell k="uptime" v={fmtUptime(b.startedAt, now)} />
        <Cell k="played" v={String(b.played)} />
        <Cell k="next" v={b.next !== null && b.entries[b.next] ? b.entries[b.next].name : '—'} />
      </div>
    </div>
  );
}

function Cell({ k, v }: { k: string; v: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[8px] tracking-[0.18em] uppercase text-white/40">{k}</div>
      <div className="truncate">{v}</div>
    </div>
  );
}
