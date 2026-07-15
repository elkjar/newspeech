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
// Default frame = 9:16 reel; --width/--height override for other formats
// (16:9 masters, 4K, …). Pages are viewport-driven so the look follows.
const DEFAULT_W = 1080;
const DEFAULT_H = 1920;

// ---- args ----------------------------------------------------------------
function parseArgs(argv) {
  const a = { page: '1-streaks', seconds: 8, fps: 30, seed: 1, scale: 2, width: DEFAULT_W, height: DEFAULT_H, out: 'reel.mp4', audio: null, gain: 1, state: null, preset: 'veryfast', jpeg: false, keepFrames: false, sourceAudio: false };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const v = argv[i + 1];
    if (k === '--page') { a.page = v; i++; }
    else if (k === '--seconds') { a.seconds = v === 'source' ? 'source' : parseFloat(v); i++; }
    else if (k === '--fps') { a.fps = parseInt(v, 10); i++; }
    else if (k === '--seed') { a.seed = parseInt(v, 10); i++; }
    else if (k === '--scale') { a.scale = parseFloat(v); i++; }
    else if (k === '--width') { a.width = parseInt(v, 10); i++; }
    else if (k === '--height') { a.height = parseInt(v, 10); i++; }
    else if (k === '--out') { a.out = v; i++; }
    else if (k === '--audio') { a.audio = v; i++; }
    else if (k === '--gain') { a.gain = parseFloat(v); i++; }
    else if (k === '--state') { a.state = v; i++; }
    else if (k === '--timeline') { a.timeline = v; i++; }
    else if (k === '--source') { a.source = v; i++; }
    else if (k === '--source-audio') { a.sourceAudio = true; }
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
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  // .mov/.m4v are ISO-BMFF like .mp4 — serve as video/mp4 so Chromium decodes
  // H.264-in-mov (it rejects a video/quicktime blob even when H.264 inside).
  '.mov': 'video/mp4',
  '.m4v': 'video/mp4',
};
// iPhone clips are `.MOV` (uppercase); MIME keys are lowercase.
const mimeFor = (p) => MIME[extname(p).toLowerCase()] || 'application/octet-stream';
// Source clips live outside the repo root; serve them only if allow-listed
// (populated from the segments' source paths) so we don't expose the FS.
const allowedSources = new Set();
function startServer() {
  return new Promise((res) => {
    const server = createServer(async (req, rq) => {
      try {
        // /source?p=<abs path> — a segment's source clip (allow-listed).
        if ((req.url || '').startsWith('/source')) {
          const p = new URL(req.url, 'http://x').searchParams.get('p');
          if (!p || !allowedSources.has(p)) { rq.writeHead(403).end(); return; }
          const s = await stat(p).catch(() => null);
          if (!s) { rq.writeHead(404).end(); return; }
          rq.writeHead(200, { 'content-type': mimeFor(p) });
          createReadStream(p).pipe(rq);
          return;
        }
        const url = decodeURIComponent((req.url || '/').split('?')[0]);
        const path = resolve(ROOT, '.' + url);
        if (!path.startsWith(ROOT)) { rq.writeHead(403).end(); return; }
        const s = await stat(path).catch(() => null);
        if (!s || s.isDirectory()) { rq.writeHead(404).end(); return; }
        rq.writeHead(200, { 'content-type': mimeFor(path) });
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

// Clip duration in seconds via ffprobe (for seconds:'source' segments).
function probeDuration(path) {
  return new Promise((res, rej) => {
    const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path]);
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', rej);
    p.on('close', (code) => {
      const d = parseFloat(out);
      if (code === 0 && d > 0) res(d);
      else rej(new Error('ffprobe could not read duration of ' + path));
    });
  });
}

// One long-lived ffmpeg: PNG frames arrive on stdin (image2pipe), optional
// audio is a second input, H.264 + lossless ALAC out. Encoding overlaps frame
// capture and nothing hits disk (no PNG sequence, no re-read pass).
function startFfmpegPipe(a, outPath, seconds, audioPath) {
  const args = ['-y', '-f', 'image2pipe', '-framerate', String(a.fps), '-i', 'pipe:0'];
  if (audioPath) args.push('-t', String(seconds), '-i', audioPath);
  args.push(
    '-map', '0:v',
    // No -shortest: reel length = the requested duration (the piped video), so a
    // shorter audio file ends early instead of truncating the whole render.
    // `1:a:0` = first audio stream of input 1 — works whether that input is a
    // bare audio file or a video clip we're lifting the audio off of (its video
    // streams stay unmapped; the composited frames already carry the picture).
    ...(audioPath ? ['-map', '1:a:0', '-c:a', 'alac'] : []),
    // Crop-to-even guard: fractional --scale × custom --width/--height can
    // land odd pixel dimensions, which yuv420p rejects. 1px trim at most.
    '-vf', 'crop=trunc(iw/2)*2:trunc(ih/2)*2',
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
  // A reel is a sequence of segments, each its own visualizer (HARD CUTS — all
  // rendered into one ffmpeg pipe, so a cut is just consecutive frames from
  // different pages). --timeline supplies { segments:[{page, seconds, state}] };
  // otherwise the single --page/--seconds/--state is one segment.
  let segments;
  if (a.timeline) {
    const tl = JSON.parse(await readFile(resolve(process.cwd(), a.timeline), 'utf8'));
    segments = tl.segments || [];
  } else {
    if (a.source) state = { ...(state || {}), source: a.source };
    segments = [{ page: a.page, seconds: a.seconds, state }];
  }
  if (!segments.length) { console.error('no segments to render'); process.exit(1); }
  // Resolve + allow-list each segment's source clip, and give it a served URL.
  for (const seg of segments) {
    const src = seg.state?.source;
    if (!src) continue;
    const abs = resolve(process.cwd(), src);
    seg.sourceAbs = abs;
    allowedSources.add(abs);
    seg.sourceUrl = `/source?p=${encodeURIComponent(abs)}`;
  }
  const VIDEO_SRC_RE = /\.(mp4|mov|webm|m4v)$/i;
  // seconds:'source' = run the segment for its source clip's full duration
  // (ffprobe). Works per segment, so a timeline can mix fixed and full-clip
  // lengths.
  for (const seg of segments) {
    if (seg.seconds !== 'source') continue;
    if (!seg.sourceAbs || !VIDEO_SRC_RE.test(seg.sourceAbs)) {
      console.error(`seconds=source needs a video source (segment ${seg.page})`);
      process.exit(1);
    }
    seg.seconds = await probeDuration(seg.sourceAbs);
  }
  const totalSeconds = segments.reduce((s, seg) => s + (seg.seconds || 0), 0);
  const totalFrames = Math.round(totalSeconds * a.fps);

  // Pick the audio track to analyse + mux. Normally a separate --audio file;
  // but with source-audio on we lift the audio straight off the video source
  // so the reel keeps the clip's own sound under the overlays. That only makes
  // sense for one continuous clip, so it's single-segment only — a hard-cut
  // timeline keeps using --audio.
  const wantSourceAudio = a.sourceAudio || state?.useSourceAudio;
  let audioPath = a.audio ? resolve(process.cwd(), a.audio) : null;
  let audioFromSource = false;
  if (wantSourceAudio && !a.timeline && segments.length === 1) {
    const srcAbs = segments[0].sourceAbs;
    if (srcAbs && VIDEO_SRC_RE.test(srcAbs)) { audioPath = srcAbs; audioFromSource = true; }
    else process.stdout.write('  source-audio requested but no video source — falling back\n');
  }

  // Feature track for the WHOLE timeline — audio-reactivity stays continuous
  // across cuts. --gain scales reactivity at feed time (no re-analysis).
  let features = null;
  if (audioPath) {
    process.stdout.write(`  analysing audio${audioFromSource ? ' (from source clip)' : ''}…`);
    try {
      features = await computeFeatures(audioPath, { fps: a.fps, seconds: totalSeconds });
      process.stdout.write(` ${features.length} frames of features\n`);
    } catch (err) {
      // A video with no audio track (or a decode failure) shouldn't kill the
      // render — drop to synthetic reactivity and mux no audio.
      process.stdout.write(` failed (${err.message || err}); rendering without audio\n`);
      features = null;
      audioPath = null;
    }
  }
  const featureAt = (gf) => {
    const f = features ? features[Math.min(gf, features.length - 1)] : syntheticFeature(gf, a.fps);
    if (a.gain === 1) return f;
    const g = (x) => clamp01(x * a.gain);
    return { level: g(f.level), low: g(f.low), mid: g(f.mid), high: g(f.high), onsets: f.onsets };
  };

  const server = await startServer();
  const port = server.address().port;
  const segNames = segments.map((s) => `${s.page}(${s.seconds}s)`).join(' · ');
  console.log(`[reel-render] ${segNames} → ${a.out}  (${totalFrames} frames @ ${a.fps}fps${audioPath ? `, audio ${audioFromSource ? '(from source)' : a.audio}` : ', synthetic'})`);

  // --scale renders each page at a smaller LOGICAL viewport (W/scale × H/scale)
  // with a matching deviceScaleFactor — elements are `scale`× bigger/legible,
  // captured frame still a crisp WxH. Pages are DPR-correct, so no page changes.
  // Round the logical viewport so output pixels (logical × scale) land even —
  // yuv420p rejects odd dimensions.
  const logicalW = Math.round(a.width / a.scale / 2) * 2;
  const logicalH = Math.round(a.height / a.scale / 2) * 2;
  // channel:'chromium' = the NEW headless mode (full browser, GPU video path).
  // The default headless SHELL decodes video with crushed levels (blacks
  // lifted ~0.07→0.10, whites 0.96→0.65 measured on a pool clip) — source
  // pages sample that luminance, so renders came out washed-out/brighter
  // than the studio preview. New headless matches headed decode exactly.
  const browser = await chromium.launch({ channel: 'chromium' });
  const page = await browser.newPage({ viewport: { width: logicalW, height: logicalH }, deviceScaleFactor: a.scale });
  await page.addInitScript(initScript(a.seed)); // re-applies on every navigation: clock/random/rAF reset per segment
  page.on('console', (m) => { if (m.type() === 'error') console.log('  [page error]', m.text()); });

  const outPath = resolve(process.cwd(), a.out);
  const ff = startFfmpegPipe(a, outPath, totalSeconds, audioPath); // one pipe across all segments
  const t0 = Date.now();
  let gf = 0; // global frame index (drives the continuous audio feed)
  for (const seg of segments) {
    await setupSegment(page, seg, port);
    const auto = (seg.state?.automation || []).slice().sort((x, y) => x.t - y.t);
    let ai = 0;
    const segFrames = Math.round((seg.seconds || 0) * a.fps);
    for (let i = 0; i < segFrames; i++) {
      const feat = featureAt(gf);
      const tMs = (i * 1000) / a.fps; // page clock is per-segment (each viz starts fresh at 0)
      const tSec = i / a.fps;
      // Source video: seek to the segment-local time (loops on clip length) and
      // wait for the frame before drawing — keeps it deterministic.
      if (seg.sourceUrl) await page.evaluate((t) => (window.__seekSource ? window.__seekSource(t) : null), tSec);
      const due = [];
      while (ai < auto.length && auto[ai].t <= tSec) due.push(auto[ai++]);
      await page.evaluate(
        ({ tMs, feat, due }) => {
          window.__setNow(tMs);
          if (window.Newspeech && window.Newspeech.setExternalAudio) window.Newspeech.setExternalAudio(feat);
          for (const ev of due) {
            const el = document.querySelector(ev.sel);
            if (!el) continue;
            if (ev.click) el.click();
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
      gf++;
      if (gf % a.fps === 0) {
        const rate = gf / Math.max(0.001, (Date.now() - t0) / 1000);
        process.stdout.write(`\r  rendering ${gf}/${totalFrames}  (${rate.toFixed(1)} fps)   `);
      }
    }
  }
  ff.proc.stdin.end();
  process.stdout.write(`\r  captured ${totalFrames} frames in ${((Date.now() - t0) / 1000).toFixed(1)}s — finishing encode…   \n`);

  await browser.close();
  server.close();
  await ff.done;
  console.log(`[reel-render] wrote ${outPath}`);
}

// Load a segment's visualizer into the reused page: navigate, inject the
// segment's globals (localStorage) + reload so they take, hide the chrome,
// apply tuned params, and pre-build the telemetry picker if the segment toggles
// it. The seed/clock/rAF init script re-runs on each navigation, so every
// segment's visualizer starts at virtual time 0.
async function setupSegment(page, seg, port) {
  await page.goto(`http://127.0.0.1:${port}/${seg.page}.html`, { waitUntil: 'load' });
  const ls = seg.state?.localStorage;
  if (ls && Object.keys(ls).length) {
    await page.evaluate((ls) => { try { for (const [k, v] of Object.entries(ls)) localStorage.setItem(k, v); } catch (_) {} }, ls);
    await page.reload({ waitUntil: 'load' });
  }
  await page.evaluate(() => document.fonts && document.fonts.ready).catch(() => {});
  await page.addStyleTag({ content: '#panel,#panel-handle,#audio-panel{display:none !important}' });
  if (seg.state?.params) {
    await page.evaluate((params) => {
      for (const [k, val] of Object.entries(params)) {
        const el = document.querySelector(`#panel [data-k="${k}"]`);
        if (!el) continue;
        el.value = val; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }, seg.state.params);
  }
  const auto = seg.state?.automation || [];
  if (auto.some((e) => e.sel && e.sel.includes('panel-picker'))) {
    await page.evaluate(() => { const p = document.querySelector('#panel .ns-pick'); if (p) p.click(); });
  }
  // Source-reliant pages: load the clip paused (we seek it per frame).
  if (seg.sourceUrl) {
    await page.evaluate(async (u) => { if (window.__loadSourceUrl) await window.__loadSourceUrl(u, { paused: true }); }, seg.sourceUrl);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
