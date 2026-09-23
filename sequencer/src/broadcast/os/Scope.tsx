// Engine scope — the output waveform and 24 log bands, the `audio` window's
// content, so something on the desktop moves with the sound even when
// nothing is sequencing (a record: transport stopped, Ghost idle — Chris
// 2026-09-22: "the visualizer block is still carrying most of the weight").
// Fed by `audio:scope` (lib.rs emitter, ~30 Hz, BROADCAST only); draws on
// the event, no rAF loop, monochrome like everything else on the desktop.
// Bands hold their peaks and fall slowly; the waveform is drawn as-is so it
// jitters — a scope, not a meter.
import { useEffect, useRef } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useStage, useLayout } from './layout';

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

    // Size from LAYOUT px (clientWidth/Height), never the bounding rect:
    // the stage is a CSS transform and a window can remount mid-animation
    // after a gap, so the rect lied and the canvas came back oversized
    // and soft (Chris 2026-09-22: "gets larger and blurry occasionally
    // when it loads back into the main view"). Backing store = layout ×
    // dpr × stage scale × content zoom; checked on every frame so a
    // missed resize can never stick.
    let w = 1;
    let h = 1;
    let k = 1;
    const fit = () => {
      const dpr = window.devicePixelRatio || 1;
      const stage = useStage.getState().scale || 1;
      const zoom = useLayout.getState().zoom || 1;
      k = Math.min(3, dpr * stage * zoom);
      w = Math.max(1, canvas.clientWidth);
      h = Math.max(1, canvas.clientHeight);
      const bw = Math.round(w * k);
      const bh = Math.round(h * k);
      if (canvas.width !== bw || canvas.height !== bh) {
        canvas.width = bw;
        canvas.height = bh;
      }
    };
    fit();

    const held: number[] = [];
    const smooth: number[] = [];
    let last: ScopeFrame | null = null;

    const draw = (f: ScopeFrame) => {
      last = f;
      fit();
      ctx.setTransform(k, 0, 0, k, 0, 0);
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
    // A cut resizes the window (close, pair, split) and a window resize
    // rescales the stage: refit and redraw the last frame.
    const redraw = () => {
      if (last) draw(last);
      else idle();
    };
    const ro = new ResizeObserver(redraw);
    ro.observe(canvas);
    const unStage = useStage.subscribe(redraw);

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
        unStage();
      };
    }

    let un: (() => void) | null = null;
    void listen<ScopeFrame>('audio:scope', (e) => draw(e.payload)).then((fn) => {
      un = fn;
    });
    return () => {
      un?.();
      ro.disconnect();
      unStage();
    };
  }, []);

  return <canvas ref={ref} className={`block w-full h-full ${className}`} />;
}
