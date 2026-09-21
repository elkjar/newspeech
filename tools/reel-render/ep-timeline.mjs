#!/usr/bin/env node
// ep-timeline — the EP listening room and the EP videos read ONE config.
//
// assets/ep/<ep>.json pairs each track with a visualizer page + tuned params
// (the same {page, state:{params}} shape reel-render segments use). This
// turns each track into a single-segment timeline the length of the track and
// prints the render.mjs command that muxes the FLAC under it, so the video of
// a track is exactly what night-school.html shows while it plays.
//
// Usage:
//   node ep-timeline.mjs [--ep assets/ep/night-school.json] [--track <slug>]
//                        [--out out/] [--width 1920 --height 1080] [--fps 30]
//   → out/<slug>.timeline.json per track + one render command per track
//
// Pairings live in the JSON (page per track, ep.default as the fallback);
// per-track params go in state.params in the same shape. Then run the
// printed commands.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');

const a = { ep: 'assets/ep/night-school.json', track: null, out: 'out', width: 1920, height: 1080, fps: 30 };
const argv = process.argv;
for (let i = 2; i < argv.length; i++) {
  const k = argv[i], v = argv[i + 1];
  if (k === '--ep') { a.ep = v; i++; }
  else if (k === '--track') { a.track = v; i++; }
  else if (k === '--out') { a.out = v; i++; }
  else if (k === '--width') { a.width = parseInt(v, 10); i++; }
  else if (k === '--height') { a.height = parseInt(v, 10); i++; }
  else if (k === '--fps') { a.fps = parseInt(v, 10); i++; }
}

const epPath = resolve(ROOT, a.ep);
const ep = JSON.parse(await readFile(epPath, 'utf8'));
const outDir = resolve(process.cwd(), a.out);
await mkdir(outDir, { recursive: true });

const tracks = ep.tracks.filter((t) => !a.track || t.slug === a.track);
if (!tracks.length) { console.error(`no track "${a.track}" in ${a.ep}`); process.exit(1); }

for (const t of tracks) {
  if (!t.duration) { console.error(`${t.slug}: no duration in config — ffprobe the flac and add it`); continue; }
  const state = { ...(t.state || {}) };
  // the page's tempo clock is a global (localStorage) in core.js; carry it into
  // the render only when the listening room would also run it.
  if (t.beat && t.bpm) state.localStorage = { ...(state.localStorage || {}), 'newspeech.bpm': String(t.bpm) };
  // the room's quiet layer, as the page globals reel-render can set (its
  // headless profile is throwaway, so persisting there is fine). dim is frame
  // opacity in the room — not representable here; darken the mp4 in post or
  // fold it into the params if a pairing needs it.
  const q = ep.quiet || {};
  const ls = { ...(state.localStorage || {}) };
  if (q.haze != null) ls['newspeech.haze'] = String(q.haze);
  if (q.grain != null) ls['newspeech.grain'] = String(q.grain);
  if (q.dataPoints != null) ls['newspeech.dataPoints'] = String(q.dataPoints);
  if (q.telemetry === false) ls['newspeech.telemetryEnabled'] = '[]';
  if (Object.keys(ls).length) state.localStorage = ls;
  const timeline = { segments: [{ page: t.page, seconds: t.duration, state }] };
  const tlPath = resolve(outDir, `${t.slug}.timeline.json`);
  await writeFile(tlPath, JSON.stringify(timeline, null, 2) + '\n');
  const audio = resolve(ROOT, ep.audioBase || 'assets/ep/', t.file);
  const mp4 = resolve(outDir, `${t.slug}-${a.width}x${a.height}.mp4`);
  const rel = (p) => relative(process.cwd(), p) || '.';
  console.log(`# ${t.title} — ${t.page} — ${t.duration}s`);
  console.log(`node ${rel(resolve(HERE, 'render.mjs'))} --timeline ${rel(tlPath)} --audio ${rel(audio)} --width ${a.width} --height ${a.height} --fps ${a.fps} --out ${rel(mp4)}`);
  console.log();
}
