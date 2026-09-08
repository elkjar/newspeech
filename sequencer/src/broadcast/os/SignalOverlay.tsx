// Tier one of the transmission: the tube over the whole desktop (menubar
// included) — scanlines, the slow rolling bar, phosphor flicker, vignette —
// and, as the signal weakens, fine static and thin tear strips. The DOM
// underneath never moves and is never filtered: the weak-signal dimming and
// the lock flash are veils on top. (A brightness/contrast filter on the
// transmission root re-rasterised the entire desktop on every video frame
// while the picture was weak — song starts lagged the machine, Chris
// 2026-09-08.) Everything that is a flat full-frame layer — scanlines,
// vignette, dim, flicker, flash, the bar — is a DOM layer whose opacity /
// transform changes per frame (compositor-only, no raster); the canvas paints
// only the static and the tears, and idles when there are none.
// Static is full resolution (1 stage px grain, matching the desktop's own
// grain and type) from a handful of pre-rendered tiles drawn at a random
// offset each frame — no per-frame pixel generation.
// Everything reads one envelope (signal.ts). Displacement (SVG) and the
// WebGL CRT sim on the visual are later tiers of the same envelope.
import { useEffect, useRef, type CSSProperties } from 'react';
import { installSignalHooks, sampleSignal, signalEnabled } from './signal';
import { STAGE_W, STAGE_H, useStage } from './layout';

export const TRANSMISSION_ID = 'ns-transmission';

const SCAN_PERIOD = 3; // stage px
const TILE = 512; // static tile, css px
const TILES = 5;

function makeStaticTiles(ctx: CanvasRenderingContext2D, dpr: number): CanvasPattern[] {
  const out: CanvasPattern[] = [];
  const px = Math.max(1, Math.round(dpr));
  for (let n = 0; n < TILES; n++) {
    const c = document.createElement('canvas');
    c.width = TILE * px;
    c.height = TILE * px;
    const g = c.getContext('2d');
    if (!g) continue;
    const img = g.createImageData(c.width, c.height);
    const d = img.data;
    // Fill per css pixel, replicated px×px so the grain is 1 css px on retina.
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const v = Math.random();
        const val = v < 0.5 ? 0 : Math.floor(Math.pow((v - 0.5) / 0.5, 1.6) * 230);
        for (let yy = 0; yy < px; yy++) {
          for (let xx = 0; xx < px; xx++) {
            const i = ((y * px + yy) * c.width + (x * px + xx)) * 4;
            d[i] = val;
            d[i + 1] = val;
            d[i + 2] = val;
            d[i + 3] = 255;
          }
        }
      }
    }
    g.putImageData(img, 0, 0);
    const p = ctx.createPattern(c, 'repeat');
    if (p) out.push(p);
  }
  return out;
}

const LAYER: CSSProperties = { position: 'absolute', inset: 0, pointerEvents: 'none' };

export function SignalOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scanRef = useRef<HTMLDivElement>(null);
  const vigRef = useRef<HTMLDivElement>(null);
  const veilRef = useRef<HTMLDivElement>(null);
  const flashRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    const uninstall = installSignalHooks();

    const W = STAGE_W;
    const H = STAGE_H;
    let dpr = 1;
    let tiles: CanvasPattern[] = [];

    // The canvas lives on the stage (stage px, scaled with everything else);
    // its backing store follows the on-screen scale so a grown stage stays
    // sharp and the grain stays 1 stage px — the same px the type is set in.
    const resize = () => {
      const next = Math.min(3, (window.devicePixelRatio || 1) * useStage.getState().scale);
      if (next !== dpr || !tiles.length) {
        dpr = next;
        tiles = makeStaticTiles(ctx, dpr);
      }
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
    };
    resize();
    const unsubStage = useStage.subscribe(resize);

    // Static fill: a random tile at a random offset. `setTransform` moves the
    // pattern origin; the rect is drawn in the same shifted space.
    const paintStatic = (alpha: number, x: number, y: number, w: number, h: number) => {
      if (!tiles.length || alpha <= 0.003) return;
      const p = tiles[Math.floor(Math.random() * tiles.length)];
      const ox = Math.floor(Math.random() * TILE);
      const oy = Math.floor(Math.random() * TILE);
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, -ox * dpr, -oy * dpr);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p;
      ctx.fillRect(x + ox, y + oy, w, h);
      ctx.restore();
    };

    // Layer opacity writes only when the value moved — a style write is
    // cheap but not free at 60 Hz × 5 layers.
    const lastOp = new Map<HTMLElement, number>();
    const opacity = (el: HTMLElement | null, v: number) => {
      if (!el) return;
      const q = Math.round(Math.max(0, Math.min(1, v)) * 200) / 200;
      if (lastOp.get(el) === q) return;
      lastOp.set(el, q);
      el.style.opacity = String(q);
    };

    let raf = 0;
    let barPhase = Math.random();
    let last = performance.now();
    let canvasDirty = false;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!signalEnabled()) {
        if (canvasDirty) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          canvasDirty = false;
        }
        for (const r of [scanRef, vigRef, veilRef, flashRef, barRef]) opacity(r.current, 0);
        return;
      }
      const f = sampleSignal(now);

      // Canvas: static + tears, only when there is any.
      const hasStatic = f.noise > 0.003 || f.tears.length > 0;
      if (hasStatic || canvasDirty) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, W, H);
        ctx.globalCompositeOperation = 'source-over';
        canvasDirty = hasStatic;
      }
      if (hasStatic) {
        // Static — fine grain, capped so the desktop always reads through.
        paintStatic(f.noise, 0, 0, W, H);
        // Tear strips: thin bands of static slipping sideways.
        for (const tb of f.tears) {
          const y = Math.round(tb.y * H);
          const h = Math.max(1, Math.round(tb.h * H));
          const dx = Math.round(tb.dx * W);
          paintStatic(tb.a, dx, y, W, h);
          // A faint dark shear line at the top edge so the strip reads as a cut.
          ctx.globalAlpha = tb.a * 0.6;
          ctx.fillStyle = '#000';
          ctx.fillRect(0, y, W, 1);
          ctx.globalAlpha = 1;
        }
      }

      // Rolling bar — a soft bright band drifting down, faster when weak.
      barPhase = (barPhase + dt / (24 - 10 * (1 - f.quality))) % 1;
      const bh = H * 0.2;
      const by = barPhase * (H + bh) - bh;
      const bar = barRef.current;
      if (bar) bar.style.transform = `translate3d(0,${by.toFixed(1)}px,0)`;
      opacity(bar, f.bar);

      // Weak-signal dim + phosphor flicker: one black veil. The dim stands in
      // for the old brightness/contrast tint (the contrast lift is gone; the
      // dim is a touch deeper to carry the same weight).
      const weak = 1 - f.quality;
      const dim = Math.max(0, 1 - f.brightness) * 1.5 + weak * 0.05;
      const fl = f.flicker * (0.35 + 0.65 * Math.random());
      opacity(veilRef.current, dim + fl);

      // Lock flash: the bright frame that settles.
      opacity(flashRef.current, Math.max(0, f.brightness - 1) * 0.55);

      // Scanlines and vignette: steady layers whose weight follows quality.
      opacity(scanRef.current, 0.5 + 0.35 * weak);
      opacity(vigRef.current, 0.6 + 0.3 * weak);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      unsubStage();
      uninstall();
    };
  }, []);

  return (
    <div style={{ ...LAYER, zIndex: 20000 }} aria-hidden>
      <canvas ref={canvasRef} style={LAYER} />
      <div ref={barRef} style={{ ...LAYER, bottom: 'auto', height: '20%', opacity: 0, willChange: 'transform, opacity', background: 'linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.16) 55%, rgba(0,0,0,0.22) 62%, rgba(0,0,0,0) 100%)' }} />
      <div ref={veilRef} style={{ ...LAYER, opacity: 0, background: '#000', willChange: 'opacity' }} />
      <div ref={flashRef} style={{ ...LAYER, opacity: 0, background: '#fff', willChange: 'opacity' }} />
      <div ref={scanRef} style={{ ...LAYER, opacity: 0, willChange: 'opacity', background: `repeating-linear-gradient(to bottom, rgba(0,0,0,0) 0px, rgba(0,0,0,0) ${SCAN_PERIOD - 1}px, rgba(0,0,0,0.42) ${SCAN_PERIOD - 1}px, rgba(0,0,0,0.42) ${SCAN_PERIOD}px)` }} />
      <div ref={vigRef} style={{ ...LAYER, opacity: 0, willChange: 'opacity', background: 'radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,0.55) 100%)' }} />
    </div>
  );
}
