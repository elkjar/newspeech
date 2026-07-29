#!/usr/bin/env node
// score-render — render a .seq's graphic score as a ProRes 4444 .mov with
// alpha, sections drawing in tempo-locked as the piece plays. the output
// drops straight into a DaVinci Resolve media pool (or any NLE) and
// composites over footage. reuses score.html's renderers via Playwright.
//
//   node render.mjs <song.seq> [out.mov] [options]
//
//   --view composition|stack|figures   (default composition)
//   --format 1:1|4:5|9:16|16:9         (default 16:9)
//   --invert          paper mode instead of ink
//   --text            keep the title/meta/footer text (default clean)
//   --opaque          bake the background in (default transparent alpha)
//   --fps N           (default 30)
//   --seconds N       override duration (default: the piece's real length)
//   --hold N          seconds to hold the finished figure at the end (default 4)
//   --scale N         canvas supersample (default 2 → 3360px wide on 16:9)

import { chromium } from "../reel-render/node_modules/playwright/index.mjs";
import { spawn } from "child_process";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// ---- args ----
const args = process.argv.slice(2);
const positional = args.filter(a => !a.startsWith("--") && !isFlagValue(a));
function isFlagValue(a) {
  const i = args.indexOf(a);
  return i > 0 && ["--view", "--format", "--fps", "--seconds", "--hold", "--scale"].includes(args[i - 1]);
}
function opt(name, dflt) {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : dflt;
}
const seqPath = positional[0];
if (!seqPath || !fs.existsSync(seqPath)) {
  console.error("usage: node render.mjs <song.seq> [out.mov] [--view composition|stack|figures] [--format 16:9] [--invert] [--text] [--opaque] [--fps 30] [--seconds N] [--hold 4] [--scale 2]");
  process.exit(1);
}
const view = opt("view", "composition");
const format = opt("format", "16:9");
const fps = parseInt(opt("fps", "30"), 10);
const hold = parseFloat(opt("hold", "4"));
const scale = parseFloat(opt("scale", "2"));
const outPath = positional[1] ||
  seqPath.replace(/\.seq$/i, "") + `-score-${view}-${format.replace(":", "x")}.mov`;

// ---- static server for the repo ----
const MIME = { ".html": "text/html", ".js": "text/javascript", ".woff2": "font/woff2", ".svg": "image/svg+xml" };
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  try {
    res.writeHead(200, { "content-type": MIME[path.extname(p)] || "application/octet-stream" });
    res.end(fs.readFileSync(p));
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

// ---- page ----
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("pageerror", e => console.error("[page]", e.message));
await page.goto(`http://127.0.0.1:${port}/score.html`);

const seq = JSON.parse(fs.readFileSync(seqPath, "utf8"));
const info = await page.evaluate(
  ([d, name]) => window.__score.load(d, name),
  [seq, path.basename(seqPath)]
);
if (!info) { console.error("no active steps found in this file"); process.exit(1); }

const bpm = info.bpm || 120;
const pieceSeconds = info.totalBars * 4 * 60 / bpm;
const seconds = parseFloat(opt("seconds", pieceSeconds)) + hold;
const totalFrames = Math.round(seconds * fps);
const drawSeconds = parseFloat(opt("seconds", pieceSeconds));
const barsPerSecond = info.totalBars / drawSeconds;

await page.evaluate((o) => window.__score.set(o), {
  view, format,
  clean: !args_has_text(),
  invert: args.includes("--invert"),
  transparent: !args.includes("--opaque"),
});
function args_has_text() { return args.includes("--text"); }

console.log(`${path.basename(seqPath)} → ${path.basename(outPath)}`);
console.log(`${view} · ${format} · ${info.totalBars} bars @ ${bpm}bpm = ${drawSeconds.toFixed(1)}s + ${hold}s hold · ${totalFrames} frames @ ${fps}fps`);

// ---- ffmpeg: png pipe -> prores 4444 with alpha ----
const ff = spawn("ffmpeg", [
  "-y", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
  "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
  "-vendor", "apl0", outPath,
], { stdio: ["pipe", "ignore", "inherit"] });

for (let f = 0; f < totalFrames; f++) {
  const t = f / fps;
  const revealBars = Math.min(info.totalBars + 1, t * barsPerSecond + (t >= drawSeconds ? 1 : 0));
  const dataUrl = await page.evaluate(
    ([bars, s]) => { window.__score.set({ revealBars: bars }); return window.__score.frame(s); },
    [revealBars, scale]
  );
  const ok = ff.stdin.write(Buffer.from(dataUrl.split(",")[1], "base64"));
  if (!ok) await new Promise(r => ff.stdin.once("drain", r));
  if (f % (fps * 10) === 0) process.stdout.write(`\r${Math.round(100 * f / totalFrames)}%  `);
}
ff.stdin.end();
await new Promise((res, rej) => ff.on("close", c => c === 0 ? res() : rej(new Error("ffmpeg exited " + c))));
process.stdout.write("\r100%  \n");

await browser.close();
server.close();
console.log("wrote", outPath);
