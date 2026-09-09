// The tube — BROADCAST's WebGL treatment of the visual, for runs that go
// straight to a screen capture with no CRT in the chain (Chris 2026-09-09:
// "making the glitchy style stuff within OpenGL … having the best version
// possible for that does still make sense"). FLAT — no curvature (Chris:
// "we can do it flat and just focus on the tear / shimmer / bloom etc.").
//
// What it does, all monochrome (the site is mono; no colour fringing):
//   - tears: the signal envelope's tear bands (signal.ts) displace source
//     rows sideways and fill with static; an onset adds a band of its own;
//   - interlace shimmer: alternate lines shift half a pixel, the parity
//     flipping every frame; a sub-pixel field jitter rides weak reception;
//   - bloom: bright areas bleed — quarter-res threshold + two separable
//     gaussian passes, added back; opens up with level;
//   - ghost: a faint offset echo of the picture (signal ringing);
//   - scanline mask, static (half the overlay's weight — the overlay covers
//     the whole desktop already), brightness/contrast from the envelope, a
//     mild flat vignette.
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
import { useStage } from './layout';

export const useTube = create<{ on: boolean }>(() => ({ on: false }));
export function setTubeEnabled(on: boolean): void {
  if (useTube.getState().on !== on) useTube.setState({ on });
}

// Strengths. Tuned by eye on the demo; Chris tunes by eye on a run.
const TUBE = {
  shimmerPx: 0.7, // interlace half-shift at rest (px, canvas)
  shimmerWeak: 1.6, // + per unit weak reception
  shimmerLevel: 0.9, // + per unit level
  jitterWeak: 1.4, // field jitter px per unit weak
  bloomThreshold: 0.58,
  bloomRest: 0.32,
  bloomLevel: 0.55, // + per unit level
  ghostRest: 0.12,
  ghostWeak: 0.45,
  ghostDx: 0.011, // fraction of width
  scan: 0.24,
  scanWeak: 0.25,
  noiseScale: 0.5, // × overlay static
  vignette: 0.2,
  onsetTearMs: 170,
  maxTears: 6,
  bloomDiv: 4, // bloom buffers at 1/4 res
  // Longest side of the canvas backing store. The backing store is meant to
  // be 1:1 with device pixels — the interlace and scanline mask are per
  // line, and a resampled 1-px mask aliases into moiré — so this only bites
  // on a backdrop over a very large display.
  maxBacking: 3072,
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
uniform float uField;
uniform float uShimmer;
uniform float uJitter;
uniform float uBloomAmt;
uniform float uGhost;
uniform float uGhostDx;
uniform float uScan;
uniform float uNoise;
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
  // Interlace: alternate lines, parity flipping per frame; field jitter.
  float line = floor(uv.y * uRes.y);
  float odd = mod(line + uField, 2.0);
  uv.x += (odd * 2.0 - 1.0) * uShimmer * px.x;
  uv.y += uJitter * px.y;
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
  // Ghost: a faint echo shifted right.
  l = mix(l, luma(uv + vec2(uGhostDx, 0.0)), uGhost * 0.5);
  // Bloom.
  l += texture2D(uBloom, uv).r * uBloomAmt;
  // Scanline mask.
  l *= 1.0 - uScan * odd * 0.4;
  // Static: fine, mono, heavier in a tear.
  float n = hash(uv * uRes + vec2(fract(uTime * 0.731) * 917.0, fract(uTime * 0.377) * 613.0));
  l = mix(l, n, min(0.9, uNoise * 0.35 + tearA * 0.55));
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
    let frame = 0;
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

    const draw = (now: number) => {
      if (dead) return;
      raf = requestAnimationFrame(draw);
      const src = hostEl.querySelector<Source>('video, img, canvas:not([data-tube])');
      if (!src || src === tainted || !sourceReady(src) || !bloomA || !bloomB) {
        // Nothing to draw over: let the source show through.
        canvas.style.opacity = '0';
        hostEl.style.setProperty('--tube-src-opacity', '1');
        return;
      }
      try {
        gl.bindTexture(gl.TEXTURE_2D, srcTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      } catch (err) {
        tainted = src;
        console.warn('[tube] source not sampleable (CORS?) — plain visual for this clip:', err);
        return;
      }
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
      for (let pass = 0; pass < 2; pass++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloomB.fb);
        gl.bindTexture(gl.TEXTURE_2D, bloomA.tex);
        gl.uniform2f(u(pBlur, 'uDir'), 1 / bloomA.w, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindFramebuffer(gl.FRAMEBUFFER, bloomA.fb);
        gl.bindTexture(gl.TEXTURE_2D, bloomB.tex);
        gl.uniform2f(u(pBlur, 'uDir'), 0, 1 / bloomA.h);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }

      // Tears: the envelope's bands, plus one from an onset.
      let n = 0;
      if (sig) {
        for (const t of sig.tears) {
          if (n >= TUBE.maxTears) break;
          tearBuf.set([1 - t.y - t.h, t.h, t.dx, t.a], n * 4);
          n++;
        }
      }
      if (onset > 0 && n < TUBE.maxTears) {
        tearBuf.set([onsetSeed * 0.9, 0.02 + onset * 0.06, (onsetSeed - 0.5) * 0.08 * onset, onset * 0.6], n * 4);
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
      gl.uniform1f(u(pFinal, 'uField'), frame % 2);
      gl.uniform1f(u(pFinal, 'uShimmer'), (TUBE.shimmerPx + TUBE.shimmerWeak * weak + TUBE.shimmerLevel * env) * (W / 1000));
      const jit = weak > 0.02 ? (Math.random() - 0.5) * 2 * TUBE.jitterWeak * weak * (H / 600) : 0;
      gl.uniform1f(u(pFinal, 'uJitter'), jit + onset * (Math.random() - 0.5) * 3);
      gl.uniform1f(u(pFinal, 'uBloomAmt'), TUBE.bloomRest + TUBE.bloomLevel * env);
      gl.uniform1f(u(pFinal, 'uGhost'), TUBE.ghostRest + TUBE.ghostWeak * weak);
      gl.uniform1f(u(pFinal, 'uGhostDx'), TUBE.ghostDx);
      gl.uniform1f(u(pFinal, 'uScan'), TUBE.scan + TUBE.scanWeak * weak);
      gl.uniform1f(u(pFinal, 'uNoise'), (sig ? sig.noise : 0) * TUBE.noiseScale);
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
