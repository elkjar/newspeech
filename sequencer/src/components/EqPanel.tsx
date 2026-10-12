import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { setStripAnalyser } from '../audio/nativeEngine';
import { useSequencerStore } from '../state/store';
import { Knob } from './Knob';
import { sourceLabel } from '../instruments/library';
import {
  EQ_FREQ_MAX,
  EQ_FREQ_MIN,
  EQ_GAIN_MAX,
  EQ_PARAMETRIC_TYPES,
  EQ_Q_MAX,
  EQ_Q_MIN,
  bandLabel,
  bandResponseDb,
  defaultChannelStrip,
  freqLabel,
  freqToNorm,
  normToFreq,
  normToQ,
  qToNorm,
  type ChannelStrip,
  type EqBand,
} from '../audio/channelStrip';

// Channel-strip EQ for the FOCUSED track (P1). The curve is drawn in JS from
// the same SVF math the engine runs — no audio data needed. Monochrome per
// the sequencer UI rule: white curve, outlined nodes, filled when selected.
//
// Behind the curve: the track's live spectrum, post-strip (filled) with a
// faint pre-strip line, from the engine's bus analyser (`audio:strip-spectrum`).
// Spectrum scale is its own: SPEC_FLOOR..0 dBFS over the full height, tilted
// +4.5 dB/oct around 1 kHz so a mix reads roughly flat.
//
// Curve gestures: drag a node (freq / gain), scroll over the curve (Q of the
// selected band), double-click empty space to switch on the nearest free
// parametric band there, double-click a node to switch it off.

const SR = 48000;
const DB_RANGE = 24; // curve shows ±24 dB
const CURVE_H = 168;
const NODE_R = 6;
const GRID_HZ = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const GRID_DB = [-18, -12, -6, 6, 12, 18];
const FLAT = defaultChannelStrip();
const SPEC_BINS = 96;
const SPEC_FLOOR = -84;
const SPEC_TILT = 4.5;
const binFreq = (b: number) => 20 * Math.pow(1000, (b + 0.5) / SPEC_BINS);

interface StripSpectrum {
  pre: number[];
  post: number[];
}

const xOfFreq = (hz: number, w: number) => freqToNorm(hz) * w;
const freqOfX = (x: number, w: number) => normToFreq(x / w);
const yOfDb = (db: number) => CURVE_H / 2 - (db / DB_RANGE) * (CURVE_H / 2);
const dbOfY = (y: number) => ((CURVE_H / 2 - y) / (CURVE_H / 2)) * DB_RANGE;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const hasGain = (b: EqBand) => b.type === 'bell' || b.type === 'lowshelf' || b.type === 'highshelf';

// The focused track, else the first track playing a Sequence voice (the
// strip only shapes Sequence's own audio — MIDI/hardware tracks have none).
function useFocusedTrack(): { id: string; label: string; hasAudio: boolean } | null {
  const focusedId = useSequencerStore((s) => s.focusedTrackId);
  const tracks = useSequencerStore((s) => s.tracks);
  return useMemo(() => {
    const t =
      (focusedId && tracks.find((t) => t.id === focusedId)) ||
      tracks.find((t) => t.source.kind === 'voice') ||
      tracks[0];
    if (!t) return null;
    const idx = tracks.findIndex((x) => x.id === t.id);
    const name = t.source.kind === 'empty' ? 'empty' : sourceLabel(t.source);
    return { id: t.id, label: `${idx + 1} · ${name}`, hasAudio: t.source.kind === 'voice' };
  }, [focusedId, tracks]);
}

export function EqPanel() {
  const track = useFocusedTrack();
  const strip: ChannelStrip = useSequencerStore(
    (s) => (track ? s.channelStrips[track.id] : undefined) ?? FLAT,
  );
  const setEqBand = useSequencerStore((s) => s.setEqBand);
  const setStripBypass = useSequencerStore((s) => s.setStripBypass);
  const [selected, setSelected] = useState(3);
  const bands = strip.eq.bands;

  const set = useCallback(
    (i: number, patch: Partial<EqBand>) => {
      if (track) setEqBand(track.id, i, patch);
    },
    [setEqBand, track],
  );

  if (!track) {
    return <div className="h-full flex items-center justify-center text-white/40 text-xs">no track</div>;
  }

  return (
    <div className="h-full flex flex-col gap-2 p-3 select-none">
      <div className="flex items-baseline gap-3 text-[10px] uppercase tracking-widest">
        <button
          type="button"
          onClick={() => setStripBypass(track.id, !strip.bypass)}
          aria-pressed={strip.bypass}
          title="bypass this track's channel strip (settings are kept)"
          className={[
            'px-2 py-0.5 border transition-colors',
            strip.bypass
              ? 'bg-white text-ink border-white'
              : 'border-white/15 text-white/60 hover:text-white hover:border-white',
          ].join(' ')}
        >
          bypass
        </button>
        <span className="text-white/40">eq</span>
        <span className="text-white/80 normal-case tracking-normal text-[12px]">{track.label}</span>
        {!track.hasAudio && (
          <span className="text-white/40 normal-case tracking-normal text-[11px]">
            no sequence audio on this track — the eq shapes sequence voices only
          </span>
        )}
      </div>
      <div className="flex gap-4 min-h-0">
        <EqCurve
          trackId={track.id}
          bands={bands}
          bypassed={strip.bypass}
          selected={selected}
          onSelect={setSelected}
          onSet={set}
        />
        <BandControls band={bands[selected]} index={selected} onSet={set} />
      </div>
      <div className="flex gap-1.5">
        {bands.map((b, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setSelected(i)}
            onDoubleClick={() => set(i, { on: !b.on })}
            title={`${bandLabel(i)} — click to select, double-click to switch ${b.on ? 'off' : 'on'}`}
            className={[
              'px-2 py-0.5 text-[10px] uppercase tracking-widest border transition-colors',
              i === selected ? 'border-white text-white' : 'border-white/15 text-white/50 hover:text-white',
            ].join(' ')}
          >
            {b.on ? '●' : '○'} {bandLabel(i)}
          </button>
        ))}
      </div>
    </div>
  );
}

function EqCurve({
  trackId,
  bands,
  bypassed,
  selected,
  onSelect,
  onSet,
}: {
  trackId: string;
  bands: EqBand[];
  bypassed: boolean;
  selected: number;
  onSelect: (i: number) => void;
  onSet: (i: number, patch: Partial<EqBand>) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  const dragRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wRef = useRef(w);
  wRef.current = w;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(Math.max(200, el.clientWidth)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Analyser follows the focused track while this panel is mounted.
  useEffect(() => {
    if (!isTauri()) return;
    void setStripAnalyser(trackId);
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void listen<StripSpectrum>('audio:strip-spectrum', (e) => drawSpectrum(e.payload)).then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
      void setStripAnalyser(null);
    };
  }, [trackId]);

  const drawSpectrum = (spec: StripSpectrum) => {
    const c = canvasRef.current;
    if (!c) return;
    const cw = wRef.current;
    const dpr = window.devicePixelRatio || 1;
    if (c.width !== Math.round(cw * dpr)) {
      c.width = Math.round(cw * dpr);
      c.height = Math.round(CURVE_H * dpr);
    }
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, CURVE_H);
    const yOf = (db: number, b: number) => {
      const tilted = db + SPEC_TILT * Math.log2(binFreq(b) / 1000);
      return CURVE_H * (1 - clamp((tilted - SPEC_FLOOR) / -SPEC_FLOOR, 0, 1));
    };
    const trace = (vals: number[]) => {
      ctx.beginPath();
      vals.forEach((db, b) => {
        const x = xOfFreq(binFreq(b), cw);
        if (b === 0) ctx.moveTo(x, yOf(db, b));
        else ctx.lineTo(x, yOf(db, b));
      });
    };
    // Post-strip: soft fill.
    trace(spec.post);
    ctx.lineTo(cw, CURVE_H);
    ctx.lineTo(0, CURVE_H);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.fill();
    trace(spec.post);
    ctx.strokeStyle = 'rgba(255,255,255,0.28)';
    ctx.lineWidth = 1;
    ctx.stroke();
    // Pre-strip: faint dashed line, so the EQ's effect reads as the gap.
    trace(spec.pre);
    ctx.setLineDash([2, 3]);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.stroke();
    ctx.setLineDash([]);
  };

  // Summed response, one point per 2 px.
  const path = useMemo(() => {
    const on = bands.filter((b) => b.on);
    const pts: string[] = [];
    for (let x = 0; x <= w; x += 2) {
      const f = freqOfX(x, w);
      let db = 0;
      for (const b of on) db += bandResponseDb(b, f, SR);
      pts.push(`${x === 0 ? 'M' : 'L'}${x},${yOfDb(clamp(db, -DB_RANGE - 6, DB_RANGE + 6)).toFixed(1)}`);
    }
    return pts.join('');
  }, [bands, w]);

  const nodeY = (b: EqBand) => yOfDb(hasGain(b) ? b.gainDb : 0);

  const local = (e: { clientX: number; clientY: number }) => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: clamp(e.clientX - r.left, 0, w), y: clamp(e.clientY - r.top, 0, CURVE_H) };
  };

  const dragTo = (i: number, x: number, y: number) => {
    const b = bands[i];
    const patch: Partial<EqBand> = { freq: Math.round(clamp(freqOfX(x, w), EQ_FREQ_MIN, EQ_FREQ_MAX)) };
    if (hasGain(b)) patch.gainDb = Math.round(clamp(dbOfY(y), -EQ_GAIN_MAX, EQ_GAIN_MAX) * 10) / 10;
    onSet(i, patch);
  };

  const onNodeDown = (i: number) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    dragRef.current = i;
    onSelect(i);
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragRef.current === null) return;
    const { x, y } = local(e);
    dragTo(dragRef.current, x, y);
  };
  const onUp = () => {
    dragRef.current = null;
  };

  const onWheel = (e: React.WheelEvent) => {
    const b = bands[selected];
    if (!b.on) return;
    const q = clamp(b.q * Math.pow(1.0015, -e.deltaY), EQ_Q_MIN, EQ_Q_MAX);
    onSet(selected, { q: Math.round(q * 100) / 100 });
  };

  // Double-click empty curve: switch on the free parametric band nearest in
  // frequency (all on → the nearest one moves here).
  const onDoubleClickEmpty = (e: React.MouseEvent) => {
    const { x, y } = local(e);
    const f = freqOfX(x, w);
    const candidates = [2, 3, 4, 5].filter((i) => !bands[i].on);
    const pool = candidates.length ? candidates : [2, 3, 4, 5];
    const i = pool.reduce((best, j) =>
      Math.abs(Math.log(bands[j].freq / f)) < Math.abs(Math.log(bands[best].freq / f)) ? j : best,
    );
    const patch: Partial<EqBand> = { on: true, freq: Math.round(f) };
    if (hasGain(bands[i])) patch.gainDb = Math.round(clamp(dbOfY(y), -EQ_GAIN_MAX, EQ_GAIN_MAX) * 10) / 10;
    onSet(i, patch);
    onSelect(i);
  };

  return (
    <div
      ref={wrapRef}
      className="relative flex-1 min-w-0 border border-white/10"
      style={{ height: CURVE_H }}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onWheel={onWheel}
      onDoubleClick={onDoubleClickEmpty}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 pointer-events-none"
        style={{ width: w, height: CURVE_H }}
      />
      <svg width={w} height={CURVE_H} className="block relative">
        {GRID_HZ.map((hz) => (
          <g key={hz}>
            <line x1={xOfFreq(hz, w)} x2={xOfFreq(hz, w)} y1={0} y2={CURVE_H} stroke="white" strokeOpacity={0.06} />
            <text x={xOfFreq(hz, w) + 3} y={CURVE_H - 4} fontSize={9} fill="white" fillOpacity={0.3}>
              {freqLabel(hz)}
            </text>
          </g>
        ))}
        {GRID_DB.map((db) => (
          <line key={db} x1={0} x2={w} y1={yOfDb(db)} y2={yOfDb(db)} stroke="white" strokeOpacity={0.06} />
        ))}
        <line x1={0} x2={w} y1={yOfDb(0)} y2={yOfDb(0)} stroke="white" strokeOpacity={0.2} />
        <path d={path} fill="none" stroke="white" strokeWidth={1.5} strokeOpacity={bypassed ? 0.3 : 1} />
        {bands.map((b, i) =>
          b.on ? (
            <g key={i} onPointerDown={onNodeDown(i)} onDoubleClick={(e) => { e.stopPropagation(); onSet(i, { on: false }); }} style={{ cursor: 'grab' }}>
              <circle
                cx={xOfFreq(b.freq, w)}
                cy={nodeY(b)}
                r={NODE_R}
                fill={i === selected ? 'white' : '#050505'}
                stroke="white"
                strokeWidth={1.5}
              />
              <text
                x={xOfFreq(b.freq, w)}
                y={nodeY(b) - NODE_R - 3}
                fontSize={9}
                textAnchor="middle"
                fill="white"
                fillOpacity={0.7}
              >
                {bandLabel(i)}
              </text>
            </g>
          ) : null,
        )}
      </svg>
    </div>
  );
}

function BandControls({
  band,
  index,
  onSet,
}: {
  band: EqBand;
  index: number;
  onSet: (i: number, patch: Partial<EqBand>) => void;
}) {
  const parametric = index >= 2;
  const cycleType = () => {
    const i = EQ_PARAMETRIC_TYPES.indexOf(band.type);
    onSet(index, { type: EQ_PARAMETRIC_TYPES[(i + 1) % EQ_PARAMETRIC_TYPES.length] });
  };
  return (
    <div className="flex flex-col gap-2 shrink-0" style={{ width: 236 }}>
      <div className="flex items-center gap-3 text-[10px] uppercase tracking-widest">
        <button
          type="button"
          onClick={() => onSet(index, { on: !band.on })}
          className="text-white/70 hover:text-white"
          title="band on/off"
        >
          {band.on ? '●' : '○'} {bandLabel(index)}
        </button>
        {parametric ? (
          <button
            type="button"
            onClick={cycleType}
            className="px-2 py-0.5 border border-white/15 hover:border-white text-white/70 hover:text-white"
            title="band type (click to cycle)"
          >
            {band.type}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => onSet(index, { slope: band.slope === 24 ? 12 : 24 })}
            className="px-2 py-0.5 border border-white/15 hover:border-white text-white/70 hover:text-white"
            title="slope (click to toggle)"
          >
            {band.slope} db/oct
          </button>
        )}
      </div>
      <div className="flex gap-3">
        <LabeledValueKnob
          label="freq"
          value={freqToNorm(band.freq)}
          text={`${freqLabel(band.freq)} hz`}
          onChange={(v) => onSet(index, { freq: Math.round(normToFreq(v)) })}
        />
        {hasGain(band) && (
          <LabeledValueKnob
            label="gain"
            value={(band.gainDb + EQ_GAIN_MAX) / (2 * EQ_GAIN_MAX)}
            bipolar
            text={`${band.gainDb > 0 ? '+' : ''}${band.gainDb.toFixed(1)} db`}
            onChange={(v) => onSet(index, { gainDb: Math.round((v * 2 - 1) * EQ_GAIN_MAX * 10) / 10 })}
          />
        )}
        <LabeledValueKnob
          label={parametric ? 'q' : 'res'}
          value={qToNorm(band.q)}
          text={band.q.toFixed(2)}
          onChange={(v) => onSet(index, { q: Math.round(normToQ(v) * 100) / 100 })}
        />
      </div>
    </div>
  );
}

function LabeledValueKnob({
  label,
  value,
  text,
  onChange,
  bipolar = false,
}: {
  label: string;
  value: number;
  text: string;
  onChange: (v: number) => void;
  bipolar?: boolean;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <Knob size={40} value={value} onChange={onChange} bipolar={bipolar} title={`${label} · ${text}`} />
      <span className="text-[10px] uppercase tracking-[0.14em] opacity-70">{label}</span>
      <span className="text-[10px] tabular-nums text-white/50">{text}</span>
    </div>
  );
}
