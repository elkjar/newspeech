import { useEffect, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useSequencerStore } from '../../../state/store';
import { useBroadcast } from '../../setlist';
import { fmtUptime } from './NowWindow';

interface RawStatus {
  channels: number;
  sample_rate: number;
}

// Machine telemetry — a box that runs for days should show its own health.
export function SysWindow() {
  const [status, setStatus] = useState<RawStatus | null>(null);
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  const [lim, setLim] = useState(0);
  const [limHold, setLimHold] = useState(0);
  const [now, setNow] = useState(Date.now());
  const bootDone = useSequencerStore((s) => s.bootDone);
  const playing = useSequencerStore((s) => s.playing);
  const b = useBroadcast();

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let alive = true;
    const poll = async () => {
      try {
        const s = await invoke<RawStatus>('audio_status');
        if (alive) setStatus(s);
      } catch {
        if (alive) setStatus(null);
      }
    };
    void poll();
    const id = window.setInterval(() => void poll(), 2000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | null = null;
    void listen<number>('audio:level', (e) => {
      setLevel(e.payload);
      setPeak((p) => Math.max(p * 0.97, e.payload));
    }).then((fn) => {
      un = fn;
    });
    return () => un?.();
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let un: (() => void) | null = null;
    void listen<number>('audio:limiter', (e) => {
      setLim(e.payload);
      setLimHold((p) => Math.max(p * 0.96, e.payload));
    }).then((fn) => {
      un = fn;
    });
    return () => un?.();
  }, []);

  const db = level > 0 ? (20 * Math.log10(level)).toFixed(1) : '-inf';

  return (
    <div className="h-full grid grid-cols-2 gap-x-6 px-4 py-3 font-mono text-[9px] text-white/70">
      <div className="flex flex-col gap-1.5">
        <Row k="audio" v={status ? `${status.channels} ch · ${(status.sample_rate / 1000).toFixed(1)} kHz` : isTauri() ? 'device closed' : 'browser'} hot={!status && isTauri()} />
        <Row k="engine" v={bootDone ? (playing ? 'running' : 'idle') : 'booting'} />
        <div className="flex items-center gap-2">
          <span className="w-16 text-[8px] tracking-[0.16em] uppercase text-white/40">out</span>
          <div className="flex-1 h-[6px] bg-white/10 relative">
            <div className="absolute inset-y-0 left-0 bg-white/80" style={{ width: `${Math.min(100, Math.round(level * 100))}%` }} />
            <div className="absolute inset-y-0 w-px bg-white" style={{ left: `${Math.min(100, Math.round(peak * 100))}%` }} />
          </div>
          <span className="w-12 text-right tabular-nums">{db}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Row k="uptime" v={fmtUptime(b.startedAt, now)} />
        <Row k="played" v={String(b.played)} />
        <Row k="mode" v={`${b.mode}${b.devSongBars ? ` · dev ${b.devSongBars} bars` : ''}`} />
        <div className="flex items-center gap-2">
          <span className="w-16 text-[8px] tracking-[0.16em] uppercase text-white/40">limit</span>
          <div className="flex-1 h-[6px] bg-white/10 relative">
            <div className="absolute inset-y-0 left-0 bg-white/80" style={{ width: `${Math.min(100, Math.round((lim / 12) * 100))}%` }} />
            <div className="absolute inset-y-0 w-px bg-white" style={{ left: `${Math.min(100, Math.round((limHold / 12) * 100))}%` }} />
          </div>
          <span className="w-12 text-right tabular-nums">{lim > 0.05 ? `-${lim.toFixed(1)}` : '0.0'}</span>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v, hot }: { k: string; v: string; hot?: boolean }) {
  return (
    <div className="flex items-baseline gap-2 min-w-0">
      <span className="w-16 shrink-0 text-[8px] tracking-[0.16em] uppercase text-white/40">{k}</span>
      <span className={`truncate ${hot ? 'text-red-400' : ''}`}>{v}</span>
    </div>
  );
}
