#!/usr/bin/env node
// ruin-print — print the whole record through the album page's ruin, offline.
//
// Runs dead-ocean.html's own print (renderTake, the "download ↓" button) in
// headless Chromium for every track, from the local 24/48 masters in
// assets/ep/, and writes one 24-bit/48k wav per track. Same worklet, same
// seeded reverb, same code as the page: a take dialled in on the site and a
// print from here at the same knobs + seed are the same audio (the site
// plays the AAC stream; this reads the lossless files).
//
//   node tools/ruin-print/print.mjs --ruin 0.65 --speed 0.8 --verb 0.35 --seed a1b2c3
//   node tools/ruin-print/print.mjs --url "https://www.newspeechsound.com/dead-ocean.html?t=kiidkyaas&ruin=0.40&seed=0f3a9c"
//
//   --url <link>     a share link from the page: takes its ruin/speed/verb/seed
//   --ruin 0..1  --speed 0.125..2  --verb 0..1  --seed <hex>   (seed: random if omitted)
//   --tracks a,b     slugs to print (default: all)
//   --out <dir>      default tools/release-audio/out/ruined/<settings>/
//
// Never overwrites: an existing wav gets -v2, -v3 beside it.
// Playwright comes from tools/reel-render (npm install there once).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(path.join(ROOT, "tools/reel-render/"));
const { chromium } = require("playwright");

// ---- args
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith("--")) { console.error(`unexpected argument: ${a}`); process.exit(1); }
  args[a.slice(2)] = process.argv[++i];
}
const k = { ruin: 0, speed: 1, verb: 0, seed: "" };
if (args.url) {
  const q = new URL(args.url).searchParams;
  for (const key of ["ruin", "speed", "verb"]) if (q.has(key)) k[key] = +q.get(key);
  if (q.has("seed")) k.seed = q.get("seed");
}
for (const key of ["ruin", "speed", "verb"]) if (args[key] != null) k[key] = +args[key];
if (args.seed != null) k.seed = String(args.seed);
if (!k.seed) k.seed = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
const bad = (m) => { console.error(m); process.exit(1); };
if (!(k.ruin >= 0 && k.ruin <= 1)) bad("--ruin is 0..1");
if (!(k.speed >= 0.125 && k.speed <= 2)) bad("--speed is 0.125..2");
if (!(k.verb >= 0 && k.verb <= 1)) bad("--verb is 0..1");
if (k.ruin === 0 && k.speed === 1 && k.verb === 0) bad("nothing to print: ruin 0, speed 1, reverb 0 is the clean record");

const ep = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/ep/dead-ocean.json"), "utf8"));
const want = args.tracks ? args.tracks.split(",") : ep.tracks.map((t) => t.slug);
for (const s of want) if (!ep.tracks.some((t) => t.slug === s)) bad(`no track "${s}" (have: ${ep.tracks.map((t) => t.slug).join(", ")})`);
for (const t of ep.tracks) if (want.includes(t.slug) && !fs.existsSync(path.join(ROOT, ep.audioBase, t.file))) bad(`missing master: ${ep.audioBase}${t.file}`);

const bits = [`ruin${k.ruin.toFixed(2)}`];
if (k.speed !== 1) bits.push(`x${k.speed.toFixed(2)}`);
if (k.verb > 0) bits.push(`verb${k.verb.toFixed(2)}`);
bits.push(k.seed);
const outDir = path.resolve(args.out || path.join(ROOT, "tools/release-audio/out/ruined", bits.join("-")));
fs.mkdirSync(outDir, { recursive: true });

// ---- the site, served from the checkout (the page fetches its worklet + masters)
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".flac": "audio/flac", ".woff2": "font/woff2", ".jpg": "image/jpeg", ".png": "image/png", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const p = path.normalize(path.join(ROOT, decodeURIComponent(new URL(req.url, "http://x").pathname)));
  if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Content-Length": fs.statSync(p).size });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  // no email door here: the page reads the local masters straight from audioBase
  await page.route("**/assets/ep/dead-ocean.json", (r) => { const j = { ...ep }; delete j.private; r.fulfill({ json: j }); });
  await page.goto(`${base}/dead-ocean.html`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__deadOcean, null, { timeout: 30000 });

  console.log(`ruin ${k.ruin.toFixed(2)} · speed ${k.speed.toFixed(3)}× · reverb ${k.verb.toFixed(2)} · seed ${k.seed}`);
  for (const t of ep.tracks) {
    if (!want.includes(t.slug)) continue;
    const n = ep.tracks.indexOf(t) + 1;
    const t0 = Date.now();
    const info = await page.evaluate(async ({ slug, k }) => {
      const D = window.__deadOcean;
      const t = D.tracks.find((x) => x.slug === slug);
      const { parts, frames } = await D.renderTake(t, k);
      window.__parts = parts;
      // peak of the print, from the 24-bit samples
      let peak = 0, full = 0;
      for (const p of parts) for (let i = 0; i + 2 < p.length; i += 3) {
        let v = p[i] | (p[i + 1] << 8) | (p[i + 2] << 16); if (v & 0x800000) v -= 0x1000000;
        const a = v < 0 ? -v : v; if (a > peak) peak = a; if (a >= 8388607) full++;
      }
      return { n: parts.length, frames, peak: peak / 8388607, full };
    }, { slug: t.slug, k });

    const name = `${ep.artist} - ${ep.download.name} (Ruined) - ${String(n).padStart(2, "0")} ${t.name}`;
    let file = path.join(outDir, `${name}.wav`);
    for (let v = 2; fs.existsSync(file); v++) file = path.join(outDir, `${name}-v${v}.wav`);
    const fd = fs.openSync(file, "w");
    const dataBytes = info.frames * 6, h = Buffer.alloc(44);
    h.write("RIFF", 0); h.writeUInt32LE(36 + dataBytes, 4); h.write("WAVE", 8); h.write("fmt ", 12);
    h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(48000, 24);
    h.writeUInt32LE(48000 * 6, 28); h.writeUInt16LE(6, 32); h.writeUInt16LE(24, 34); h.write("data", 36); h.writeUInt32LE(dataBytes, 40);
    fs.writeSync(fd, h);
    let wrote = 0;
    for (let i = 0; i < info.n; i++) {
      const b64 = await page.evaluate(async (i) => {
        const url = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(new Blob([window.__parts[i]])); });
        window.__parts[i] = null;
        return url.slice(url.indexOf(",") + 1);
      }, i);
      const buf = Buffer.from(b64, "base64");
      fs.writeSync(fd, buf); wrote += buf.length;
    }
    fs.closeSync(fd);
    if (wrote !== dataBytes) throw new Error(`${t.slug}: wrote ${wrote} bytes, expected ${dataBytes}`);
    const db = info.peak > 0 ? (20 * Math.log10(info.peak)).toFixed(2) : "-inf";
    console.log(`${String(n).padStart(2, "0")} ${t.name} · ${fmt(info.frames / 48000)} · peak ${db} dBFS${info.full ? ` · ${info.full} samples at full scale` : ""} · ${((Date.now() - t0) / 1000).toFixed(0)}s\n   ${file}`);
  }
} finally {
  await browser.close();
  server.close();
}
