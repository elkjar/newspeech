import { useEffect, useMemo, useState } from 'react';
import {
  useSequencerStore,
  type BankSlot,
  type SceneShape,
  type GhostPickLogEntry,
  SCENE_SHAPES,
} from '../state/store';
import { computeBankEntropy, type EntropyResult } from '../ghost/entropy';
import { targetEntropy, phaseAt, sampleShape } from '../ghost/shape';

const CELL_WIDTH = 7;
const CELL_GAP = 2;
// Matches the shape select-box height (text-[9px] + py-[1px] + border) so
// they sit side-by-side cleanly.
const HISTOGRAM_HEIGHT = 18;
// Empty space below the bars inside the histogram container — bars
// anchored to the absolute bottom feel bottom-heavy next to the
// vertically-centered select-box text. Lifts the bars up a few pixels.
const BAR_BOTTOM_PADDING = 3;
const BAR_MAX_HEIGHT = HISTOGRAM_HEIGHT - BAR_BOTTOM_PADDING;
const HISTOGRAM_WIDTH = 16 * CELL_WIDTH + 15 * CELL_GAP;
const STEPS_PER_BAR = 32;

function HistogramCell({
  slot,
  entropy,
  isActive,
  isPending,
}: {
  slot: BankSlot | null;
  entropy: number;
  isActive: boolean;
  isPending: boolean;
}) {
  const filled = slot !== null;
  const isTransition = slot?.kind === 'transition';
  const barHeight = filled ? Math.max(1, Math.round(entropy * BAR_MAX_HEIGHT)) : 0;
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
      style={{ width: CELL_WIDTH, height: HISTOGRAM_HEIGHT }}
      className="relative flex items-end"
    >
      <div
        style={{
          width: '100%',
          height: filled ? barHeight : 1,
          marginBottom: BAR_BOTTOM_PADDING,
          background: bg,
        }}
      />
    </div>
  );
}

// Tiny SVG curve preview rendered next to the shape dropdown. Renders the
// chosen shape across normalized 0..1 so the preview reads "what's the
// pattern" rather than "where am I in it."
function ShapePreview({ shape }: { shape: SceneShape }) {
  const W = 28;
  const H = 10;
  const samples = sampleShape(shape, 0, 1, 24);
  const points = samples
    .map((v, i) => {
      const x = (i / (samples.length - 1)) * (W - 2) + 1;
      const y = H - 1 - v * (H - 2);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');
  return (
    <svg width={W} height={H} className="opacity-60">
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

function fmt(n: number): string {
  return n.toFixed(2);
}

// Compact format dropping the leading 0 (".42" instead of "0.42") — used
// in tight columns like the range readout where every char counts.
function fmtNoZero(n: number): string {
  const s = n.toFixed(2);
  return s.startsWith('0.') ? s.slice(1) : s;
}

function padPct(n: number): string {
  return Math.round(n * 100).toString().padStart(2, '0');
}

export function GhostDebug() {
  const banks = useSequencerStore((s) => s.banks);
  const activeBank = useSequencerStore((s) => s.activeBank);
  const pendingBank = useSequencerStore((s) => s.pendingBank);
  const globalStep = useSequencerStore((s) => s.globalStep);
  const compositionStartStep = useSequencerStore((s) => s.ghostCompositionStartStep);
  const shape = useSequencerStore((s) => s.sceneGraph.shape);
  const phaseLength = useSequencerStore((s) => s.sceneGraph.phaseLength);
  const ghostEnabled = useSequencerStore((s) => s.sceneGraph.enabled);
  const setSceneGraphShape = useSequencerStore((s) => s.setSceneGraphShape);
  const pickLog = useSequencerStore((s) => s.ghostPickLog);

  // Recompute live so the visualizer reflects in-flight authoring (snap
  // hasn't fired yet). The cached `entropy` field on the slot only updates
  // on snap/generate; this read gives the *current* state of each slot.
  const results = useMemo(() => {
    return banks.map((slot) => (slot ? computeBankEntropy(slot) : null));
  }, [banks]);

  const populated = results.filter((r): r is EntropyResult => r !== null);
  const minE = populated.length > 0 ? Math.min(...populated.map((r) => r.total)) : 0;
  const maxE = populated.length > 0 ? Math.max(...populated.map((r) => r.total)) : 0;
  const active = activeBank !== null ? results[activeBank] : null;

  // Phase + target. Phase is 0 when sustain (picker doesn't use it);
  // for the curve display we still want target at the palette midpoint so
  // the indicator isn't pinned to one end.
  const phase = phaseAt(globalStep, compositionStartStep, phaseLength, shape);
  const target = targetEntropy(shape, phase, minE, maxE);
  const elapsedBars = Math.max(
    0,
    Math.floor((globalStep - compositionStartStep) / STEPS_PER_BAR)
  );

  // Target-line y position in the histogram. Matches the bar baseline:
  // entropy 0 sits at the bar-bottom (HISTOGRAM_HEIGHT - BAR_BOTTOM_PADDING),
  // entropy 1 sits at the very top.
  const targetY = HISTOGRAM_HEIGHT - BAR_BOTTOM_PADDING - target * BAR_MAX_HEIGHT;

  return (
    <div className="flex flex-row gap-5 items-start select-none">
      <div className="flex flex-col items-start gap-1">
        <span className="text-[8px] uppercase tracking-[0.18em] opacity-40 leading-[1.35]">
          ghost · entropy
        </span>
        <div className="flex flex-row items-center gap-2">
          <select
            value={shape}
            onChange={(e) => setSceneGraphShape(e.target.value as SceneShape)}
            className="bg-transparent border border-white/15 px-1 text-[9px] uppercase tracking-[0.12em] text-white focus:outline-none focus:border-white/50 box-border"
            style={{ fontFamily: 'inherit', height: HISTOGRAM_HEIGHT }}
            title="ghost scene shape"
          >
            {SCENE_SHAPES.map((s) => (
              <option key={s} value={s} style={{ background: '#0a0a0a' }}>
                {s}
              </option>
            ))}
          </select>
          <div
            className="relative flex items-end"
            style={{ gap: CELL_GAP, height: HISTOGRAM_HEIGHT, width: HISTOGRAM_WIDTH }}
          >
            {banks.map((slot, i) => (
              <HistogramCell
                key={i}
                slot={slot}
                entropy={results[i]?.total ?? 0}
                isActive={i === activeBank}
                isPending={i === pendingBank}
              />
            ))}
            {populated.length > 0 && (
              <div
                className="absolute pointer-events-none"
                style={{
                  left: 0,
                  right: 0,
                  top: targetY - 0.5,
                  height: 1,
                  background: ghostEnabled ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.18)',
                }}
              />
            )}
          </div>
        </div>
        <div
          className="flex items-center gap-2 text-[9px] uppercase tracking-[0.12em] opacity-55 tabular-nums"
          style={{ minHeight: 12 }}
        >
          {active ? (
            <>
              <span className="opacity-100">{fmt(active.total)}</span>
              <span>α{padPct(active.channels)}</span>
              <span>β{padPct(active.voiceType)}</span>
              <span>γ{padPct(active.stepDensity)}</span>
              <span>δ{padPct(active.mutation)}</span>
              <span>ζ{padPct(active.polyphony)}</span>
              <span className="opacity-70">
                {fmtNoZero(minE)}→{fmtNoZero(maxE)}
              </span>
            </>
          ) : (
            <span className="opacity-40">no active bank</span>
          )}
        </div>
        {shape !== 'sustain' && (
          <div className="flex items-center gap-2 text-[9px] uppercase tracking-[0.12em] opacity-55 tabular-nums">
            <ShapePreview shape={shape} />
            <span>
              P {fmt(phase)}{' '}
              <span className="opacity-60">
                ({elapsedBars}/{phaseLength})
              </span>
            </span>
            <span>T {fmt(target)}</span>
          </div>
        )}
      </div>
      <div className="flex flex-row items-start gap-3">
        <PickLog log={pickLog} />
        <DensityTrace />
      </div>
    </div>
  );
}

// Density trace — sparkline of store.density sampled every
// DENSITY_SAMPLE_MS, ring-buffered to TRACE_SAMPLES values. Sits to the
// right of the pick log so vertical footprint stays small. Faint dashed
// anchor at active bank's saved density so fill spikes read against
// intent. Height matches the visual span of PickLog's 5 lines.
const DENSITY_SAMPLE_MS = 100;
const TRACE_SAMPLES = 128;
const TRACE_WIDTH = 77;
const TRACE_HEIGHT = 58;

function DensityTrace() {
  const [samples, setSamples] = useState<number[]>([]);
  const activeBank = useSequencerStore((s) => s.activeBank);
  const banks = useSequencerStore((s) => s.banks);
  const bankAnchor =
    activeBank !== null ? banks[activeBank]?.macros.density ?? 0.5 : 0.5;

  useEffect(() => {
    const id = window.setInterval(() => {
      const density = useSequencerStore.getState().density;
      setSamples((prev) => {
        const next = prev.length >= TRACE_SAMPLES ? prev.slice(1) : prev.slice();
        next.push(density);
        return next;
      });
    }, DENSITY_SAMPLE_MS);
    return () => window.clearInterval(id);
  }, []);

  const W = TRACE_WIDTH;
  const H = TRACE_HEIGHT;
  const anchorY = H - bankAnchor * H;
  const points =
    samples.length > 1
      ? samples
          .map((v, i) => {
            const x = (i / (TRACE_SAMPLES - 1)) * W;
            const y = H - Math.max(0, Math.min(1, v)) * H;
            return `${x.toFixed(2)},${y.toFixed(2)}`;
          })
          .join(' ')
      : '';

  return (
    <div className="flex flex-col items-stretch" style={{ width: W }}>
      <span className="text-[8px] uppercase tracking-[0.18em] opacity-40 leading-[1.35]">
        density
      </span>
      <svg width={W} height={H} className="block">
        <line
          x1={0}
          y1={anchorY}
          x2={W}
          y2={anchorY}
          stroke="white"
          strokeOpacity={0.22}
          strokeDasharray="2 3"
          strokeWidth={1}
        />
        {points && (
          <polyline
            points={points}
            fill="none"
            stroke="white"
            strokeOpacity={0.75}
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
    </div>
  );
}

// Datafeed log — last N picks rendered terminal-style. Newest at the
// bottom; older entries dim. Padded to a fixed line count so the layout
// doesn't jump as picks fire.
const LOG_VISIBLE_LINES = 6;

function PickLog({ log }: { log: GhostPickLogEntry[] }) {
  const visible = log.slice(-LOG_VISIBLE_LINES);
  const padded: (GhostPickLogEntry | null)[] = [
    ...Array.from({ length: LOG_VISIBLE_LINES - visible.length }, () => null),
    ...visible,
  ];
  return (
    <div
      className="flex flex-col items-stretch self-stretch"
      style={{ width: HISTOGRAM_WIDTH, marginTop: 2 }}
    >
      <span className="text-[8px] uppercase tracking-[0.18em] opacity-40 leading-[1.35]">
        event log
      </span>
      <div className="flex flex-col text-[8px] tracking-[0.08em] tabular-nums leading-[1.35]">
      {padded.map((e, i) => {
        if (!e) {
          return (
            <span key={i} className="opacity-0" aria-hidden>
              &nbsp;
            </span>
          );
        }
        // Fade older entries — newest at the bottom is full opacity.
        const ageFromBottom = LOG_VISIBLE_LINES - 1 - i;
        const opacity = Math.max(0.25, 1 - ageFromBottom * 0.18);
        if (e.kind === 'step') {
          const trackStr = e.track.toString().padStart(2, '0');
          const stepStr = e.step.toString().padStart(2, '0');
          return (
            <span
              key={i}
              className="uppercase whitespace-nowrap"
              style={{ opacity }}
            >
              → step{' '}
              <span className="opacity-90">
                {trackStr}·{stepStr}
              </span>{' '}
              <span className="opacity-70">{fmtNoZero(e.value)}</span>
            </span>
          );
        }
        if (e.kind === 'system') {
          const a = e.nonce.slice(0, 4);
          const b = e.nonce.slice(4, 8);
          const c = e.nonce.slice(8, 12);
          return (
            <span
              key={i}
              className="uppercase whitespace-nowrap"
              style={{ opacity }}
            >
              → {e.label}{' '}
              <span className="opacity-70">{a}</span>{' '}
              <span className="opacity-90">{b}</span>{' '}
              <span className="opacity-70">{c}</span>
            </span>
          );
        }
        if (e.kind === 'shape') {
          return (
            <span
              key={i}
              className="uppercase whitespace-nowrap"
              style={{ opacity }}
            >
              → shape{' '}
              <span className="opacity-70">{e.from.slice(0, 3)}</span>{' '}
              <span className="opacity-50">→</span>{' '}
              <span className="opacity-100">{e.to.slice(0, 3)}</span>
            </span>
          );
        }
        if (e.kind === 'ghost') {
          return (
            <span
              key={i}
              className="uppercase whitespace-nowrap"
              style={{ opacity }}
            >
              → ghost{' '}
              <span className={e.enabled ? 'opacity-100' : 'opacity-50'}>
                {e.enabled ? 'on' : 'off'}
              </span>
            </span>
          );
        }
        if (e.kind === 'transport') {
          return (
            <span
              key={i}
              className="uppercase whitespace-nowrap"
              style={{ opacity }}
            >
              <span className={e.playing ? 'opacity-100' : 'opacity-60'}>
                → {e.playing ? 'system initiate' : 'process [ns] halt'}
              </span>
            </span>
          );
        }
        // Past the meta-event branches: `e` is narrowed to auto | manual,
        // both of which carry slot + optional dwellBars.
        const slotStr = e.slot.toString().padStart(2, '0');
        const dwellSuffix =
          e.dwellBars !== undefined ? (
            <>
              {' '}
              <span className="opacity-60">[{e.dwellBars}b]</span>
            </>
          ) : null;
        if (e.kind === 'manual') {
          const a = e.nonce.slice(0, 4);
          const b = e.nonce.slice(4, 8);
          const c = e.nonce.slice(8, 12);
          return (
            <span
              key={i}
              className="uppercase whitespace-nowrap"
              style={{ opacity }}
            >
              → {slotStr}{' '}
              <span className="opacity-70">{a}</span>{' '}
              <span className="opacity-90">{b}</span>{' '}
              <span className="opacity-70">{c}</span>
              {dwellSuffix}
            </span>
          );
        }
        return (
          <span
            key={i}
            className="uppercase whitespace-nowrap"
            style={{ opacity }}
          >
            → {slotStr}{' '}
            <span className="opacity-70">
              {e.shape === 'sustain'
                ? 'sus'
                : e.shape.slice(0, 3)}
            </span>{' '}
            <span className="opacity-90">t {fmt(e.target)}</span>{' '}
            <span className="opacity-70">Δ{fmt(e.deltaFromTarget)}</span>{' '}
            <span className="opacity-50">·{e.candidateCount}</span>
            {dwellSuffix}
          </span>
        );
      })}
      </div>
    </div>
  );
}
