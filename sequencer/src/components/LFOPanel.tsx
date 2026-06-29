import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSequencerStore } from '../state/store';
import { getAudioContext } from '../audio/audioContext';
import { Knob } from './Knob';
import { sourceLabel, type TrackSource } from '../instruments/library';
import {
  GLOBAL_TRACK_ID,
  lfoShapeValue,
  LFO_SHAPES,
  type LFO,
  type LFODestKnob,
  type LFOShape,
} from '../audio/lfo';

const KNOB_LABELS: Record<LFODestKnob, string> = {
  mutation: 'mut',
  rowRatchet: 'ratchet',
  fxSend: 'fx send',
  pan: 'pan',
  gain: 'gain',
  filterCutoff: 'cutoff',
  filterResonance: 'res',
  density: 'density',
  motion: 'motion',
  drift: 'drift',
  chaos: 'chaos',
  tension: 'tension',
  voicing: 'voicing',
  tapePosition: 'tape pos',
  tapeLength: 'tape len',
  tapeMix: 'tape mix',
  tapeGrainRate: 'grain rate',
  tapeGrainMix: 'grain mix',
  glitchChance: 'glitch ch',
  glitchMix: 'glitch mix',
  reverbSize: 'verb size',
  reverbMix: 'verb mix',
  reverbDiffusion: 'verb diff',
  reverbDamping: 'verb damp',
  preSaturationDrive: 'pre drive',
  masterInput: 'm input',
  masterComp: 'm comp',
  masterDrive: 'm drive',
  masterBias: 'm bias',
  masterMix: 'm mix',
  masterHiCut: 'm hi-cut',
  masterTrim: 'm trim',
  masterGateThreshold: 'm gate',
  grainLength: 'grain len',
  grainPosition: 'grain pos',
  reverbSend: 'rev send',
  delaySend: 'delay send',
  tune: 'tune',
  finetune: 'finetune',
};

const SHAPE_SHORT: Record<LFOShape, string> = {
  sine: 'sin',
  triangle: 'tri',
  saw: 'saw',
  square: 'sqr',
};

function destinationLabel(
  lfo: LFO,
  sourceFor: (trackId: string) => TrackSource | undefined
): string {
  if (lfo.destinations.length === 0) return '—';
  const first = lfo.destinations[0];
  const head =
    first.trackId === GLOBAL_TRACK_ID
      ? KNOB_LABELS[first.knob]
      : (() => {
          const src = sourceFor(first.trackId);
          return src
            ? `${sourceLabel(src)} · ${KNOB_LABELS[first.knob]}`
            : KNOB_LABELS[first.knob];
        })();
  return lfo.destinations.length > 1
    ? `${head} +${lfo.destinations.length - 1}`
    : head;
}

// Human period readout (one cycle), e.g. "12s".
function periodLabel(rate: number): string {
  if (rate <= 0) return '—';
  const s = 1 / rate;
  return s >= 10 ? `${Math.round(s)}s` : `${s.toFixed(1)}s`;
}

// A framed waveform plot of one LFO's shape — the cell's centerpiece. Shape is
// always legible (drawn at a depth-scaled-but-floored amplitude); gridlines +
// centerline frame it like Reliq's LFO plot; a dot rides the curve at phase.
function WaveformPlot({ lfo }: { lfo: LFO }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const lfoRef = useRef(lfo);
  lfoRef.current = lfo;

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let raf = 0;
    let cssW = 0;
    let cssH = 0;
    const resize = () => {
      const dpr = window.devicePixelRatio || 1;
      cssW = container.clientWidth;
      cssH = container.clientHeight;
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);

    const draw = () => {
      const { rate, depth, shape } = lfoRef.current;
      const W = cssW;
      const H = cssH;
      ctx.clearRect(0, 0, W, H);
      if (W > 0 && H > 0) {
        // gridlines at 0/25/50/75/100%
        ctx.lineWidth = 1;
        for (const f of [0, 0.25, 0.5, 0.75, 1]) {
          const y = Math.round(f * (H - 1)) + 0.5;
          ctx.strokeStyle = f === 0.5 ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)';
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(W, y);
          ctx.stroke();
        }

        const mid = H / 2;
        // Shape stays readable regardless of depth (floor at 35%), grows to fill.
        const amp = (H / 2 - 3) * (0.35 + 0.65 * depth);
        const yAt = (p: number) => mid - lfoShapeValue(shape, p) * amp;

        // the shape — one full cycle across the width, bold
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let px = 0; px <= W; px++) {
          const y = yAt(px / W);
          if (px === 0) ctx.moveTo(px, y);
          else ctx.lineTo(px, y);
        }
        ctx.stroke();

        // phase dot
        const t = getAudioContext().currentTime;
        const cycles = rate * t;
        const p = cycles - Math.floor(cycles);
        ctx.fillStyle = 'rgba(255,255,255,1)';
        ctx.beginPath();
        ctx.arc(p * W, yAt(p), 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  // Fill the (relative) plot cell via absolute inset-0 + clip, so canvas size
  // never depends on percentage-height resolution and can never feed back into
  // the flex layout (the classic ResizeObserver→grow loop).
  return (
    <div ref={containerRef} className="absolute inset-0 overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 block" />
    </div>
  );
}

function LFOCell({
  lfo,
  selected,
  onSelect,
  onDepth,
  onCycleShape,
  destLabel,
}: {
  lfo: LFO;
  selected: boolean;
  onSelect: () => void;
  onDepth: (v: number) => void;
  onCycleShape: () => void;
  destLabel: string;
}) {
  return (
    <div
      onClick={onSelect}
      className={[
        'flex flex-col flex-1 min-w-0 h-full overflow-hidden cursor-pointer transition-colors',
        selected
          ? 'bg-white/10 border border-white/40'
          : 'border border-white/10 hover:border-white/30',
      ].join(' ')}
    >
      <div className="flex items-baseline justify-between px-2 pt-1">
        <span className="text-[11px] tracking-widest text-white">L{lfo.id + 1}</span>
        <span className="text-[9px] tracking-widest text-white/40 tabular-nums">
          {periodLabel(lfo.rate)}
        </span>
      </div>
      <div className="relative flex-1 min-h-0 mx-2 my-1">
        <WaveformPlot lfo={lfo} />
      </div>
      <div className="flex flex-col items-center gap-1 px-2 pb-2">
        <div className="flex items-center gap-2">
          <div onClick={(e) => e.stopPropagation()}>
            <Knob
              value={lfo.depth}
              onChange={onDepth}
              size={28}
              title={`L${lfo.id + 1} depth ${Math.round(lfo.depth * 100)}%`}
            />
          </div>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCycleShape();
            }}
            title={`shape — ${lfo.shape} (click to cycle)`}
            className="border border-white/20 hover:border-white/60 text-[9px] uppercase tracking-widest text-white/70 px-1.5 py-1 transition-colors w-[34px] text-center"
          >
            {SHAPE_SHORT[lfo.shape]}
          </button>
        </div>
        <span className="text-[9px] uppercase tracking-widest text-white/55 truncate max-w-full text-center">
          {destLabel}
        </span>
      </div>
    </div>
  );
}

export function LFOPanel() {
  const lfos = useSequencerStore((s) => s.lfos);
  // Subscribe to a shallow-compared id→source map instead of the whole
  // tracks array. Source rarely changes (only on voice/instrument re-assign),
  // so any step toggle / knob twist / mutation roll keeps the record's
  // shallow identity and skips the panel's reconcile.
  const trackSources = useSequencerStore(
    useShallow((s) => {
      const out: Record<string, TrackSource> = {};
      for (const t of s.tracks) out[t.id] = t.source;
      return out;
    }),
  );
  const selectingLFO = useSequencerStore((s) => s.selectingLFO);
  const setSelectingLFO = useSequencerStore((s) => s.setSelectingLFO);
  const setLFODepth = useSequencerStore((s) => s.setLFODepth);
  const setLFOShape = useSequencerStore((s) => s.setLFOShape);

  const sourceFor = (trackId: string): TrackSource | undefined => trackSources[trackId];

  useEffect(() => {
    if (selectingLFO === null) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectingLFO(null);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [selectingLFO, setSelectingLFO]);

  return (
    <div className="flex flex-row h-full gap-1">
      {lfos.map((lfo) => (
        <LFOCell
          key={lfo.id}
          lfo={lfo}
          selected={selectingLFO === lfo.id}
          onSelect={() => setSelectingLFO(selectingLFO === lfo.id ? null : lfo.id)}
          onDepth={(v) => setLFODepth(lfo.id, v)}
          onCycleShape={() => {
            const i = LFO_SHAPES.indexOf(lfo.shape);
            setLFOShape(lfo.id, LFO_SHAPES[(i + 1) % LFO_SHAPES.length]);
          }}
          destLabel={destinationLabel(lfo, sourceFor)}
        />
      ))}
    </div>
  );
}
