import { useEffect, useRef, useState } from 'react';
import { sampleShape } from '../ghost/shape';
import {
  subscribeStreamEvents,
  type StreamEvent,
  type StreamShape,
  type BankSummary,
  type EntropyBreakdown,
} from './streamEvents';

// Wall-of-noise datafeed for the stream window. Subscribes to the main
// window's event bus over Tauri events (each WKWebView is a separate JS
// context, so we can't share zustand across windows directly).
//
// Layout (top → bottom):
//   header (stream · live + clock + version)
//   density section (line trace, ported from GhostDebug.DensityTrace)
//   ghost section (entropy histogram + breakdown + shape preview + P/T)
//   scrolling event log
//   footer (event count)

type DisplayKind =
  | 'ghost'
  | 'param'
  | 'mutate'
  | 'lfo'
  | 'visual'
  | 'divider';

interface FeedRow {
  id: number;
  t: number;
  kind: DisplayKind;
  text: string;
}

interface GhostState {
  shape: StreamShape;
  phaseLength: number;
  phase: number;
  targetEntropy: number;
  ghostEnabled: boolean;
  bankOrderMode: 'sequence' | 'entropy';
  elapsedBars: number;
  minE: number;
  maxE: number;
  activeBank: number | null;
  pendingBank: number | null;
  bankSummary: Array<BankSummary | null>;
  activeBreakdown: EntropyBreakdown | null;
}

const MAX_ROWS = 80;
const TRACE_SAMPLES = 128;
const TRACE_WIDTH = 260;
const TRACE_HEIGHT = 52;

// Histogram sizing — scaled up vs GhostDebug's in-sequencer dimensions so
// the bars read well on a TV at viewing distance.
const HIST_CELL_W = 12;
const HIST_CELL_GAP = 3;
const HIST_HEIGHT = 32;
const HIST_BOTTOM_PAD = 4;
const HIST_BAR_MAX = HIST_HEIGHT - HIST_BOTTOM_PAD;
const HIST_WIDTH = 16 * HIST_CELL_W + 15 * HIST_CELL_GAP;
const SHAPE_PREVIEW_W = 36;
const SHAPE_PREVIEW_H = 12;

function fmt(n: number): string {
  return n.toFixed(2);
}

function fmtNoZero(n: number): string {
  const s = n.toFixed(2);
  return s.startsWith('0.') ? s.slice(1) : s;
}

function padPct(n: number): string {
  return Math.round(n * 100).toString().padStart(2, '0');
}

function fmtClock(t: number): string {
  const d = new Date(t);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function streamEventToRow(e: StreamEvent, id: number, t: number): FeedRow | null {
  switch (e.kind) {
    case 'ghost':
      return { id, t, kind: 'ghost', text: e.label };
    case 'param':
      return { id, t, kind: 'param', text: e.label };
    case 'mutate':
      return { id, t, kind: 'mutate', text: e.label };
    case 'lfo':
      return { id, t, kind: 'lfo', text: e.label };
    case 'visual':
      return { id, t, kind: 'visual', text: e.label };
    case 'divider':
      return { id, t, kind: 'divider', text: `─── ${e.label} ───` };
    case 'state':
    case 'step':
      // State snapshots drive the overlays + visualizer params; step
      // triggers drive flares. Neither produces a log row.
      return null;
  }
}

function EntropyHistogram({
  ghost,
}: {
  ghost: GhostState;
}) {
  const targetY =
    HIST_HEIGHT - HIST_BOTTOM_PAD - ghost.targetEntropy * HIST_BAR_MAX;
  const hasPopulated = ghost.bankSummary.some((s) => s !== null);

  return (
    <div
      className="relative flex items-end"
      style={{
        gap: HIST_CELL_GAP,
        height: HIST_HEIGHT,
        width: HIST_WIDTH,
      }}
    >
      {ghost.bankSummary.map((slot, i) => {
        const filled = slot !== null;
        const entropy = slot?.entropy ?? 0;
        const isTransition = slot?.kind === 'transition';
        const isActive = i === ghost.activeBank;
        const isPending = i === ghost.pendingBank;
        const barHeight = filled ? Math.max(1, Math.round(entropy * HIST_BAR_MAX)) : 0;
        const bg = !filled
          ? 'rgba(255,255,255,0.08)'
          : isActive
            ? 'rgba(255,255,255,1)'
            : isPending
              ? 'rgba(255,255,255,0.65)'
              : isTransition
                ? 'rgba(255,255,255,0.35)'
                : 'rgba(255,255,255,0.55)';
        return (
          <div
            key={i}
            style={{ width: HIST_CELL_W, height: HIST_HEIGHT }}
            className="relative flex items-end"
          >
            <div
              style={{
                width: '100%',
                height: filled ? barHeight : 1,
                marginBottom: HIST_BOTTOM_PAD,
                background: bg,
              }}
            />
          </div>
        );
      })}
      {hasPopulated && (
        <div
          className="absolute pointer-events-none"
          style={{
            left: 0,
            right: 0,
            top: targetY - 0.5,
            height: 1,
            background: ghost.ghostEnabled
              ? 'rgba(255,255,255,0.55)'
              : 'rgba(255,255,255,0.18)',
          }}
        />
      )}
    </div>
  );
}

function ShapePreview({ shape }: { shape: StreamShape }) {
  const samples = sampleShape(shape, 0, 1, 24);
  const points = samples
    .map((v, i) => {
      const x = (i / (samples.length - 1)) * (SHAPE_PREVIEW_W - 2) + 1;
      const y = SHAPE_PREVIEW_H - 1 - v * (SHAPE_PREVIEW_H - 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg width={SHAPE_PREVIEW_W} height={SHAPE_PREVIEW_H} className="opacity-60">
      <polyline
        points={points}
        fill="none"
        stroke="white"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function GhostSection({ ghost }: { ghost: GhostState | null }) {
  if (!ghost) {
    return (
      <div className="px-4 py-2 shrink-0 font-mono text-[10px] opacity-40">
        ghost · waiting for state
      </div>
    );
  }
  const active = ghost.activeBreakdown;
  return (
    <div className="px-4 pt-2 pb-3 shrink-0 flex flex-col gap-1">
      <div className="text-[8px] uppercase tracking-[0.18em] opacity-50 font-mono leading-[1.35]">
        ghost · entropy
      </div>
      <div className="flex flex-row items-center gap-3">
        <span className="text-[10px] uppercase tracking-[0.12em] opacity-55 w-10 font-mono">
          {ghost.shape.slice(0, 3)}
        </span>
        <EntropyHistogram ghost={ghost} />
      </div>
      <div className="flex items-center gap-2 text-[10px] tracking-[0.12em] opacity-65 tabular-nums font-mono">
        {active ? (
          <>
            <span className="opacity-100">{fmt(active.total)}</span>
            <span>α{padPct(active.channels)}</span>
            <span>β{padPct(active.voiceType)}</span>
            <span>γ{padPct(active.stepDensity)}</span>
            <span>δ{padPct(active.mutation)}</span>
            <span>ζ{padPct(active.polyphony)}</span>
            <span className="opacity-70">
              {fmtNoZero(ghost.minE)}→{fmtNoZero(ghost.maxE)}
            </span>
          </>
        ) : (
          <span className="opacity-40">no active bank</span>
        )}
      </div>
      <div className="flex items-center gap-2 text-[10px] tracking-[0.12em] opacity-65 tabular-nums font-mono">
        <ShapePreview shape={ghost.shape} />
        {ghost.shape !== 'sustain' && (
          <>
            <span>
              P {fmt(ghost.phase)}{' '}
              <span className="opacity-60">
                ({ghost.elapsedBars}/{ghost.phaseLength})
              </span>
            </span>
            <span>T {fmt(ghost.targetEntropy)}</span>
          </>
        )}
        <span className="opacity-60">
          {ghost.bankOrderMode === 'sequence' ? 'seq' : 'ent'}
        </span>
      </div>
    </div>
  );
}

export function Datafeed() {
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [densitySamples, setDensitySamples] = useState<number[]>([]);
  const [ghost, setGhost] = useState<GhostState | null>(null);
  const idCounter = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Subscribe to the cross-window event bus.
  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void subscribeStreamEvents((batch) => {
      if (cancelled) return;
      const newRows: FeedRow[] = [];
      let latestState: Extract<StreamEvent, { kind: 'state' }> | null = null;
      for (const e of batch) {
        if (e.kind === 'state') {
          latestState = e;
          continue;
        }
        idCounter.current += 1;
        const row = streamEventToRow(e, idCounter.current, Date.now());
        if (row) newRows.push(row);
      }
      if (newRows.length > 0) {
        setRows((prev) => {
          const next = prev.slice(-MAX_ROWS + newRows.length);
          next.push(...newRows);
          return next;
        });
      }
      if (latestState) {
        const v = Math.max(0, Math.min(1, latestState.density));
        setDensitySamples((prev) => {
          const next = prev.length >= TRACE_SAMPLES ? prev.slice(1) : prev.slice();
          next.push(v);
          return next;
        });
        setGhost({
          shape: latestState.shape,
          phaseLength: latestState.phaseLength,
          phase: latestState.phase,
          targetEntropy: latestState.targetEntropy,
          ghostEnabled: latestState.ghostEnabled,
          bankOrderMode: latestState.bankOrderMode,
          elapsedBars: latestState.elapsedBars,
          minE: latestState.minE,
          maxE: latestState.maxE,
          activeBank: latestState.activeBank,
          pendingBank: latestState.pendingBank,
          bankSummary: latestState.bankSummary,
          activeBreakdown: latestState.activeBreakdown,
        });
      }
    }).then((u) => {
      if (cancelled) u();
      else unsub = u;
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  // Auto-scroll to bottom on new rows.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [rows]);

  const tracePoints =
    densitySamples.length > 1
      ? densitySamples
          .map((v, i) => {
            const x = (i / (TRACE_SAMPLES - 1)) * TRACE_WIDTH;
            const y = TRACE_HEIGHT - v * TRACE_HEIGHT;
            return `${x.toFixed(2)},${y.toFixed(2)}`;
          })
          .join(' ')
      : '';

  return (
    <div
      className="relative flex flex-col h-full overflow-hidden text-white"
      style={{
        // Solid backdrop on the left for legibility, fades fully transparent
        // on the right so the visualizer reads through the trailing edge.
        background:
          'linear-gradient(90deg, rgba(5,5,5,0.92) 0%, rgba(5,5,5,0.88) 55%, rgba(5,5,5,0.4) 85%, rgba(5,5,5,0) 100%)',
      }}
    >
      <div className="px-4 pt-4 pb-2 shrink-0">
        <div className="text-[9px] uppercase tracking-[0.35em] opacity-75 font-mono">
          stream · live
        </div>
        <div className="mt-1 text-[9px] tracking-widest opacity-50 font-mono tabular-nums">
          {fmtClock(Date.now())} · seq 0.3.2
        </div>
      </div>

      {/* Density line trace — 128 samples × 100ms = 12.8s window. */}
      <div className="px-4 pt-2 pb-3 shrink-0">
        <div className="text-[8px] uppercase tracking-[0.18em] opacity-50 font-mono leading-[1.35]">
          density
        </div>
        <svg width={TRACE_WIDTH} height={TRACE_HEIGHT} className="block">
          {tracePoints && (
            <polyline
              points={tracePoints}
              fill="none"
              stroke="white"
              strokeOpacity={0.75}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
      </div>

      <div className="px-4 shrink-0 opacity-30 font-mono text-[9px]">
        {'─'.repeat(28)}
      </div>

      <GhostSection ghost={ghost} />

      <div className="px-4 shrink-0 opacity-30 font-mono text-[9px]">
        {'─'.repeat(28)}
      </div>

      {/* Scrolling event log — full opacity throughout, no age fade. */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-hidden px-4 py-2 font-mono text-[10px] leading-[1.45] text-white"
      >
        {rows.map((r) => (
          <div key={r.id} className="tabular-nums whitespace-pre">
            <span className="opacity-60">{fmtClock(r.t)}</span> {r.text}
          </div>
        ))}
      </div>

      <div className="px-4 py-2 shrink-0 font-mono text-[9px] opacity-40 border-t border-white/5">
        evt · {rows.length.toString().padStart(3, '0')} / {MAX_ROWS}
      </div>
    </div>
  );
}
