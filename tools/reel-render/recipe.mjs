#!/usr/bin/env node
// recipe — batch reels from one JSON file, no studio.
//
// A recipe lists reels (audio + a visual plan); each becomes a timeline that
// render.mjs renders. One file lands in outDir per reel (<name>.mp4, H.264 +
// AAC — Instagram-safe; never overwritten — a re-render becomes <name>-v2.mp4); timelines + contact sheets (to check a reel without
// opening it) go to a work dir in $TMPDIR, printed at the end.
//
// Usage:
//   node recipe.mjs <recipe.json> [--only <name-substring>] [--jobs 2] [--dry]
//
// Recipe shape (paths: ~ ok; relative = relative to the recipe file):
// {
//   "outDir": "~/Desktop/reels",
//   "base": { "fps": 30, "scale": 2, "seed": 7, "gain": 1, "width": 1080, "height": 1920,
//             "allowText": false,   // true = also pick clips with on-screen text
//                                   // (textscan.mjs; skipped by default)
//             "minLuma": 35,        // random clips' mean luma floor (0–255); raise it
//                                   // (~70) under high contrast, which crushes dim clips
//             "globals": { "haze": 0.35, "grain": 0, ... } },   // site-wide panel globals
//   "avoid": ["dead-ocean-teasers.json"],  // optional: don't reuse source clips another
//                                          // recipe (rendered on this machine) placed
//   "exclude": ["snap_7444.mp4"],          // optional: pool clips never to pick (title
//                                          // cards, near-stills, ones that looked bad)
//   "reels": [{
//     "name": "2-degrees-A",
//     "audio": "~/Desktop/clip.wav",
//     "seconds": 15,                 // default: the audio's duration
//     "cuts": "auto" | [5.2, 9.8],   // optional: segment boundaries. "auto" = the
//                                    // N-1 biggest loudness jumps for N segments
//     "page": "21-mosh", "params": {...},  // defaults for every segment below
//     "sections": [{ "from": 60, "page"?: "26-topo", "params": {...} }],  // by song position —
//                                    // a segment takes the last section starting
//                                    // at or before its own start (full songs)
//     "segments": "auto" | 3 | [{    // a number = that many segments of the reel's
//                                    // page, each on its own random source clip;
//                                    // "auto" = cut on every loudness change of at
//                                    // least minJump dB (default 4), then fill so no
//                                    // segment runs past maxSegment s (default 8 =
//                                    // a pool clip, so nothing visibly loops)
//       "page": "17-flare",          // or "look": "<name from looks.json>"
//       "params": { "audioBoost": 1.4 },
//       "globals": { "gridStyle": "dots" },   // per-segment overrides of base.globals
//       "source": "random" | "<path>",        // source pages only; random = a pool
//                                              // clip that isn't black for this segment
//       "seconds": 5                  // only without "cuts"; last segment = remainder
//     }]
//   }]
// }
//
// globals keys (→ newspeech.* localStorage): grayscale (bool), contrast,
// gridStyle (off|dots|grid|topo), gridOpacity, haze, grain, dataPoints,
// telemetry (false | [types] | "random" = 1–3 widgets, seeded, same per reel).
import { spawn, execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, dirname, join, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scanPool, hasText } from './textscan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const POOL = join(homedir(), 'Documents', 'newspeech-visuals');

const args = { recipe: null, only: null, jobs: 2, dry: false };
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i], v = process.argv[i + 1];
  if (k === '--only') { args.only = v; i++; }
  else if (k === '--jobs') { args.jobs = Math.max(1, parseInt(v, 10)); i++; }
  else if (k === '--dry') args.dry = true;
  else if (!args.recipe) args.recipe = k;
}
if (!args.recipe) { console.error('usage: node recipe.mjs <recipe.json> [--only name] [--jobs 2] [--dry]'); process.exit(1); }

const recipePath = resolve(process.cwd(), args.recipe);
const recipeDir = dirname(recipePath);
const expand = (p) => resolve(recipeDir, p.replace(/^~(?=\/|$)/, homedir()));
const recipe = JSON.parse(await readFile(recipePath, 'utf8'));
const base = { fps: 30, scale: 2, seed: 7, gain: 1, width: 1080, height: 1920, ...(recipe.base || {}) };
const outDir = expand(recipe.outDir || '~/Desktop/reels');
const work = join(tmpdir(), 'reel-recipe', basename(recipePath, '.json'));
await mkdir(outDir, { recursive: true });
await mkdir(work, { recursive: true });

// ---- helpers ---------------------------------------------------------------
const run = (cmd, argv, opts = {}) => new Promise((res, rej) => {
  const p = spawn(cmd, argv, { stdio: opts.quiet ? 'ignore' : 'inherit' });
  p.on('error', rej);
  p.on('close', (c) => (c === 0 ? res() : rej(new Error(`${cmd} exit ${c}`))));
});
const probeDuration = (p) => parseFloat(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', p]).toString());

// Seeded PRNG (mulberry32) so "random" picks are repeatable per recipe seed.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// Loudness at 20Hz (dB) — the basis for auto cuts.
function loudness(audio, seconds) {
  const sr = 8000, hop = sr / 20;
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-t', String(seconds), '-i', audio, '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  const x = new Float32Array(buf.buffer, buf.byteOffset, buf.length / 4);
  const db = [];
  for (let i = 0; i + hop <= x.length; i += hop) {
    let s = 0;
    for (let j = i; j < i + hop; j++) s += x[j] * x[j];
    db.push(20 * Math.log10(Math.sqrt(s / hop) + 1e-9));
  }
  return db; // index / 20 = seconds
}

// The n biggest loudness changes (mean of the next 0.5s vs the previous 1s) —
// hits AND drop-outs — at least 2.5s apart and 2s from either end, so cuts land
// where the music turns. Rises outrank equal-sized drops.
function changeScores(audio, seconds) {
  const db = loudness(audio, seconds);
  const mean = (a, b) => { let s = 0, c = 0; for (let i = Math.max(0, a); i < Math.min(db.length, b); i++) { s += db[i]; c++; } return c ? s / c : -90; };
  const scored = [];
  for (let i = 40; i < db.length - 40; i++) { const d = mean(i, i + 10) - mean(i - 20, i); scored.push({ t: i / 20, jump: d > 0 ? d : -d * 0.8 }); }
  return scored;
}
function autoCuts(audio, seconds, n) {
  if (n <= 0) return [];
  const scored = changeScores(audio, seconds).sort((a, b) => b.jump - a.jump);
  const picked = [];
  for (const c of scored) {
    if (picked.length === n) break;
    if (picked.every((p) => Math.abs(p.t - c.t) >= 2.5)) picked.push(c);
  }
  // Too few strong changes (flat audio) → fill with even splits.
  for (let k = 1; picked.length < n; k++) picked.push({ t: (seconds * k) / (n + 1) });
  return picked.map((p) => p.t).sort((a, b) => a - b);
}

// Open-ended cuts for long audio: every change of at least minJump dB (2.5s
// apart), then any gap still longer than maxSegment gets split at its strongest
// change — steady stretches keep moving without cutting off the beat entirely.
// `forced` times (section starts) always get a cut, snapped to the strongest
// change within ±1s — the sections ARE the song's structure.
function musicCuts(audio, seconds, { minJump = 4, maxSegment = 8, minGap = 2.5, forced = [] } = {}) {
  const scored = changeScores(audio, seconds);
  const cuts = [];
  for (const f of forced) {
    let best = null;
    for (const c of scored) if (Math.abs(c.t - f) <= 1 && (!best || c.jump > best.jump)) best = c;
    const t = best ? best.t : f;
    if (t > minGap && t < seconds - minGap && cuts.every((x) => Math.abs(x - t) >= minGap)) cuts.push(t);
  }
  for (const c of [...scored].sort((a, b) => b.jump - a.jump)) {
    if (c.jump < minJump) break;
    if (cuts.every((t) => Math.abs(t - c.t) >= minGap)) cuts.push(c.t);
  }
  for (;;) {
    const edges = [0, ...cuts.sort((a, b) => a - b), seconds];
    let gap = -1;
    for (let i = 1; i < edges.length; i++) if (edges[i] - edges[i - 1] > maxSegment) { gap = i; break; }
    if (gap < 0) return cuts;
    const [a, b] = [edges[gap - 1], edges[gap]];
    let best = null;
    for (const c of scored) if (c.t > a + minGap && c.t < b - minGap && (!best || c.jump > best.jump)) best = c;
    cuts.push(best ? best.t : (a + b) / 2);
  }
}

// Mean luma per sampled frame (2/s) of a clip, measured once per clip and cached;
// a segment reads the first `seconds` of it, looping like the renderer does.
const lumaCache = new Map();
function clipLuma(clip) {
  if (!lumaCache.has(clip)) {
    const out = execFileSync('ffmpeg', ['-v', 'error', '-i', clip,
      '-vf', 'fps=2,scale=64:-2,signalstats,metadata=print:key=lavfi.signalstats.YAVG:file=-', '-f', 'null', '-'], { maxBuffer: 1 << 24 }).toString();
    lumaCache.set(clip, [...out.matchAll(/YAVG=([\d.]+)/g)].map((m) => parseFloat(m[1])));
  }
  return lumaCache.get(clip);
}
// Rejects clips that are black (or blown out to white) where the segment would use them.
function lumaOK(clip, seconds, minMean = 35) {
  const all = clipLuma(clip);
  if (!all.length) return false;
  const ys = Array.from({ length: Math.max(1, Math.ceil(seconds * 2)) }, (_, i) => all[i % all.length]);
  const dark = ys.filter((y) => y < 20).length / ys.length;
  const blown = ys.filter((y) => y > 215).length / ys.length;
  const mean = ys.reduce((s, y) => s + y, 0) / ys.length;
  return dark <= 0.2 && blown <= 0.2 && mean > minMean && mean < 190;
}

let poolClips = null;
const banned = new Set((recipe.exclude || []).map((name) => join(POOL, name))); // never picked
const used = new Set(); // clips already placed — avoided while fresh ones remain
// …including clips sibling recipes placed: their rendered timelines sit in the shared work root.
for (const other of recipe.avoid || []) {
  const dir = join(tmpdir(), 'reel-recipe', basename(other, '.json'));
  const files = existsSync(dir) ? (await readdir(dir)).filter((f) => f.endsWith('.timeline.json')) : [];
  if (!files.length) console.warn(`  avoid: no rendered timelines for ${other} (render it first) — not excluding its clips`);
  for (const f of files) for (const seg of JSON.parse(await readFile(join(dir, f), 'utf8')).segments) if (seg.state?.source) used.add(seg.state.source);
}
// Fresh clips first. Once the pool's usable clips run out (full songs need ~90),
// reuse one — but never one from the same reel's last 12 segments.
let reused = 0;
async function pickSource(rand, seconds, recent) {
  if (!poolClips) {
    // Clips with on-screen text never get picked (Chris sets typography over these);
    // new pool clips are scanned on first use. base.allowText opts out.
    const scan = base.allowText ? {} : await scanPool(POOL);
    poolClips = (await readdir(POOL)).filter((f) => /\.mp4$/i.test(f) && !f.startsWith('_') && !(scan[f] && hasText(scan[f]))).sort().map((f) => join(POOL, f));
  }
  const near = new Set(recent.slice(-12));
  for (const fresh of [true, false]) {
    for (let tries = 0; tries < 400; tries++) {
      const clip = poolClips[Math.floor(rand() * poolClips.length)];
      if (banned.has(clip) || near.has(clip) || (fresh && used.has(clip))) continue;
      if (lumaOK(clip, seconds, base.minLuma)) {
        if (!fresh) reused++;
        used.add(clip); recent.push(clip); return clip;
      }
    }
  }
  throw new Error('no usable pool clip (check minLuma / exclude)');
}

const TELEMETRY_TYPES = ['scope', 'hex', 'coords', 'tunnel', 'profile', 'events', 'radar', 'bands', 'xfer', 'waveform', 'vector'];
function randomTelemetry(rand) {
  const pool = [...TELEMETRY_TYPES], out = [];
  const n = 1 + Math.floor(rand() * 3);
  while (out.length < n) out.push(pool.splice(Math.floor(rand() * pool.length), 1)[0]);
  return out;
}

function globalsToLocalStorage(g = {}) {
  const ls = {};
  if (g.grayscale != null) ls['newspeech.grayscale'] = g.grayscale ? '1' : '0';
  for (const k of ['contrast', 'gridStyle', 'gridOpacity', 'haze', 'grain', 'dataPoints'])
    if (g[k] != null) ls[`newspeech.${k}`] = String(g[k]);
  if (g.telemetry != null) ls['newspeech.telemetryEnabled'] = JSON.stringify(g.telemetry === false ? [] : g.telemetry);
  return ls;
}

const looksPath = join(HERE, 'looks.json');
const looks = existsSync(looksPath) ? JSON.parse(await readFile(looksPath, 'utf8')) : [];

// ---- build each reel's timeline ----------------------------------------------
async function buildTimeline(reel, idx) {
  const audio = expand(reel.audio);
  const seconds = reel.seconds ?? probeDuration(audio);
  let bounds;
  if (reel.segments === 'auto') bounds = musicCuts(audio, seconds, { ...reel, forced: (reel.sections || []).map((x) => x.from).filter((t) => t > 0) });
  const count = bounds ? bounds.length + 1 : reel.segments;
  const segs = (typeof count === 'number' ? Array.from({ length: count }, () => ({ source: 'random' })) : reel.segments || [])
    .map((s) => ({ page: reel.page, ...s, own: s.params || {}, params: { ...(reel.params || {}), ...(s.params || {}) } }));
  if (!segs.length) throw new Error(`${reel.name}: no segments`);

  if (bounds) { /* "segments": "auto" placed them */ }
  else if (reel.cuts === 'auto') bounds = autoCuts(audio, seconds, segs.length - 1);
  else if (Array.isArray(reel.cuts)) bounds = reel.cuts;
  if (bounds && bounds.length !== segs.length - 1) throw new Error(`${reel.name}: ${segs.length} segments need ${segs.length - 1} cuts`);
  // Snap cuts to frames so segment frame counts sum exactly to the reel.
  const snap = (t) => Math.round(t * base.fps) / base.fps;
  const lengths = bounds
    ? [0, ...bounds.map(snap), seconds].slice(1).map((t, i, a) => +(t - (i ? a[i - 1] : 0)).toFixed(4))
    : segs.map((s, i) => s.seconds ?? +(seconds - segs.slice(0, i).reduce((x, y) => x + (y.seconds || 0), 0)).toFixed(4));

  const rand = rng((base.seed * 7919 + idx * 104729) >>> 0);
  const globals = { ...(base.globals || {}) };
  if (globals.telemetry === 'random') globals.telemetry = randomTelemetry(rand);
  const segments = [];
  const recent = []; // this reel's clips, newest last
  const sections = (reel.sections || []).slice().sort((a, b) => a.from - b.from);
  let start = 0;
  for (const [i, s] of segs.entries()) {
    // +1s: a section's cut can snap up to 1s early onto the music (musicCuts).
    const sec = sections.filter((x) => x.from <= start + 1.001).pop();
    // A section can switch effect; the reel's params belong to the reel's page,
    // so a different page starts from its own defaults.
    // Precedence: segment's own params > section > reel.
    if (sec?.page && sec.page !== s.page) { s.page = sec.page; s.params = { ...(sec.params || {}), ...s.own }; }
    else if (sec) s.params = { ...s.params, ...(sec.params || {}), ...s.own };
    start += lengths[i];
    const look = s.look ? looks.find((l) => l.name === s.look) : null;
    if (s.look && !look) throw new Error(`${reel.name}: no look named "${s.look}" in looks.json`);
    const state = structuredClone(look?.state || {});
    state.params = { ...(state.params || {}), ...(s.params || {}) };
    state.localStorage = { ...(state.localStorage || {}), ...globalsToLocalStorage({ ...globals, ...(s.globals || {}) }) };
    if (s.source === 'random') state.source = await pickSource(rand, lengths[i], recent);
    else if (s.source) state.source = expand(s.source);
    segments.push({ page: s.page || look?.page, seconds: lengths[i], state });
  }
  return { audio, seconds, segments };
}

// ---- render ------------------------------------------------------------------
// Never overwrite a delivered reel — Chris edits from earlier versions. A re-render
// lands as <name>-v2.mp4, -v3, … (the first stays <name>.mp4).
function nextFree(name) {
  if (!existsSync(join(outDir, `${name}.mp4`))) return name;
  for (let v = 2; ; v++) if (!existsSync(join(outDir, `${name}-v${v}.mp4`))) return `${name}-v${v}`;
}

async function renderReel(reel, tl) {
  const name = nextFree(reel.name);
  const tlPath = join(work, `${name}.timeline.json`);
  await writeFile(tlPath, JSON.stringify({ segments: tl.segments }, null, 2) + '\n');
  const mp4 = join(work, `${name}.alac.mp4`);
  await run('node', [join(HERE, 'render.mjs'), '--timeline', tlPath, '--audio', tl.audio, '--out', mp4,
    '--fps', String(base.fps), '--scale', String(base.scale), '--seed', String(base.seed), '--gain', String(base.gain),
    '--width', String(base.width), '--height', String(base.height), '--jpeg'], { quiet: args.jobs > 1 });
  // render.mjs muxes ALAC, which Instagram may reject — deliver AAC.
  await run('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', join(outDir, `${name}.mp4`)]);
  // Contact sheet: 10 evenly spaced frames (5×2) for a short reel; for long
  // ones roughly one per 7.5s, up to 60 (10 across).
  const n = Math.min(60, Math.max(10, Math.round(tl.seconds / 7.5)));
  const cols = n <= 10 ? 5 : 10;
  await run('ffmpeg', ['-v', 'error', '-y', '-i', mp4, '-vf', `fps=${n}/${tl.seconds},scale=216:-2,tile=${cols}x${Math.ceil(n / cols)}:padding=4`, '-frames:v', '1', join(work, `${name}-sheet.jpg`)]);
  return name;
}

// Plan every reel even under --only, so random source picks (seeded per reel,
// no repeats recipe-wide) come out the same as a full run.
const plans = [];
for (const [i, reel] of (recipe.reels || []).entries()) {
  const tl = await buildTimeline(reel, i);
  if (args.only && !reel.name.includes(args.only)) continue;
  let t = 0;
  const desc = tl.segments.map((s) => { const d = `${t.toFixed(2)}s ${s.page}${s.state.source ? ` [${s.state.source.split('/').pop()}]` : ''}`; t += s.seconds; return d; }).join(' | ');
  console.log(`${reel.name}: ${desc}`);
  plans.push({ reel, tl });
}
if (reused) console.log(`  (${reused} clip(s) reused — the usable pool ran out of fresh ones)`);
if (args.dry) process.exit(0);

let next = 0, failed = 0;
const t0 = Date.now();
await Promise.all(Array.from({ length: Math.min(args.jobs, plans.length) }, async () => {
  while (next < plans.length) {
    const { reel, tl } = plans[next++];
    const s = Date.now();
    try { const name = await renderReel(reel, tl); console.log(`  ✓ ${name} (${((Date.now() - s) / 1000).toFixed(0)}s)`); }
    catch (e) { failed++; console.error(`  ✗ ${reel.name}: ${e.message}`); }
  }
}));
console.log(`[recipe] ${plans.length - failed}/${plans.length} reels → ${outDir}  (${((Date.now() - t0) / 1000).toFixed(0)}s; sheets + timelines in ${work})`);
if (failed) process.exit(1);
