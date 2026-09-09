// The tube — BROADCAST's WebGL treatment of the visual, for runs that go
// straight to a screen capture with no CRT in the chain (Chris 2026-09-09:
// "making the glitchy style stuff within OpenGL … having the best version
// possible for that does still make sense"). FLAT — no curvature (Chris:
// "we can do it flat and just focus on the tear / shimmer / bloom etc.").
//
// What it does, all monochrome (the site is mono; no colour fringing):
//   - slips: the tube's own Poisson-scheduled bands of rows shoved sideways
//     (every few seconds; more on weak reception), the signal envelope's tear
//     bands, and a band per onset; hold slips jump the picture vertically
//     for a moment with a dark seam;
//   - per-line jitter: every line lands a little off, differently each
//     frame (VHS shimmer), more with weak reception and level;
//   - bloom: bright areas bleed — quarter-res threshold + two separable
//     gaussian passes, added back; opens up with level;
//   - ghost: a second image offset right — the doubling — with a slowly
//     drifting offset;
//   - scanline mask, brightness/contrast from the envelope, a mild flat
//     vignette. No static of its own — the visuals are already mangled and
//     the desktop overlay carries the noise (Chris 2026-09-09).
//
// It wraps the source element (pool video / image, camera video, the demo
// canvas) — the source keeps playing at opacity 0 and the canvas draws over
// it — inside ReactiveVisual, so the breathing filter, onset glitch
// animations, drift and the count-in GlitchWrap all still apply on top.
// Nothing here touches the DOM outside its own canvas (the song-start-lag
// rule: no per-frame filters on the desktop).
//
// Falls back to the plain source when WebGL is unavailable or the media is
// cross-origin without CORS (texture upload throws → tube off for that
// element, logged once).
import { useEffect, useRef, type ReactNode } from 'react';
import { create } from 'zustand';
import { lastSignal } from './signal';
import { reactive } from './reactiveLevel';
import { useStage, useLayout, type TubeLevel } from './layout';

export const useTube = create<{ on: boolean }>(() => ({ on: false }));
export function setTubeEnabled(on: boolean): void {
  if (useTube.getState().on !== on) useTube.setState({ on });
}

// Strengths. Tuned by eye on the demo; Chris tunes by eye on a run.
const TUBE = {
  // Chris 2026-09-09, twice: tube vs signal "VERY similar … not really
  // seeing any of the slip / tear / doubling". So the tube schedules its own
  // slips (the overlay's tears are ~one per 90 s) and the doubling is a real
  // second image, not a 13% echo. Ease off by eye.
  lineJitterPx: 0.8, // per-line horizontal jitter at rest (VHS shimmer)
  lineJitterWeak: 3.0,
  lineJitterLevel: 2.0,
  // Bloom is highlights only — Chris 2026-09-09 on 0.1.11: the visuals were
  // "giant blurs on the tube setting vs. signal where they are readable".
  bloomThreshold: 0.62,
  bloomRest: 0.2,
  bloomLevel: 0.35,
  bloomPasses: 1,
  // The double: further out and lighter than the first pass, so it reads as
  // two images rather than a smear on soft footage.
  ghostRest: 0.24,
  ghostWeak: 0.3,
  ghostDx: 0.034, // fraction of width, centre of a slow drift
  ghostDrift: 0.014,
  scan: 0.42,
  scanWeak: 0.3,
  scanPeriodPx: 3,
  wobblePx: 5.0, // tracking wobble band, px
  wobbleWeak: 9.0,
  vignette: 0.12,
  // Slips: bands of rows shoved sideways. Poisson, per second, at rest;
  // rate climbs with weak reception.
  slipRate: 1 / 3.5,
  slipRateWeak: 3,
  slipDxMin: 0.04, // fraction of width
  slipDxMax: 0.14,
  slipMsMin: 180,
  slipMsMax: 700,
  // Hold slips: the whole picture jumps vertically for a moment, a dark
  // seam where it wraps. Rare.
  rollRate: 1 / 14,
  rollMin: 0.03,
  rollMax: 0.12,
  rollMsMin: 120,
  rollMsMax: 320,
  onsetTearMs: 170,
  maxTears: 6,
  bloomDiv: 4,
  maxBacking: 1280,
  minFrameMs: 30,
};

// Subtle / distorted / destroyed (Chris 2026-09-09): multipliers over TUBE.
// `distorted` is the tuned default (all 1); subtle halves the motion and
// doubling; destroyed is a signal that is barely holding on.
const LEVELS: Record<TubeLevel, { jitter: number; ghost: number; slipRate: number; slipDx: number; roll: number; wobble: number; bloom: number }> = {
  subtle: { jitter: 0.45, ghost: 0.45, slipRate: 0.3, slipDx: 0.6, roll: 0.25, wobble: 0.45, bloom: 0.8 },
  distorted: { jitter: 1, ghost: 1, slipRate: 1, slipDx: 1, roll: 1, wobble: 1, bloom: 1 },
  destroyed: { jitter: 2.4, ghost: 1.5, slipRate: 3.2, slipDx: 1.7, roll: 3.5, wobble: 2.2, bloom: 1.35 },
};

const VS = `
attribute vec2 aPos;
varying vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

// Source sample with object-fit: cover and the video's top-left origin.
const SRC_FN = `
uniform sampler2D uSrc;
uniform vec2 uCover;
float luma(vec2 uv) {
  uv = (uv - 0.5) * uCover + 0.5;
  uv.y = 1.0 - uv.y;
  vec3 c = texture2D(uSrc, uv).rgb;
  return dot(c, vec3(0.299, 0.587, 0.114));
}`;

const FS_THRESHOLD = `
precision mediump float;
varying vec2 vUv;
uniform float uThr;
${SRC_FN}
void main() {
  float l = luma(vUv);
  gl_FragColor = vec4(vec3(max(0.0, l - uThr) / (1.0 - uThr)), 1.0);
}`;

const FS_BLUR = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  float s = texture2D(uTex, vUv).r * 0.227;
  s += (texture2D(uTex, vUv + uDir).r + texture2D(uTex, vUv - uDir).r) * 0.1945;
  s += (texture2D(uTex, vUv + uDir * 2.0).r + texture2D(uTex, vUv - uDir * 2.0).r) * 0.1216;
  s += (texture2D(uTex, vUv + uDir * 3.0).r + texture2D(uTex, vUv - uDir * 3.0).r) * 0.0541;
  s += (texture2D(uTex, vUv + uDir * 4.0).r + texture2D(uTex, vUv - uDir * 4.0).r) * 0.0162;
  gl_FragColor = vec4(vec3(s), 1.0);
}`;

const FS_FINAL = `
precision mediump float;
varying vec2 vUv;
uniform sampler2D uBloom;
uniform vec2 uRes;
uniform float uTime;
uniform float uSeed;
uniform float uLineJitter;
uniform float uRoll;
uniform float uBloomAmt;
uniform float uGhost;
uniform float uGhostDx;
uniform float uScan;
uniform float uScanPeriod;
uniform float uWobble;
uniform float uBright;
uniform float uContrast;
uniform float uVig;
uniform vec4 uTears[${TUBE.maxTears}];
uniform int uTearN;
${SRC_FN}
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
void main() {
  vec2 uv = vUv;
  vec2 px = 1.0 / uRes;
  // Hold slip: the picture jumps vertically and wraps; dark seam.
  float seam = 0.0;
  if (uRoll > 0.0) {
    uv.y = fract(uv.y + uRoll);
    seam = 1.0 - smoothstep(0.0, 3.0 * px.y, abs(uv.y - fract(uRoll)) );
  }
  // Per-line jitter: every line lands a little off, differently each frame.
  float line = floor(uv.y * uRes.y);
  uv.x += (hash(vec2(line, uSeed)) - 0.5) * uLineJitter * px.x;
  // Tracking wobble: a band of horizontal drift crawling up the picture.
  float bandY = fract(uTime * 0.045);
  float dy = uv.y - bandY;
  dy -= floor(dy + 0.5);
  float band = exp(-dy * dy * 90.0);
  uv.x += uWobble * px.x * band * sin(uv.y * 38.0 + uTime * 2.3);
  // Tears: rows inside a band slip sideways and carry static.
  float tearA = 0.0;
  for (int i = 0; i < ${TUBE.maxTears}; i++) {
    if (i >= uTearN) break;
    vec4 t = uTears[i];
    float d = uv.y - t.x;
    if (d >= 0.0 && d < t.y) {
      uv.x += t.z;
      tearA = max(tearA, t.w);
    }
  }
  float l = luma(uv);
  // Ghost: a second image shifted right — the doubling.
  l = mix(l, luma(uv + vec2(uGhostDx, 0.0)), uGhost);
  // Bloom.
  l += texture2D(uBloom, uv).r * uBloomAmt;
  // Scanline mask — coarse enough to read at 1080, and brightness-neutral:
  // dark lines darker, bright lines brighter (Chris 2026-09-09 on 0.1.11:
  // tube "MUCH darker" — a subtract-only mask took a fifth of the light).
  float scan = 0.5 + 0.5 * cos(vUv.y * uRes.y * 6.2832 / uScanPeriod);
  l *= 1.0 - uScan * (scan - 0.5);
  // No static here (Chris 2026-09-09: "the visuals themselves are already
  // very mangled") — the desktop overlay carries the noise; a tear only
  // dims its band a touch so the slip reads.
  l *= 1.0 - tearA * 0.25;
  l *= 1.0 - seam * 0.85;
  // Grade + a flat vignette.
  l = (l - 0.5) * uContrast + 0.5;
  l *= uBright;
  vec2 q = uv - 0.5;
  l *= 1.0 - uVig * dot(q, q) * 1.8;
  gl_FragColor = vec4(vec3(clamp(l, 0.0, 1.0)), 1.0);
}`;

function compile(gl: WebGLRenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('shader alloc');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`shader: ${log}`);
  }
  return sh;
}

function program(gl: WebGLRenderingContext, fs: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error('program alloc');
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, VS));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
  return p;
}

interface Target {
  fb: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

function makeTarget(gl: WebGLRenderingContext, w: number, h: number): Target {
  const tex = gl.createTexture();
  const fb = gl.createFramebuffer();
  if (!tex || !fb) throw new Error('target alloc');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fb, tex, w, h };
}

type Source = HTMLVideoElement | HTMLImageElement | HTMLCanvasElement;

function sourceDims(el: Source): [number, number] {
  if (el instanceof HTMLVideoElement) return [el.videoWidth, el.videoHeight];
  if (el instanceof HTMLImageElement) return [el.naturalWidth, el.naturalHeight];
  return [el.width, el.height];
}
function sourceReady(el: Source): boolean {
  if (el instanceof HTMLVideoElement) return el.readyState >= 2 && el.videoWidth > 0;
  if (el instanceof HTMLImageElement) return el.complete && el.naturalWidth > 0;
  return el.width > 0;
}

export function TubeLayer({ children }: { children: ReactNode }) {
  const on = useTube((s) => s.on);
  const host = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!on) return;
    const canvas = canvasRef.current;
    const hostEl = host.current;
    if (!canvas || !hostEl) return;
    const gl = canvas.getContext('webgl', { alpha: false, antialias: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) {
      console.warn('[tube] no WebGL — plain visual');
      return;
    }
    let dead = false;
    let raf = 0;
    let tainted: Source | null = null;
    let uploadedEl: Source | null = null;
    let lastVideoTime = -1;
    let frame = 0;
    // The tube's own slips and hold rolls (Poisson; see TUBE).
    interface Slip {
      t0: number;
      dur: number;
      bands: Array<{ y: number; h: number; dx: number }>;
    }
    let slips: Slip[] = [];
    let roll: { t0: number; dur: number; amt: number } | null = null;
    let lastNow = 0;
    let onsetSeed = 0;
    let lastOnsetAt = -1;

    let pThr: WebGLProgram;
    let pBlur: WebGLProgram;
    let pFinal: WebGLProgram;
    try {
      pThr = program(gl, FS_THRESHOLD);
      pBlur = program(gl, FS_BLUR);
      pFinal = program(gl, FS_FINAL);
    } catch (err) {
      console.warn('[tube] shader failed — plain visual:', err);
      return;
    }
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const bindQuad = (p: WebGLProgram) => {
      gl.useProgram(p);
      const loc = gl.getAttribLocation(p, 'aPos');
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    };
    const u = (p: WebGLProgram, name: string) => gl.getUniformLocation(p, name);

    const srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    let W = 0;
    let H = 0;
    let bloomA: Target | null = null;
    let bloomB: Target | null = null;
    // Backing store: element size × device px × stage scale (the canvas
    // lives on the scaled stage) = device pixels, so the per-line effects
    // land on real lines. Capped only for huge pictures (see maxBacking).
    const resize = () => {
      const r = hostEl.getBoundingClientRect();
      const k = Math.min(3, (window.devicePixelRatio || 1) * useStage.getState().scale);
      let w = Math.max(2, Math.round((r.width / useStage.getState().scale) * k));
      let h = Math.max(2, Math.round((r.height / useStage.getState().scale) * k));
      const longest = Math.max(w, h);
      if (longest > TUBE.maxBacking) {
        w = Math.round((w * TUBE.maxBacking) / longest);
        h = Math.round((h * TUBE.maxBacking) / longest);
      }
      if (w === W && h === H) return;
      W = w;
      H = h;
      canvas.width = W;
      canvas.height = H;
      const bw = Math.max(2, Math.round(W / TUBE.bloomDiv));
      const bh = Math.max(2, Math.round(H / TUBE.bloomDiv));
      for (const t of [bloomA, bloomB]) {
        if (t) {
          gl.deleteFramebuffer(t.fb);
          gl.deleteTexture(t.tex);
        }
      }
      bloomA = makeTarget(gl, bw, bh);
      bloomB = makeTarget(gl, bw, bh);
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(hostEl);
    const unsubStage = useStage.subscribe(resize);

    const tearBuf = new Float32Array(TUBE.maxTears * 4);
    const cover = (sw: number, sh: number): [number, number] => {
      const ca = W / H;
      const sa = sw / sh;
      return sa > ca ? [ca / sa, 1] : [1, sa / ca];
    };

    let lastDraw = 0;
    const draw = (now: number) => {
      if (dead) return;
      raf = requestAnimationFrame(draw);
      // ~30 fps: fields, not frames — and half the shader cost.
      if (now - lastDraw < TUBE.minFrameMs) return;
      lastDraw = now;
      const src = hostEl.querySelector<Source>('video, img, canvas:not([data-tube])');
      if (!src || src === tainted || !sourceReady(src) || !bloomA || !bloomB) {
        // Nothing to draw over: let the source show through.
        canvas.style.opacity = '0';
        hostEl.style.setProperty('--tube-src-opacity', '1');
        return;
      }
      // Upload only when the source has a new frame: a video advances at its
      // own rate (24–30 fps) while this loop runs at the display's, and the
      // video→texture copy is the expensive step in WebKit. Images upload
      // once; a canvas (demo) every frame.
      let upload = true;
      if (src instanceof HTMLVideoElement) {
        upload = src !== uploadedEl || src.currentTime !== lastVideoTime;
        lastVideoTime = src.currentTime;
      } else if (src instanceof HTMLImageElement) {
        upload = src !== uploadedEl;
      }
      if (upload) {
        try {
          gl.bindTexture(gl.TEXTURE_2D, srcTex);
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
          uploadedEl = src;
        } catch (err) {
          tainted = src;
          console.warn('[tube] source not sampleable (CORS?) — plain visual for this clip:', err);
          return;
        }
      }
      if (frame === 0) console.info(`[tube] drawing ${W}x${H} from ${src.tagName.toLowerCase()} ${sourceDims(src).join('x')}`);
      canvas.style.opacity = '1';
      hostEl.style.setProperty('--tube-src-opacity', '0');
      frame++;

      const [sw, sh] = sourceDims(src);
      const [cx, cy] = cover(sw, sh);
      const sig = lastSignal();
      const quality = sig ? sig.quality : 1;
      const weak = 1 - quality;
      const env = reactive.env;
      const onsetAge = now - reactive.onsetAt;
      const onset = onsetAge < TUBE.onsetTearMs ? (1 - onsetAge / TUBE.onsetTearMs) * reactive.onsetAmp : 0;
      if (reactive.onsetAt !== lastOnsetAt) {
        lastOnsetAt = reactive.onsetAt;
        onsetSeed = Math.random();
      }

      // Bloom: threshold at quarter res, blur H then V.
      gl.viewport(0, 0, bloomA.w, bloomA.h);
      gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fb);
      bindQuad(pThr);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(u(pThr, 'uSrc'), 0);
      gl.uniform2f(u(pThr, 'uCover'), cx, cy);
      gl.uniform1f(u(pThr, 'uThr'), TUBE.bloomThreshold);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      bindQuad(pBlur);
      gl.uniform1i(u(pBlur, 'uTex'), 0);
      for (let pass = 0; pass < TUBE.bloomPasses; pass++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloomB.fb);
        gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
        gl.uniform2f(u(pBlur, 'uDir'), 1 / bloomA.w, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fb);
        gl.bindTexture(gl.TEXTURE_2D, bloomB.tex);
        gl.uniform2f(u(pBlur, 'uDir'), 0, 1 / bloomA.h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      const L = LEVELS[useLayout.getState().tubeLevel];
      // Schedule slips and rolls.
      const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0.03;
      lastNow = now;
      const slipRate = TUBE.slipRate * (1 + TUBE.slipRateWeak * weak) * L.slipRate;
      if (Math.random() < slipRate * dt) {
        const nb = 1 + Math.floor(Math.random() * 3);
        const bands = [];
        for (let i = 0; i < nb; i++) {
          const dir = Math.random() < 0.5 ? -1 : 1;
          bands.push({
            y: Math.random() * 0.92,
            h: 0.02 + Math.random() * 0.1,
            dx: dir * (TUBE.slipDxMin + Math.random() * (TUBE.slipDxMax - TUBE.slipDxMin)) * L.slipDx,
          });
        }
        slips.push({ t0: now, dur: TUBE.slipMsMin + Math.random() * (TUBE.slipMsMax - TUBE.slipMsMin), bands });
      }
      slips = slips.filter((sl) => now < sl.t0 + sl.dur);
      if (!roll && Math.random() < TUBE.rollRate * L.roll * dt) {
        roll = { t0: now, dur: TUBE.rollMsMin + Math.random() * (TUBE.rollMsMax - TUBE.rollMsMin), amt: Math.min(0.3, (TUBE.rollMin + Math.random() * (TUBE.rollMax - TUBE.rollMin)) * Math.sqrt(L.roll)) };
      }
      if (roll && now >= roll.t0 + roll.dur) roll = null;
      const rollAmt = roll ? roll.amt * (1 - ((now - roll.t0) / roll.dur) ** 2) : 0;

      // Tears: the tube's slips first, then the envelope's bands, then an onset.
      let n = 0;
      for (const sl of slips) {
        const env = 1 - (now - sl.t0) / sl.dur;
        for (const b of sl.bands) {
          if (n >= TUBE.maxTears) break;
          tearBuf.set([b.y, b.h, b.dx * (0.6 + 0.4 * env), 0.5 * env], n * 4);
          n++;
        }
      }
      if (sig) {
        for (const t of sig.tears) {
          if (n >= TUBE.maxTears) break;
          tearBuf.set([1 - t.y - t.h, t.h, t.dx * 2.5, t.a], n * 4);
          n++;
        }
      }
      if (onset > 0 && n < TUBE.maxTears) {
        tearBuf.set([onsetSeed * 0.9, 0.03 + onset * 0.08, (onsetSeed - 0.5) * 0.2 * onset, onset * 0.6], n * 4);
        n++;
      }

      // Final composite to the canvas.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      bindQuad(pFinal);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcTex);
      gl.uniform1i(u(pFinal, 'uSrc'), 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
      gl.uniform1i(u(pFinal, 'uBloom'), 1);
      gl.uniform2f(u(pFinal, 'uCover'), cx, cy);
      gl.uniform2f(u(pFinal, 'uRes'), W, H);
      gl.uniform1f(u(pFinal, 'uTime'), now / 1000);
      gl.uniform1f(u(pFinal, 'uSeed'), frame % 997);
      gl.uniform1f(u(pFinal, 'uLineJitter'), (TUBE.lineJitterPx + TUBE.lineJitterWeak * weak + TUBE.lineJitterLevel * env + onset * 4) * L.jitter * (W / 1000));
      gl.uniform1f(u(pFinal, 'uRoll'), rollAmt);
      gl.uniform1f(u(pFinal, 'uBloomAmt'), (TUBE.bloomRest + TUBE.bloomLevel * env) * L.bloom);
      gl.uniform1f(u(pFinal, 'uGhost'), Math.min(0.6, (TUBE.ghostRest + TUBE.ghostWeak * weak) * L.ghost));
      gl.uniform1f(u(pFinal, 'uGhostDx'), TUBE.ghostDx + TUBE.ghostDrift * Math.sin(now / 1000 * 0.37));
      gl.uniform1f(u(pFinal, 'uScan'), TUBE.scan + TUBE.scanWeak * weak);
      gl.uniform1f(u(pFinal, 'uScanPeriod'), TUBE.scanPeriodPx);
      gl.uniform1f(u(pFinal, 'uWobble'), (TUBE.wobblePx + TUBE.wobbleWeak * weak) * L.wobble * (W / 1000));
      gl.uniform1f(u(pFinal, 'uBright'), sig ? sig.brightness : 1);
      gl.uniform1f(u(pFinal, 'uContrast'), sig ? sig.contrast : 1);
      gl.uniform1f(u(pFinal, 'uVig'), TUBE.vignette);
      gl.uniform4fv(u(pFinal, 'uTears'), tearBuf);
      gl.uniform1i(u(pFinal, 'uTearN'), n);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    raf = requestAnimationFrame(draw);

    return () => {
      dead = true;
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsubStage();
      hostEl.style.setProperty('--tube-src-opacity', '1');
      for (const t of [bloomA, bloomB]) {
        if (t) {
          gl.deleteFramebuffer(t.fb);
          gl.deleteTexture(t.tex);
        }
      }
      gl.deleteTexture(srcTex);
      gl.deleteBuffer(quad);
      gl.deleteProgram(pThr);
      gl.deleteProgram(pBlur);
      gl.deleteProgram(pFinal);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [on]);

  return (
    <div ref={host} className="absolute inset-0 ns-tube-host" style={{ ['--tube-src-opacity' as string]: '1' }}>
      {/* the source: keeps playing under the tube at opacity 0 while it is
          being sampled; shows through when the tube has nothing to draw */}
      <div className="absolute inset-0" style={{ opacity: 'var(--tube-src-opacity)' as unknown as number }}>
        {children}
      </div>
      {on && <canvas ref={canvasRef} data-tube="1" className="absolute inset-0 w-full h-full block pointer-events-none" style={{ opacity: 0 }} />}
    </div>
  );
}
