// Cutoff-LFO shape plot for the instrument editor — same visual language as the
// global LFO panel's WaveformPlot (gridlines + centerline + bold one-cycle curve
// + a phase dot riding the curve), but for this LFO's shape set
// (revsaw/saw/tri/square/random) and driven by the synced rate. Illustrative:
// the dot free-runs at the resolved Hz; the real per-voice phase resets per note.
import { useEffect, useRef } from 'react';
import { getAudioContext } from '../audio/audioContext';
import type { LfoShape } from '../instruments/voiceEditsStore';

interface Props {
  shape: LfoShape;
  rateHz: number;
  depth: number;
}

// Stable pseudo-random steps for the Random shape's sample-&-hold display.
const RANDOM_STEPS = (() => {
  let s = 0x1234_5678;
  return Array.from({ length: 8 }, () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 0xffffffff) * 2 - 1;
  });
})();

function shapeValue(shape: LfoShape, p: number): number {
  switch (shape) {
    case 'revsaw':
      return 1 - 2 * p;
    case 'saw':
      return 2 * p - 1;
    case 'tri':
      return 1 - 4 * Math.abs(p - 0.5);
    case 'square':
      return p < 0.5 ? 1 : -1;
    default: // random — sample & hold
      return RANDOM_STEPS[Math.min(RANDOM_STEPS.length - 1, Math.floor(p * RANDOM_STEPS.length))];
  }
}

export function LfoShapePlot({ shape, rateHz, depth }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef<Props>({ shape, rateHz, depth });
  propsRef.current = { shape, rateHz, depth };

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
      const { shape: sh, rateHz: rate, depth: dp } = propsRef.current;
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
        const amp = (H / 2 - 3) * (0.35 + 0.65 * dp);
        const yAt = (p: number) => mid - shapeValue(sh, p) * amp;

        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        for (let px = 0; px <= W; px++) {
          const y = yAt(px / W);
          if (px === 0) ctx.moveTo(px, y);
          else ctx.lineTo(px, y);
        }
        ctx.stroke();

        // phase dot, free-running at the resolved rate
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

  // Fills its parent (the editor sizes it to match the option stack height).
  return (
    <div ref={containerRef} className="relative w-full h-full border border-white/15 bg-black/40 overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 block" />
    </div>
  );
}
