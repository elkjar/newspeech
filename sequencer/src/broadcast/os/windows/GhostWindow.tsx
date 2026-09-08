import { useSequencerStore, type GhostPickLogEntry } from '../../../state/store';
import { useStreamState } from '../streamState';

const MACROS = ['density', 'chaos', 'motion', 'drift', 'tension'] as const;

function fmtEntry(e: GhostPickLogEntry): string {
  switch (e.kind) {
    case 'auto':
      return `pick  bank ${String(e.slot + 1).padStart(2, '0')}  e ${e.pickedEntropy.toFixed(2)}  Δ${e.deltaFromTarget >= 0 ? '+' : ''}${e.deltaFromTarget.toFixed(2)}  of ${e.candidateCount}`;
    case 'manual':
      return `queue bank ${String(e.slot + 1).padStart(2, '0')}`;
    case 'commit':
      return `land  bank ${String(e.slot + 1).padStart(2, '0')}${e.dwellBars ? `  hold ${e.dwellBars}` : ''}`;
    case 'shape':
      return `shape ${e.from} → ${e.to}`;
    case 'ghost':
      return `ghost ${e.enabled ? 'on' : 'off'}`;
    case 'transport':
      return e.playing ? 'transport run' : 'transport stop';
    case 'system':
      return e.label;
    case 'step':
      return `step  t${e.track} s${e.step}`;
    case 'scene':
      return `scene ${String(e.slot + 1).padStart(2, '0')}`;
  }
}

// Short voice name: the last two path segments of a namespaced voice id
// (kit / voice), which is what a listener would call it.
function voiceName(id: string): string {
  const parts = id.split(/[/:]/).filter(Boolean);
  return parts.slice(-2).join(' / ');
}

// The primary window. Ghost's mind: the five macros as live meters, what's
// sounding right now (every voice heard in the last seconds, brightest =
// just fired), the decision log as a terminal tail, and the moves it made.
export function GhostWindow() {
  const snap = useStreamState((s) => s.snapshot);
  const rows = useStreamState((s) => s.rows);
  const hearing = useStreamState((s) => s.hearing);
  const log = useSequencerStore((s) => s.ghostPickLog);
  const now = performance.now();
  const macros = snap
    ? MACROS.map((k) => [k, snap[k]] as const)
    : MACROS.map((k) => [k, 0] as const);
  const decisions = log.slice(-40);
  const moves = rows.filter((r) => r.kind !== 'divider' && r.kind !== 'hit').slice(-30);
  const heard = hearing.slice(0, 14);

  return (
    <div className="h-full flex flex-col font-mono text-[9px]">
      <div className="px-3 pt-2 pb-2 border-b border-white/10 shrink-0">
        {macros.map(([k, v]) => (
          <div key={k} className="flex items-center gap-2 leading-[16px]">
            <span className="w-14 text-[8px] tracking-[0.16em] uppercase text-white/45">{k}</span>
            <div className="flex-1 h-[6px] bg-white/10 relative">
              <div className="absolute inset-y-0 left-0 bg-white/80" style={{ width: `${Math.round(v * 100)}%` }} />
            </div>
            <span className="w-8 text-right tabular-nums text-white/70">{v.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <div className="shrink-0 border-b border-white/10" style={{ minHeight: 120 }}>
        <div className="px-3 py-1 text-[8px] tracking-[0.18em] uppercase text-white/40">hearing</div>
        <div className="px-3 pb-2 flex flex-col">
          {heard.length === 0 && <div className="text-white/30 leading-[15px]">—</div>}
          {heard.map((h) => {
            const age = Math.min(1, (now - h.lastT) / 3000);
            const a = 1 - age * 0.75;
            return (
              <div key={h.voice} className="flex items-center gap-2 leading-[15px] whitespace-nowrap" style={{ opacity: a }}>
                <span className="w-2 text-center" style={{ color: age < 0.08 ? '#fff' : 'rgba(255,255,255,0.35)' }}>▮</span>
                <span className="text-white/90 truncate flex-1">{voiceName(h.voice)}</span>
                <div className="w-14 h-[4px] bg-white/10 relative">
                  <div className="absolute inset-y-0 left-0 bg-white/80" style={{ width: `${Math.round(Math.min(1, h.velocity) * 100)}%` }} />
                </div>
                <span className="w-6 text-right tabular-nums text-white/40">{h.count > 99 ? '99+' : h.count}</span>
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="px-3 py-1 text-[8px] tracking-[0.18em] uppercase text-white/40 shrink-0">decisions</div>
        <div className="flex-1 overflow-hidden px-3 flex flex-col justify-end">
          {decisions.map((e, i) => (
            <div key={i} className="flex gap-3 leading-[15px] whitespace-nowrap" style={{ opacity: 0.35 + 0.65 * ((i + 1) / decisions.length) }}>
              <span className="tabular-nums text-white/40 w-12">{String(Math.floor(e.globalStep / 32) + 1).padStart(5, '0')}</span>
              <span className="text-white/85 truncate">{fmtEntry(e)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="h-[26%] min-h-0 flex flex-col border-t border-white/10">
        <div className="px-3 py-1 text-[8px] tracking-[0.18em] uppercase text-white/40 shrink-0">moves</div>
        <div className="flex-1 overflow-hidden px-3 flex flex-col justify-end">
          {moves.map((r, i) => (
            <div key={r.id} className="flex gap-3 leading-[15px] whitespace-nowrap" style={{ opacity: 0.35 + 0.65 * ((i + 1) / moves.length) }}>
              <span className="text-white/40 w-12">{r.kind}</span>
              <span className="text-white/80 truncate">{r.label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
