// Engine scope — the output waveform and 24 log bands, drawn under the sys
// telemetry so the window moves with the sound even when nothing on the
// desktop is sequencing (a record: transport stopped, Ghost idle — Chris
// 2026-09-22: "the visualizer block is still carrying most of the weight").
// Fed by `audio:scope` (lib.rs emitter, ~30 Hz, BROADCAST only); draws on
// the event, no rAF loop, monochrome like everything else on the desktop.
// Bands hold their peaks and fall slowly; the waveform is drawn as-is so it
// jitters — a scope, not a meter.
import { useEffect, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

interface ScopeFrame {
  wave: number[];
  bands: number[];
}

// Linear magnitude → 0..1 over a 54 dB floor.
function toUnit(m: number): number {
  if (m <= 0) return 0;
  const db = 20 * Math.log10(m);
  return Math.max(0, Math.min(1, (db + 54) / 54));
}

export function Scope({ className = '' }: { className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let w = 0;
    let h = 0;
    let dpr = 1;
    const fit = () => {
      const r = canvas.getBoundingClientRect();
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = Math.max(1, Math.round(r.width));
      h = Math.max(1, Math.round(r.height));
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    };
    fit();

    const held: number[] = [];
    const smooth: number[] = [];
    let last: ScopeFrame | null = null;

    const draw = (f: ScopeFrame) => {
      last = f;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const n = f.bands.length;
      // Bands: a bar row along the bottom, up to 45% of the height, with a
      // held peak tick above each bar.
      const bandH = Math.min(h * 0.45, Math.max(18, h * 0.3));
      const gap = 1;
      const barW = (w - gap * (n - 1)) / n;
      for (let i = 0; i < n; i++) {
        const u = toUnit(f.bands[i]);
        smooth[i] = (smooth[i] ?? 0) + (u - (smooth[i] ?? 0)) * (u > (smooth[i] ?? 0) ? 0.7 : 0.25);
        held[i] = Math.max((held[i] ?? 0) * 0.965, smooth[i]);
        const x = i * (barW + gap);
        const bh = Math.round(smooth[i] * bandH);
        ctx.fillStyle = 'rgba(255,255,255,0.28)';
        ctx.fillRect(x, h - bh, barW, bh);
        const ph = Math.round(held[i] * bandH);
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.fillRect(x, h - ph - 1, barW, 1);
      }
      // Waveform: one line across the window, centred in the room above
      // the bands. Loud passages reach the top; quiet ones stay a hairline.
      const mid = (h - bandH) * 0.5;
      const amp = Math.max(2, (h - bandH) * 0.46);
      ctx.beginPath();
      const m = f.wave.length;
      for (let i = 0; i < m; i++) {
        const x = (i / (m - 1)) * w;
        const y = mid - Math.max(-1, Math.min(1, f.wave[i])) * amp;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 1;
      ctx.stroke();
      // Zero line, faint.
      ctx.fillStyle = 'rgba(255,255,255,0.12)';
      ctx.fillRect(0, Math.round(mid), w, 1);
    };

    const idle = () => draw({ wave: new Array<number>(128).fill(0), bands: new Array<number>(24).fill(0) });
    idle();
    // A cut resizes the window (close, pair): refit and redraw the last frame.
    const ro = new ResizeObserver(() => {
      fit();
      if (last) draw(last);
      else idle();
    });
    ro.observe(canvas);

    if (!isTauri()) {
      // Browser demo: a slow synthetic signal so the window is not dead.
      const t0 = performance.now();
      const id = window.setInterval(() => {
        const t = (performance.now() - t0) / 1000;
        const wave = Array.from({ length: 128 }, (_, i) => 0.35 * Math.sin(i * 0.19 + t * 3) * (0.6 + 0.4 * Math.sin(t * 0.7)) + (Math.random() - 0.5) * 0.05);
        const bands = Array.from({ length: 24 }, (_, i) => 0.6 * Math.exp(-i / 9) * (0.5 + 0.5 * Math.sin(t * 1.3 + i * 0.4)) * (0.7 + 0.3 * Math.random()));
        draw({ wave, bands });
      }, 33);
      return () => {
        window.clearInterval(id);
        ro.disconnect();
      };
    }

    let un: (() => void) | null = null;
    void listen<ScopeFrame>('audio:scope', (e) => draw(e.payload)).then((fn) => {
      un = fn;
    });
    return () => {
      un?.();
      ro.disconnect();
    };
  }, []);

  return <canvas ref={ref} className={`block w-full h-full ${className}`} />;
}
