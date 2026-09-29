// og-render.mjs — renders every share image on the site (1200×630, no type).
//
//   node tools/og-render.mjs            everything
//   node tools/og-render.mjs slice viz  only jobs whose name contains a filter
//
// sources:
//   og-<tool>-comp.html        bespoke comps → og-<tool>.png
//   og-viz-comp.html?viz=…     tool-viz miniatures, bare → og-<name>.png
//   assets/hero/hero.mp4       one frame of the hero video (HERO_T s — picked
//                              for having no on-screen text of its own) under
//                              the ascii wordmark (assets/ns-text.svg) →
//                              og-image.jpg, the site default: home, news,
//                              shop, start… — the one share image with a mark
//   N-*.html                   each visualizer, captured live after a few
//                              seconds with the panel + HUD hidden; the
//                              source-driven ones get hero-clean.mp4 as their
//                              source → assets/og/<page>.jpg
//
// needs ffmpeg on PATH (the hero frame).
//
// playwright comes from tools/reel-render's install (npm i there first).
import { createServer } from "node:http";
import { readFile, readdir, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { chromium } from "./reel-render/node_modules/playwright/index.mjs";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const W = 1200, H = 630;
const HERO_T = 1; // seconds into assets/hero/hero.mp4
// the visualizer pages' chrome — none of it belongs in a share image
const HIDE = "#panel, #panel-handle, #audio-panel, canvas#hud-overlay { display: none !important; }";

const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png",
  ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json",
  ".mp4": "video/mp4", ".wav": "audio/wav" };
const server = createServer(async (req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  try {
    const body = await readFile(join(ROOT, path === "/" ? "index.html" : path));
    res.writeHead(200, { "Content-Type": TYPES[extname(path)] || "application/octet-stream" });
    res.end(body);
  } catch (_) { res.writeHead(404); res.end(); }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const jobs = [];
for (const t of ["decay", "drone", "glitch", "slice", "stretch", "plugins"]) {
  jobs.push({ name: `comp:${t}`, url: `og-${t}-comp.html`, out: `og-${t}.png`, wait: 400 });
}
// miniatures animate — give them a few seconds to get going
for (const v of ["texture", "samples", "visuals", "sequence", "tools"]) {
  jobs.push({ name: `viz:${v}`, url: `og-viz-comp.html?viz=${v}`, out: `og-${v}.png`, wait: 3500 });
}
jobs.push({ name: "hero", hero: true, out: "og-image.jpg", wait: 300 });
const vizPages = (await readdir(ROOT)).filter((f) => /^\d+-[a-z]+\.html$/.test(f)).sort((a, b) => parseInt(a) - parseInt(b));
for (const f of vizPages) {
  const sourced = (await readFile(join(ROOT, f), "utf8")).includes("__loadSourceUrl");
  jobs.push({ name: `page:${f}`, url: f, out: `assets/og/${f.replace(".html", ".jpg")}`,
    // sourced pages need longer — the buffer-based ones (repeat) play back an
    // empty loop for their first few seconds
    wait: sourced ? 7000 : 3500, hide: true, sourced });
}

const filters = process.argv.slice(2);
const todo = filters.length ? jobs.filter((j) => filters.some((f) => j.name.includes(f))) : jobs;

await mkdir(join(ROOT, "assets/og"), { recursive: true });
const browser = await chromium.launch();
for (const j of todo) {
  if (j.hero) {
    // the frame: scaled to cover 1200×630, center-cropped; the page lays the
    // wordmark over it (a light wash keeps the white mark off the highlights)
    const dir = await mkdtemp(join(tmpdir(), "og-hero-"));
    const frame = join(dir, "frame.png");
    execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-ss", String(HERO_T), "-i", join(ROOT, "assets/hero/hero.mp4"),
      "-frames:v", "1", "-vf", `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`, frame]);
    const b64 = (await readFile(frame)).toString("base64");
    await rm(dir, { recursive: true });
    j.html = `<body style="margin:0;width:${W}px;height:${H}px;position:relative;overflow:hidden;background:#000">` +
      `<img src="data:image/png;base64,${b64}" style="position:absolute;inset:0;width:100%;height:100%">` +
      `<div style="position:absolute;inset:0;background:rgba(0,0,0,0.38)"></div>` +
      `<img src="${BASE}assets/ns-text.svg" style="position:absolute;left:50%;top:50%;width:${Math.round(W * 0.62)}px;transform:translate(-50%,-50%)">`;
  }
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  if (j.html) await page.setContent(j.html, { waitUntil: "networkidle" });
  else await page.goto(BASE + j.url, { waitUntil: "networkidle" });
  await page.evaluate(() => document.fonts && document.fonts.ready);
  if (j.hide) await page.addStyleTag({ content: HIDE });
  if (j.sourced) await page.evaluate((u) => window.__loadSourceUrl(u), BASE + "assets/hero/hero-clean.mp4");
  await page.waitForTimeout(j.wait);
  const jpg = j.out.endsWith(".jpg");
  await page.screenshot({ path: join(ROOT, j.out), type: jpg ? "jpeg" : "png", ...(jpg ? { quality: 84 } : {}) });
  console.log(`${j.name.padEnd(28)} → ${j.out}${errs.length ? "  ERR " + errs.join("; ") : ""}`);
  await page.close();
}
await browser.close();
server.close();
