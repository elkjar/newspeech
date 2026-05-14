import { useEffect, useRef } from 'react';
import { useSequencerStore } from '../state/store';
import { getScopeAnalyser } from '../audio/scope';

const W = 80;
const H = 96; // matches StepInspector's min-h-24 (6rem); inspector is fixed.

export function Scope() {
  const playing = useSequencerStore((s) => s.playing);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!playing) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    ctx.scale(dpr, dpr);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';

    const analyser = getScopeAnalyser();
    const buf = new Float32Array(analyser.fftSize);
    const half = H / 2;

    const render = () => {
      analyser.getFloatTimeDomainData(buf);
      ctx.clearRect(0, 0, W, H);
      ctx.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const x = (i / (buf.length - 1)) * W;
        const y = half - buf[i] * (half - 2);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
      rafRef.current = requestAnimationFrame(render);
    };

    rafRef.current = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafRef.current);
  }, [playing]);

  return (
    <div
      className="border border-white/15"
      style={{ width: W, height: H }}
      title="scope · post-FX"
    >
      <canvas ref={canvasRef} />
    </div>
  );
}
