import { useEffect, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { isTauri } from '@tauri-apps/api/core';

// Edge-tangent particle field — port of `10-edges.html` from the newspeech
// site. Acquires the webcam, runs a sobel pass per frame on a downsampled
// luma copy, then walks ~thousands of particles that probabilistically
// follow local edge tangents (or wander via sin-noise when off-contour).
// Trails fade via destination-out so contours read as bright vapor over
// a dim, grayscale-filtered ghost of the camera feed.
//
// Audio-reactive: cpal output level scales particle speed up and lerps
// the edge-bias back toward uniform (the "dissolve" — when the system
// gets loud, the contour structure breaks apart into scatter).

interface Particle {
  x: number;
  y: number;
  dir: number;
  distSinceTurn: number;
  nextTurn: number;
  age: number;
  life: number;
  bright: boolean;
}

// Fixed params — original page had a panel; we hardcode reasonable
// defaults. Tunable later if you want a knob surface in the stream window.
const PARAMS = {
  particleMul: 1,
  speedMul: 1,
  directions: 16,
  edgeWeight: 2.5,
  dissolve: 1,
  overlay: 0.25, // grayscale ghost of the camera frame, dim
  fadeMul: 1,
};

// Sobel grid scaled to this max long edge. 480 keeps the per-frame work
// bounded regardless of webcam resolution.
const SOBEL_LONG_EDGE = 480;

export function Edges() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const levelRef = useRef(0);

  // Cpal level listener — same channel as Flare. Drives the env proxy.
  useEffect(() => {
    if (!isTauri()) return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void listen<number>('audio:level', (e) => {
      if (cancelled) return;
      levelRef.current = e.payload;
    }).then((u) => {
      if (cancelled) u();
      else unsub = u;
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  // Acquire webcam. Mirrors Camera.tsx — keep the stream local and
  // released on unmount so the LED goes off when switching away.
  useEffect(() => {
    let stream: MediaStream | null = null;
    let cancelled = false;
    void (async () => {
      try {
        const s = await navigator.mediaDevices.getUserMedia({
          video: { width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const v = videoRef.current;
        if (v) {
          v.srcObject = s;
          await v.play().catch(() => {});
        }
      } catch (e) {
        console.error('[edges] camera failed:', e);
      }
    })();
    return () => {
      cancelled = true;
      if (stream) stream.getTracks().forEach((t) => t.stop());
      const v = videoRef.current;
      if (v) v.srcObject = null;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const video = videoRef.current;
    if (!canvas || !video) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Trails canvas — particles draw here with destination-out fade so
    // the (optional) grayscale overlay underneath shows through where
    // no particles have drawn.
    const trailsCanvas = document.createElement('canvas');
    const trailsCtx = trailsCanvas.getContext('2d');
    if (!trailsCtx) return;

    // Sobel-grid offscreen + reusable buffers — pre-allocated and reused
    // each frame so we're not allocating a 130K-element Float32Array on
    // every video tick.
    let offCanvas: HTMLCanvasElement | null = null;
    let offCtx: CanvasRenderingContext2D | null = null;
    let grayBuf: Float32Array | null = null;
    let magBuf: Float32Array | null = null;
    let tanBuf: Float32Array | null = null;
    let edgeMag: Float32Array | null = null;
    let edgeTan: Float32Array | null = null;
    let sw = 0;
    let sh = 0;
    let imgW = 0;
    let imgH = 0;

    let cw = 0;
    let ch = 0;
    let dpr = 1;
    let particles: Particle[] = [];
    let smoothedLevel = -1;

    const ensureSobelBuffers = () => {
      if (!offCanvas || offCanvas.width !== sw || offCanvas.height !== sh) {
        offCanvas = document.createElement('canvas');
        offCanvas.width = sw;
        offCanvas.height = sh;
        offCtx = offCanvas.getContext('2d', { willReadFrequently: true });
      }
      const n = sw * sh;
      if (!grayBuf || grayBuf.length !== n) {
        grayBuf = new Float32Array(n);
        magBuf = new Float32Array(n);
        tanBuf = new Float32Array(n);
      }
    };

    const computeSobel = () => {
      if (!offCtx || !grayBuf || !magBuf || !tanBuf) return;
      offCtx.drawImage(video, 0, 0, sw, sh);
      const { data } = offCtx.getImageData(0, 0, sw, sh);
      const g = grayBuf;
      for (let i = 0, j = 0; i < g.length; i++, j += 4) {
        g[i] =
          (data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114) / 255;
      }
      const mag = magBuf;
      const tan = tanBuf;
      let maxMag = 1e-6;
      for (let y = 1; y < sh - 1; y++) {
        for (let x = 1; x < sw - 1; x++) {
          const i = y * sw + x;
          const a = g[i - sw - 1];
          const b = g[i - sw];
          const c = g[i - sw + 1];
          const d = g[i - 1];
          const f = g[i + 1];
          const e = g[i + sw - 1];
          const h = g[i + sw];
          const k = g[i + sw + 1];
          const gx = -a + c - 2 * d + 2 * f - e + k;
          const gy = -a - 2 * b - c + e + 2 * h + k;
          const m = Math.hypot(gx, gy);
          mag[i] = m;
          tan[i] = Math.atan2(gx, -gy);
          if (m > maxMag) maxMag = m;
        }
      }
      // 95th-percentile normalization — a single high-contrast region
      // otherwise pegs the max and crushes every other edge to near-zero.
      const sample: number[] = [];
      for (let i = 0; i < mag.length; i += 5) if (mag[i] > 0) sample.push(mag[i]);
      sample.sort((a, b) => a - b);
      const norm = sample.length ? sample[Math.floor(sample.length * 0.95)] : maxMag;
      const inv = 1 / Math.max(1e-6, norm);
      for (let i = 0; i < mag.length; i++) {
        const v = mag[i] * inv;
        mag[i] = v > 1 ? 1 : v;
      }
      edgeMag = mag;
      edgeTan = tan;
    };

    const sampleEdge = (x: number, y: number): { m: number; t: number } | null => {
      if (!edgeMag || !edgeTan || imgW === 0 || imgH === 0) return null;
      const scale = Math.max(cw / imgW, ch / imgH);
      const drawW = imgW * scale;
      const drawH = imgH * scale;
      const offX = (cw - drawW) * 0.5;
      const offY = (ch - drawH) * 0.5;
      const ix = (x - offX) / scale;
      const iy = (y - offY) / scale;
      let sx = Math.floor((ix * sw) / imgW);
      let sy = Math.floor((iy * sh) / imgH);
      if (sx < 0) sx = 0;
      else if (sx >= sw) sx = sw - 1;
      if (sy < 0) sy = 0;
      else if (sy >= sh) sy = sh - 1;
      const i = sy * sw + sx;
      return { m: edgeMag[i], t: edgeTan[i] };
    };

    const quantize = (ang: number): number => {
      const dirs = Math.max(1, Math.round(PARAMS.directions));
      const step = (Math.PI * 2) / dirs;
      return Math.round(ang / step) * step;
    };

    const sampleSpawnPosition = (env: number): [number, number] => {
      if (!edgeMag) return [Math.random() * cw, Math.random() * ch];
      const dissolveK = Math.max(0, 1 - env * PARAMS.dissolve);
      if (dissolveK <= 0) return [Math.random() * cw, Math.random() * ch];
      for (let attempts = 0; attempts < 12; attempts++) {
        const cx = Math.random() * cw;
        const cy = Math.random() * ch;
        const e = sampleEdge(cx, cy);
        if (e && Math.random() < e.m * dissolveK) return [cx, cy];
      }
      return [Math.random() * cw, Math.random() * ch];
    };

    const makeParticle = (env: number, x?: number, y?: number): Particle => {
      let px: number;
      let py: number;
      if (x !== undefined && y !== undefined) {
        px = x;
        py = y;
      } else {
        [px, py] = sampleSpawnPosition(env);
      }
      return {
        x: px,
        y: py,
        dir: Math.random() * Math.PI * 2,
        distSinceTurn: 1e9,
        nextTurn: 6 + Math.random() * 24,
        age: 0,
        life: 0.8 + Math.random() * 2.6,
        bright: Math.random() < 0.05,
      };
    };

    const targetParticleCount = (): number => {
      const base = Math.min(9000, Math.max(1500, Math.floor((cw * ch) / 900)));
      return Math.max(1, Math.round(base * PARAMS.particleMul));
    };

    const adjustParticleCount = (env: number) => {
      const target = targetParticleCount();
      while (particles.length < target) particles.push(makeParticle(env));
      if (particles.length > target) particles.length = target;
    };

    const resize = () => {
      dpr = Math.max(1, window.devicePixelRatio || 1);
      const viewW = canvas.clientWidth;
      const viewH = canvas.clientHeight;
      cw = Math.max(1, Math.floor(viewW * dpr));
      ch = Math.max(1, Math.floor(viewH * dpr));
      canvas.width = cw;
      canvas.height = ch;
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, cw, ch);
      trailsCanvas.width = cw;
      trailsCanvas.height = ch;
      trailsCtx.imageSmoothingEnabled = false;
      adjustParticleCount(0.3);
    };

    const field = (
      x: number,
      y: number,
      t: number,
      prevDir: number,
      env: number,
    ): number => {
      const u = x / cw;
      const v = y / ch;
      const a = Math.sin(u * 6.0 + t * 0.00031);
      const b = Math.sin(v * 5.0 - t * 0.00023);
      const c = Math.sin((u + v) * 4.0 + t * 0.00041);
      const d = Math.sin((u - v) * 7.0 - t * 0.00017);
      const wander = (a + b + 0.6 * c + 0.4 * d) * Math.PI;

      const e = sampleEdge(x, y);
      if (!e) return wander;

      const dissolveK = Math.max(0, 1 - env * PARAMS.dissolve);
      const w = e.m * PARAMS.edgeWeight * dissolveK;
      if (w <= 0 || Math.random() > w) return wander;

      // Tangent has 180° ambiguity — pick the direction nearest current
      // heading so particles ride along edges instead of flipping.
      let ta = e.t;
      if (Math.cos(prevDir - ta) < 0) ta += Math.PI;
      return ta;
    };

    const drawOverlay = (alpha: number) => {
      if (!video || video.readyState < 2) return;
      const vw = video.videoWidth;
      const vh = video.videoHeight;
      if (!vw || !vh) return;
      const scale = Math.max(cw / vw, ch / vh);
      const drawW = vw * scale;
      const drawH = vh * scale;
      const offX = (cw - drawW) * 0.5;
      const offY = (ch - drawH) * 0.5;
      const prevAlpha = ctx.globalAlpha;
      ctx.globalAlpha = alpha;
      ctx.drawImage(video, offX, offY, drawW, drawH);
      ctx.globalAlpha = prevAlpha;
      // Grayscale is applied via CSS `filter` on the canvas element below
      // rather than `ctx.filter` here — the latter no-ops on some
      // WKWebView versions. Whole-canvas grayscale is safe because the
      // only colored content is this overlay; particles are already white.
    };

    const step = (dt: number) => {
      const t = performance.now();
      // Cpal level → env, with the same fast-attack / slow-release feel
      // as the flare visualizer so the audio reactivity matches across
      // modes.
      const rawLevel = Math.min(1, levelRef.current * 1.5);
      if (smoothedLevel < 0) smoothedLevel = rawLevel;
      else {
        const k = rawLevel > smoothedLevel ? 0.55 : 0.12;
        smoothedLevel = smoothedLevel * (1 - k) + rawLevel * k;
      }
      const env = smoothedLevel;
      const dissolveK = Math.max(0, 1 - env * PARAMS.dissolve);

      // Trail fade via destination-out so the overlay underneath shows
      // through wherever particles haven't drawn.
      const fadeAlpha = Math.min(
        0.4,
        (1.6 + 2.4 * (1 - env)) * dt * PARAMS.fadeMul,
      );
      trailsCtx.globalCompositeOperation = 'destination-out';
      trailsCtx.fillStyle = `rgba(0,0,0,${fadeAlpha})`;
      trailsCtx.fillRect(0, 0, cw, ch);
      trailsCtx.globalCompositeOperation = 'source-over';

      const speedCss = (90 + 180 * env) * PARAMS.speedMul;
      const speed = speedCss * dpr;

      for (const p of particles) {
        if (p.distSinceTurn >= p.nextTurn) {
          p.dir = quantize(field(p.x, p.y, t, p.dir, env));
          p.distSinceTurn = 0;
          p.nextTurn = 6 + Math.random() * 24;
        }
        const dx = Math.cos(p.dir) * speed * dt;
        const dy = Math.sin(p.dir) * speed * dt;
        p.x += dx;
        p.y += dy;
        p.distSinceTurn += Math.hypot(dx, dy);
        p.age += dt;

        if (p.x < 0) p.x += cw;
        else if (p.x >= cw) p.x -= cw;
        if (p.y < 0) p.y += ch;
        else if (p.y >= ch) p.y -= ch;

        if (p.age > p.life) {
          const [nx, ny] = sampleSpawnPosition(env);
          p.x = nx;
          p.y = ny;
          p.age = 0;
          p.life = 0.8 + Math.random() * 2.6;
          p.bright = Math.random() < 0.05;
          p.distSinceTurn = 1e9;
        }

        const eHere = sampleEdge(p.x, p.y);
        const m = eHere ? eHere.m : 0;
        const visScale = 1 - 0.85 * dissolveK * (1 - m);

        const xi = p.x | 0;
        const yi = p.y | 0;
        if (p.bright) {
          const a = 0.95 * visScale;
          trailsCtx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
          trailsCtx.fillRect(xi, yi, 1, 1);
        } else {
          const ageK = 1 - Math.min(1, p.age / p.life);
          const a = (0.45 + 0.35 * ageK) * visScale;
          trailsCtx.fillStyle = `rgba(220,220,220,${a.toFixed(3)})`;
          trailsCtx.fillRect(xi, yi, 1, 1);
        }
      }

      // Composite: bg → grayscale overlay → trails layer.
      ctx.clearRect(0, 0, cw, ch);
      if (PARAMS.overlay > 0) drawOverlay(PARAMS.overlay);
      ctx.drawImage(trailsCanvas, 0, 0);
    };

    let rafId = 0;
    const frame = (t: number) => {
      const dt = Math.min(0.05, (t - lastT) / 1000);
      lastT = t;
      // Recompute sobel on the live video frame so particles track
      // moving contours.
      if (video.readyState >= 2 && !video.paused) {
        if (!imgW || !imgH || video.videoWidth !== imgW || video.videoHeight !== imgH) {
          imgW = video.videoWidth;
          imgH = video.videoHeight;
          if (imgW && imgH) {
            const scale = SOBEL_LONG_EDGE / Math.max(imgW, imgH);
            sw = Math.max(2, Math.floor(imgW * scale));
            sh = Math.max(2, Math.floor(imgH * scale));
            ensureSobelBuffers();
          }
        }
        if (imgW && imgH) computeSobel();
      }
      step(dt);
      rafId = window.requestAnimationFrame(frame);
    };

    let lastT = performance.now();
    resize();
    window.addEventListener('resize', resize);
    rafId = window.requestAnimationFrame(frame);

    return () => {
      window.cancelAnimationFrame(rafId);
      window.removeEventListener('resize', resize);
    };
  }, []);

  return (
    <div className="absolute inset-0">
      {/* Source video stays off-screen — we only use it as a drawImage
          source for sobel + grayscale overlay. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          opacity: 0,
          pointerEvents: 'none',
        }}
      />
      <canvas
        ref={canvasRef}
        className="block absolute inset-0 w-full h-full"
        style={{ filter: 'grayscale(1)' }}
      />
    </div>
  );
}
