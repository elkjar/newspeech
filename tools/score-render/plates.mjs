#!/usr/bin/env node
// plates — render each section of a .seq as a square transparent PNG plate.
// consumed by fusion-stack.py to build a real 3D stack inside DaVinci Resolve.
//
//   node plates.mjs <song.seq> <outdir> [--invert] [--scale 2]

import { chromium } from "../reel-render/node_modules/playwright/index.mjs";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const seqPath = args[0], outDir = args[1];
if (!seqPath || !outDir) {
  console.error("usage: node plates.mjs <song.seq> <outdir> [--invert] [--scale 2]");
  process.exit(1);
}
const scale = args.includes("--scale") ? parseFloat(args[args.indexOf("--scale") + 1]) : 2;
fs.mkdirSync(outDir, { recursive: true });

const MIME = { ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  try { res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" }); res.end(fs.readFileSync(p)); }
  catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));

const browser = await chromium.launch();
const page = await browser.newPage();
page.on("pageerror", e => console.error("[page]", e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/score.html`);

const seq = JSON.parse(fs.readFileSync(seqPath, "utf8"));
const info = await page.evaluate(([d, n]) => window.__score.load(d, n), [seq, path.basename(seqPath)]);
if (!info) { console.error("no active steps"); process.exit(1); }
await page.evaluate((o) => window.__score.set(o), { transparent: true, clean: true, invert: args.includes("--invert") });

const files = [];
for (let i = 0; ; i++) {
  const dataUrl = await page.evaluate(([n, s]) => window.__score.plate(n, s), [i, scale]);
  if (!dataUrl) break;
  const file = `section-${String(i).padStart(2, "0")}.png`;
  fs.writeFileSync(path.join(outDir, file), Buffer.from(dataUrl.split(",")[1], "base64"));
  files.push(file);
}
fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify({
  name: path.basename(seqPath).replace(/\.seq$/i, ""), bpm: info.bpm, totalBars: info.totalBars, files,
}, null, 2));
console.log(`wrote ${files.length} plates + meta.json to ${outDir}`);

await browser.close();
server.close();
