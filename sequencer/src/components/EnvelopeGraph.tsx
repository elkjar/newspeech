// ADSR envelope editor — a draggable curve instead of sliders. The shape reads
// left→right: attack ramp from the left edge to peak, decay to the sustain
// level, the sustain hold, then release back to zero. Three handles:
//   • attack peak (top)           — drag X → attack
//   • sustain corner              — drag X → decay, drag Y → sustain level
//   • release end (baseline)      — drag X → release
// Each stage has a fixed horizontal "lane" scaled to its max time, so handles
// track the cursor directly (no rescale-as-you-drag). Monochrome to match.
import { useEffect, useRef, useState } from 'react';
import type { AmpEnvEdit } from '../instruments/voiceEditsStore';

interface Props {
  env: AmpEnvEdit;
  onChange: (patch: Partial<AmpEnvEdit>) => void;
}

const HEIGHT = 120;
const PAD_X = 8;
const PAD_TOP = 12;
const PAD_BOT = 12;
// Per-stage max seconds (match the editor's slider ranges) + the lane budget
// each gets. Sustain has no duration — it's a fixed display hold.
const ATTACK_MAX = 2;
const DECAY_MAX = 2;
const RELEASE_MAX = 3;
const LANES = { attack: 2, decay: 2, sustain: 1.2, release: 3 };
const LANE_SUM = LANES.attack + LANES.decay + LANES.sustain + LANES.release;

interface Geom {
  baseline: number;
  top: number;
  attackEndX: number;
  decayEndX: number;
  sustainEndX: number;
  releaseEndX: number;
  sustainY: number;
  wa: number;
  wc: number;
  wr: number;
}

function geometry(env: AmpEnvEdit, width: number): Geom {
  const top = PAD_TOP;
  const baseline = HEIGHT - PAD_BOT;
  const unit = (width - 2 * PAD_X) / LANE_SUM;
  const wa = unit * LANES.attack;
  const wc = unit * LANES.decay;
  const ws = unit * LANES.sustain;
  const wr = unit * LANES.release;
  const attackEndX = PAD_X + (env.attack / ATTACK_MAX) * wa;
  const decayEndX = attackEndX + (env.decay / DECAY_MAX) * wc;
  const sustainEndX = decayEndX + ws;
  const releaseEndX = sustainEndX + (env.release / RELEASE_MAX) * wr;
  const sustainY = top + (1 - env.sustain) * (baseline - top);
  return { baseline, top, attackEndX, decayEndX, sustainEndX, releaseEndX, sustainY, wa, wc, wr };
}

type Handle = 'attack' | 'sustain' | 'release';
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function EnvelopeGraph({ env, onChange }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [width, setWidth] = useState(0);
  const dragRef = useRef<Handle | null>(null);
  const envRef = useRef(env);
  envRef.current = env;
  const widthRef = useRef(width);
  widthRef.current = width;

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = Math.floor(entries[0].contentRect.width);
      if (w > 0) setWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = HEIGHT * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);
    const g = geometry(env, width);

    // Curve: attack peak → decay to sustain → hold → release.
    const pts: [number, number][] = [
      [PAD_X, g.baseline],
      [g.attackEndX, g.top],
      [g.decayEndX, g.sustainY],
      [g.sustainEndX, g.sustainY],
      [g.releaseEndX, g.baseline],
    ];
    // Fill under the curve.
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.lineTo(g.releaseEndX, g.baseline);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fill();
    // Stroke.
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (const [x, y] of pts) ctx.lineTo(x, y);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Handles.
    const handles: [number, number][] = [
      [g.attackEndX, g.top],
      [g.decayEndX, g.sustainY],
      [g.releaseEndX, g.baseline],
    ];
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    for (const [x, y] of handles) {
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [env, width]);

  const pick = (clientX: number, clientY: number): Handle | null => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const g = geometry(envRef.current, widthRef.current);
    const targets: [Handle, number, number][] = [
      ['attack', g.attackEndX, g.top],
      ['sustain', g.decayEndX, g.sustainY],
      ['release', g.releaseEndX, g.baseline],
    ];
    let best: Handle | null = null;
    let bestD = 18; // hit radius (px)
    for (const [id, hx, hy] of targets) {
      const d = Math.hypot(x - hx, y - hy);
      if (d < bestD) {
        bestD = d;
        best = id;
      }
    }
    return best;
  };

  const applyDrag = (handle: Handle, clientX: number, clientY: number) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const g = geometry(envRef.current, widthRef.current);
    switch (handle) {
      case 'attack':
        onChange({ attack: clamp(((x - PAD_X) / g.wa) * ATTACK_MAX, 0, ATTACK_MAX) });
        break;
      case 'sustain':
        onChange({
          decay: clamp(((x - g.attackEndX) / g.wc) * DECAY_MAX, 0, DECAY_MAX),
          sustain: clamp(1 - (y - g.top) / (g.baseline - g.top), 0, 1),
        });
        break;
      case 'release':
        onChange({ release: clamp(((x - g.sustainEndX) / g.wr) * RELEASE_MAX, 0, RELEASE_MAX) });
        break;
    }
  };

  const onDown = (e: React.PointerEvent) => {
    const h = pick(e.clientX, e.clientY);
    if (!h) return;
    dragRef.current = h;
    canvasRef.current!.setPointerCapture(e.pointerId);
    applyDrag(h, e.clientX, e.clientY);
  };
  const onMove = (e: React.PointerEvent) => {
    if (dragRef.current) applyDrag(dragRef.current, e.clientX, e.clientY);
  };
  const onUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    try {
      canvasRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };

  return (
    <div ref={wrapRef} className="mb-2">
      <canvas
        ref={canvasRef}
        style={{ width: '100%', height: HEIGHT, touchAction: 'none', display: 'block' }}
        className="border border-white/15 bg-black/40 cursor-pointer"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerLeave={onUp}
      />
    </div>
  );
}
