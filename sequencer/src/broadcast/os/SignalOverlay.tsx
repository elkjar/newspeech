// Tier one of the transmission: a full-screen canvas over the whole desktop
// (menubar included) that paints the tube — scanlines, the slow rolling
// bar, phosphor flicker, vignette — and, as the signal weakens, fine static
// and thin tear strips. The DOM underneath is only ever tinted (a
// brightness/contrast filter on the transmission root, set only while it
// differs from rest so a clean picture costs nothing); it never moves.
// Static is full resolution (1 css px grain, matching the desktop's own
// grain and type) from a handful of pre-rendered tiles drawn at a random
// offset each frame — no per-frame pixel generation.
// Everything reads one envelope (signal.ts). Displacement (SVG) and the
// WebGL CRT sim on the visual are later tiers of the same envelope.
import { useEffect, useRef } from 'react';
import { installSignalHooks, sampleSignal, signalEnabled, type SignalFrame } from './signal';

export const TRANSMISSION_ID = 'ns-transmission';

const SCAN_PERIOD = 3; // css px
const TILE = 512; // static tile, css px
const TILES = 5;

function makeScanPattern(ctx: CanvasRenderingContext2D, dpr: number): CanvasPattern | null {
  const c = document.createElement('canvas');
  c.width = 1;
  c.height = Math.round(SCAN_PERIOD * dpr);
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = 'rgba(0,0,0,0.42)';
  g.fillRect(0, c.height - Math.max(1, Math.round(dpr)), 1, Math.max(1, Math.round(dpr)));
  return ctx.createPattern(c, 'repeat');
}

// Static at 1 css px grain: mostly dark, grey speckle, a few hot pixels —
// the same texture as the desktop's grain, just louder.
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

function makeVignette(W: number, H: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(W / 4));
  c.height = Math.max(1, Math.round(H / 4));
  const g = c.getContext('2d');
  if (g) {
    const r = Math.hypot(c.width, c.height) / 2;
    const grad = g.createRadialGradient(c.width / 2, c.height / 2, r * 0.45, c.width / 2, c.height / 2, r);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.55)');
    g.fillStyle = grad;
    g.fillRect(0, 0, c.width, c.height);
  }
  return c;
}

export function SignalOverlay() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: true });
    if (!ctx) return;
    const uninstall = installSignalHooks();

    let W = 0;
    let H = 0;
    let dpr = 1;
    let scan: CanvasPattern | null = null;
    let tiles: CanvasPattern[] = [];
    let vignette: HTMLCanvasElement | null = null;

    const resize = () => {
      const next = Math.min(2, window.devicePixelRatio || 1);
      W = window.innerWidth;
      H = window.innerHeight;
      if (next !== dpr || !scan) {
        dpr = next;
        scan = makeScanPattern(ctx, dpr);
        tiles = makeStaticTiles(ctx, dpr);
      }
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      vignette = makeVignette(W, H);
    };
    resize();
    window.addEventListener('resize', resize);

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

    let root: HTMLElement | null = null;
    let rootRest = true;
    const tint = (f: SignalFrame) => {
      if (!root) root = document.getElementById(TRANSMISSION_ID);
      if (!root) return;
      const tinted = Math.abs(f.brightness - 1) > 0.01 || Math.abs(f.contrast - 1) > 0.01;
      if (!tinted) {
        if (!rootRest) {
          root.style.filter = '';
          rootRest = true;
        }
        return;
      }
      rootRest = false;
      root.style.filter = `brightness(${f.brightness.toFixed(3)}) contrast(${f.contrast.toFixed(3)})`;
    };

    let raf = 0;
    let barPhase = Math.random();
    let last = performance.now();
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!signalEnabled()) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (root && !rootRest) {
          root.style.filter = '';
          rootRest = true;
        }
        return;
      }
      const f = sampleSignal(now);
      tint(f);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'source-over';

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

      // Rolling bar — a soft bright band drifting down, faster when weak.
      barPhase = (barPhase + dt / (24 - 10 * (1 - f.quality))) % 1;
      const bh = H * 0.2;
      const by = barPhase * (H + bh) - bh;
      const bg = ctx.createLinearGradient(0, by, 0, by + bh);
      bg.addColorStop(0, 'rgba(255,255,255,0)');
      bg.addColorStop(0.55, `rgba(255,255,255,${(0.16 * f.bar).toFixed(3)})`);
      bg.addColorStop(0.62, `rgba(0,0,0,${(0.22 * f.bar).toFixed(3)})`);
      bg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = bg;
      ctx.fillRect(0, by, W, bh);

      // Phosphor flicker: a veil that trembles.
      const fl = f.flicker * (0.35 + 0.65 * Math.random());
      if (fl > 0.003) {
        ctx.fillStyle = `rgba(0,0,0,${fl.toFixed(3)})`;
        ctx.fillRect(0, 0, W, H);
      }

      // Scanlines.
      if (scan) {
        ctx.globalAlpha = 0.5 + 0.35 * (1 - f.quality);
        ctx.fillStyle = scan;
        ctx.fillRect(0, 0, W, H);
        ctx.globalAlpha = 1;
      }

      // Vignette.
      if (vignette) {
        ctx.imageSmoothingEnabled = true;
        ctx.globalAlpha = 0.6 + 0.3 * (1 - f.quality);
        ctx.drawImage(vignette, 0, 0, W, H);
        ctx.globalAlpha = 1;
      }
    };
    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      uninstall();
      if (root) root.style.filter = '';
    };
  }, []);

  return <canvas ref={canvasRef} className="fixed inset-0 pointer-events-none" style={{ zIndex: 20000 }} aria-hidden />;
}
