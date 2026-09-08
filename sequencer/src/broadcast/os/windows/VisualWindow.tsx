import { useEffect, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { Visualizer } from '../../../stream/Visualizer';

// The visualizer (pool video / camera) framed as a window. In a plain browser
// (demo screenshots) a procedural placeholder stands in.
export function VisualWindow() {
  if (isTauri()) return <Visualizer />;
  return <Placeholder />;
}

function Placeholder() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    let raf = 0;
    const draw = (t: number) => {
      const w = (cv.width = cv.clientWidth);
      const h = (cv.height = cv.clientHeight);
      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, w, h);
      const cols = 48;
      const cw = w / cols;
      for (let i = 0; i < cols; i++) {
        const v = 0.5 + 0.5 * Math.sin(i * 0.37 + t / 900) * Math.sin(i * 0.11 - t / 1300);
        ctx.fillStyle = `rgba(255,255,255,${(0.08 + v * 0.5).toFixed(3)})`;
        const bh = v * h * 0.8;
        ctx.fillRect(i * cw + 1, (h - bh) / 2, cw - 2, bh);
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <canvas ref={ref} className="w-full h-full block" />;
}
