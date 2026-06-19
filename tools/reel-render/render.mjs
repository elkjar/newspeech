#!/usr/bin/env node
// reel-render — offline visualizer → 1080x1920 mp4.
//
// Drives a real newspeech visualizer page (N-name.html) in headless Chromium,
// made DETERMINISTIC + frame-steppable by overriding three globals before any
// page script runs (Math.random → seeded PRNG, performance.now/Date.now →
// virtual clock, requestAnimationFrame → a controllable queue). Each frame we
// advance the virtual clock, feed audio features via Newspeech.setExternalAudio
// (the bridge core.js already exposes), flush exactly one rAF tick, and
// screenshot the 1080x1920 viewport. ffmpeg muxes the frames (+ audio later)
// into an mp4.
//
// SLICE 1 (this file): the feed is SYNTHETIC (a beat pulse) — it proves the
// headless+determinism+ffmpeg pipeline before real WAV analysis (slice 2).
//
// Usage:
//   node render.mjs --page 1-streaks --seconds 8 --fps 30 --seed 1 --out reel.mp4
import { chromium } from 'playwright';
import { computeFeatures } from './audio.mjs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, rm, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join, extname, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // repo root (where core.js + N-*.html live)
const W = 1080;
const H = 1920;

// ---- args ----------------------------------------------------------------
function parseArgs(argv) {
  const a = { page: '1-streaks', seconds: 8, fps: 30, seed: 1, scale: 2, out: 'reel.mp4', audio: null, gain: 1, state: null, preset: 'veryfast', jpeg: false, keepFrames: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--page') { a.page = v; i++; }
    else if (k === '--seconds') { a.seconds = parseFloat(v); i++; }
    else if (k === '--fps') { a.fps = parseInt(v, 10); i++; }
    else if (k === '--seed') { a.seed = parseInt(v, 10); i++; }
    else if (k === '--scale') { a.scale = parseFloat(v); i++; }
    else if (k === '--out') { a.out = v; i++; }
    else if (k === '--audio') { a.audio = v; i++; }
    else if (k === '--gain') { a.gain = parseFloat(v); i++; }
    else if (k === '--state') { a.state = v; i++; }
    else if (k === '--preset') { a.preset = v; i++; }
    else if (k === '--jpeg') { a.jpeg = true; }
    else if (k === '--keep-frames') { a.keepFrames = true; }
  }
  a.page = a.page.replace(/\.html$/, '');
  return a;
}

// ---- tiny static server (serves the repo root to headless Chromium) ------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};
function startServer() {
  return new Promise((res) => {
    const server = createServer(async (req, rq) => {
      try {
        const url = decodeURIComponent((req.url || '/').split('?')[0]);
        const path = resolve(ROOT, '.' + url);
        if (!path.startsWith(ROOT)) { rq.writeHead(403).end(); return; }
        const s = await stat(path).catch(() => null);
        if (!s || s.isDirectory()) { rq.writeHead(404).end(); return; }
        rq.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
        createReadStream(path).pipe(rq);
      } catch { rq.writeHead(500).end(); }
    });
    server.listen(0, '127.0.0.1', () => res(server));
  });
}

// ---- determinism + frame-stepping init script ----------------------------
// Runs BEFORE any page script. Seeds RNG, pins the clock, and replaces rAF
// with a queue we flush one tick at a time from Node.
function initScript(seed) {
  return `(() => {
    let _s = (${seed >>> 0}) >>> 0;
    Math.random = function () {
      _s = (_s + 0x6D2B79F5) | 0;
      let t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    let _now = 0;
    window.__setNow = (v) => { _now = v; };
    const P = window.performance || (window.performance = {});
    P.now = () => _now;
    Date.now = () => _now;
    const _q = new Map();
    let _id = 1;
    window.requestAnimationFrame = (cb) => { const id = _id++; _q.set(id, cb); return id; };
    window.cancelAnimationFrame = (id) => { _q.delete(id); };
    // Run every currently-queued callback once with the virtual timestamp.
    // Callbacks that re-queue (the per-page render loop) land in the next flush.
    window.__flushFrame = () => {
      const cbs = [..._q.values()];
      _q.clear();
      for (const cb of cbs) { try { cb(_now); } catch (e) { console.error('rAF cb error', e); } }
    };
  })();`;
}

// ---- SLICE 1: synthetic audio feed (a clear beat pulse) -------------------
const clamp01 = (v) => Math.max(0, Math.min(1, v));
function syntheticFeature(i, fps) {
  const t = i / fps;
  const beatLen = 0.5; // 120 BPM
  const ph = (t % beatLen) / beatLen;
  const env = Math.exp(-ph * 5);
  return {
    level: clamp01(0.22 + 0.62 * env + 0.08 * Math.sin(t * 1.7)),
    low: clamp01(0.25 + 0.65 * env),
    mid: clamp01(0.18 + 0.42 * Math.abs(Math.sin(t * 3.1))),
    high: clamp01(0.14 + 0.4 * Math.abs(Math.sin(t * 6.7 + 1))),
    onsets: { low: ph < 0.06, mid: false, high: (t * 4) % 1 < 0.04 },
  };
}

// One long-lived ffmpeg: PNG frames arrive on stdin (image2pipe), optional
// audio is a second input, H.264 + lossless ALAC out. Encoding overlaps frame
// capture and nothing hits disk (no PNG sequence, no re-read pass).
function startFfmpegPipe(a, outPath) {
  const args = ['-y', '-f', 'image2pipe', '-framerate', String(a.fps), '-i', 'pipe:0'];
  if (a.audio) args.push('-t', String(a.seconds), '-i', resolve(process.cwd(), a.audio));
  args.push(
    '-map', '0:v',
    ...(a.audio ? ['-map', '1:a', '-c:a', 'alac', '-shortest'] : []),
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', a.preset || 'veryfast',
    '-movflags', '+faststart', outPath,
  );
  const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  proc.stdin.on('error', () => {}); // ignore EPIPE if ffmpeg exits early
  const done = new Promise((res, rej) => {
    proc.on('error', rej);
    proc.on('close', (code) => (code === 0 ? res() : rej(new Error('ffmpeg exit ' + code))));
  });
  return { proc, done };
}
// Write a frame buffer, respecting backpressure so memory doesn't balloon if
// the encoder falls behind capture.
function writeFrame(ff, buf) {
  return new Promise((res) => {
    if (ff.proc.stdin.write(buf)) res();
    else ff.proc.stdin.once('drain', res);
  });
}

async function main() {
  const a = parseArgs(process.argv);
  // Tuned-state handoff from the studio: { localStorage:{k:v}, params:{dataK:val} }.
  // localStorage (globals: grid/grayscale/datapoints/…) is injected before load;
  // params (the visual knobs) are applied after load via the same slider-input
  // dispatch core.js uses for MIDI/external changes.
  let state = null;
  if (a.state) state = JSON.parse(await readFile(resolve(process.cwd(), a.state), 'utf8'));
  const totalFrames = Math.round(a.seconds * a.fps);

  // Feature track: real WAV analysis when --audio is given, else the synthetic
  // beat pulse. --gain scales reactivity at feed time (no re-analysis needed).
  let features = null;
  if (a.audio) {
    process.stdout.write('  analysing audio…');
    features = await computeFeatures(resolve(process.cwd(), a.audio), { fps: a.fps, seconds: a.seconds });
    process.stdout.write(` ${features.length} frames of features\n`);
  }
  const featureAt = (i) => {
    const f = features ? features[Math.min(i, features.length - 1)] : syntheticFeature(i, a.fps);
    if (a.gain === 1) return f;
    const g = (x) => clamp01(x * a.gain);
    return { level: g(f.level), low: g(f.low), mid: g(f.mid), high: g(f.high), onsets: f.onsets };
  };

  const server = await startServer();
  const port = server.address().port;
  const pageUrl = `http://127.0.0.1:${port}/${a.page}.html`;
  console.log(`[reel-render] ${a.page}.html → ${a.out}  (${totalFrames} frames @ ${a.fps}fps, seed ${a.seed}${a.audio ? `, audio ${a.audio}` : ', synthetic feed'})`);

  // --scale renders the page at a smaller LOGICAL viewport (W/scale × H/scale)
  // with a matching deviceScaleFactor, so the visualizer lays itself out as a
  // smaller "phone" screen — elements are `scale`× bigger and more legible —
  // while the captured frame is still a crisp WxH. The pages are DPR-correct
  // (canvas.width = cssSize·dpr, draw in CSS px), so no per-page changes.
  const logicalW = Math.round(W / a.scale);
  const logicalH = Math.round(H / a.scale);
  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: logicalW, height: logicalH },
    deviceScaleFactor: a.scale,
  });
  await page.addInitScript(initScript(a.seed));
  // Seed persisted globals (grid / grayscale / datapoints / …) before any page
  // script runs, so the page initialises with the studio-tuned values.
  if (state?.localStorage) {
    await page.addInitScript((ls) => {
      try { for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); } catch (_) {}
    }, state.localStorage);
  }
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); });
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  // Hide the on-screen control chrome (params panel + its handle + audio
  // dialog) so the render is clean. The telemetry / datapoints overlay
  // (#hud-overlay) is content and stays.
  await page.addStyleTag({ content: '#panel,#panel-handle,#audio-panel{display:none !important}' });
  // Apply the tuned visual knobs by driving the (now hidden) panel sliders —
  // same input/change dispatch core.js uses for MIDI, so params + onParamChange
  // side-effects fire exactly as in the studio preview.
  if (state?.params) {
    await page.evaluate((params) => {
      for (const [k, val] of Object.entries(params)) {
        const el = document.querySelector(`#panel [data-k="${k}"]`);
        if (!el) continue;
        el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, state.params);
  }

  // Performance automation (record-and-replay): timestamped control changes to
  // apply as the timeline plays — `{ t (sec), sel, value }` or `{ t, sel, click }`.
  const auto = (state?.automation || []).slice().sort((x, y) => x.t - y.t);
  let ai = 0;
  // If the performance toggles telemetry widgets, build the (hidden) picker once
  // so its pick-row click events have rows to actuate.
  if (auto.some((e) => e.sel && e.sel.includes('panel-picker'))) {
    await page.evaluate(() => { const p = document.querySelector('#panel .ns-pick'); if (p) p.click(); });
  }

  const outPath = resolve(process.cwd(), a.out);
  const ff = startFfmpegPipe(a, outPath); // encoder runs concurrently with capture
  const t0 = Date.now();
  for (let i = 0; i < totalFrames; i++) {
    const feat = featureAt(i);
    const tMs = (i * 1000) / a.fps;
    const tSec = i / a.fps;
    const due = [];
    while (ai < auto.length && auto[ai].t <= tSec) due.push(auto[ai++]);
    await page.evaluate(
      ({ tMs, feat, due }) => {
        window.__setNow(tMs);
        if (window.Newspeech && window.Newspeech.setExternalAudio) window.Newspeech.setExternalAudio(feat);
        // Apply any due automation events before drawing this frame.
        for (const ev of due) {
          const el = document.querySelector(ev.sel);
          if (!el) continue;
          if (ev.click) { el.click(); }
          else { el.value = ev.value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); }
        }
        window.__flushFrame();
      },
      { tMs, feat, due },
    );
    const buf = await page.screenshot(
      a.jpeg
        ? { type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: logicalW, height: logicalH } }
        : { clip: { x: 0, y: 0, width: logicalW, height: logicalH } },
    );
    await writeFrame(ff, buf);
    if (i % a.fps === 0) {
      const rate = i / Math.max(0.001, (Date.now() - t0) / 1000);
      process.stdout.write(`\r  rendering ${i}/${totalFrames}  (${rate.toFixed(1)} fps)   `);
    }
  }
  ff.proc.stdin.end();
  process.stdout.write(`\r  captured ${totalFrames} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s — finishing encode…   \n`);

  await browser.close();
  server.close();
  await ff.done;
  console.log(`[reel-render] wrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
