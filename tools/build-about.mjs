// build-about.mjs — about.md → about.html (run by build.sh; the output is
// gitignored, like the news pages). the words live in about.md: frontmatter
// for the title/dek/og, then one `## ` section per block of the page.
//
// the layout is the climate record: the page background is the NOAA warming
// stripes, one band per year, 1850 at the top of the page and 2025 at the
// bottom — no years or readouts on screen, the record is only felt. the page
// wears as it warms — heading scrambles, chroma flicker, grain and stripe
// tears all scale with the anomaly at the reading line. disorder
// follows the climate (the hurricane proposal's rule). the body copy stays
// readable at every depth; prefers-reduced-motion drops the wear entirely.
import fs from "node:fs";
import path from "node:path";
import { esc, mdToHtml } from "./md.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SITE = "https://www.newspeechsound.com";

const raw = fs.readFileSync(path.join(ROOT, "about.md"), "utf8").replace(/<!--[\s\S]*?-->\n?/g, "");
const fm = {};
const body = raw.replace(/^---\n([\s\S]*?)\n---\n/, (_, block) => {
  for (const line of block.split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim();
  }
  return "";
});
const sections = body.split(/^## /m).slice(1).map((chunk) => {
  const nl = chunk.indexOf("\n");
  return { title: chunk.slice(0, nl).trim(), html: mdToHtml(chunk.slice(nl + 1).trim()) };
});
const climate = JSON.parse(fs.readFileSync(path.join(ROOT, "assets/data/climate.json"), "utf8"));

// staggered placements on a 12-column grid, cycled if the md grows
const PLACES = ["p-left", "p-right", "p-wide"];

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#050505">
${fm.noindex === "true" ? '<meta name="robots" content="noindex, nofollow">\n' : ""}<title>NEWSPEECH // ${esc(fm.title || "about")}</title>
<link rel="icon" type="image/svg+xml" href="favicon.svg">
<meta name="description" content="${esc(fm.og_description || fm.dek || "")}">
<meta property="og:title" content="NEWSPEECH // ${esc(fm.title || "about")}">
<meta property="og:description" content="${esc(fm.og_description || fm.dek || "")}">
<meta property="og:type" content="website">
<meta property="og:url" content="${SITE}/about.html">
<meta property="og:site_name" content="NEWSPEECH">
<meta property="og:image" content="${SITE}/og-image.jpg">
<meta property="og:image:type" content="image/jpeg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="hands on a synth keyboard in black and white — a frame of the newspeech hero video">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${SITE}/og-image.jpg">
<style>
  :root { --bg: #050505; --fg: #fff; --col-pad: max(var(--ns-gutter, 40px), calc((100% - 1280px) / 2 + var(--ns-gutter, 40px))); }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--fg); overflow-x: hidden; }
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

  /* the record: warming stripes behind the whole of <main>, one band a year */
  main { position: relative; }
  #record { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 0; display: block; }
  /* grain: a fixed noise layer whose opacity follows the anomaly */
  #grain { position: fixed; inset: 0; z-index: 2; pointer-events: none; opacity: 0; background-size: 256px 256px; mix-blend-mode: screen; }

  .wrap { position: relative; z-index: 3; padding: 0 var(--col-pad); }
  .grid { display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); column-gap: 28px; }

  .hero { min-height: 100svh; display: flex; flex-direction: column; justify-content: center; padding: calc(80px + var(--ns-nav-h, 0px)) 0 120px; }
  .hero h1 {
    font-family: "zxx-sans", ui-monospace, monospace;
    font-weight: normal;
    font-size: clamp(54px, 9.35vw, 143px);
    line-height: 0.95;
    letter-spacing: 0.01em;
    margin: 0 0 36px;
    user-select: none;
  }
  .hero .dek { max-width: 46ch; font-size: 15px; line-height: 1.75; color: rgba(255, 255, 255, 0.88); margin: 0; }

  /* sections: staggered across the column, a long gap between each so the
     years spread out under them */
  .s { padding: 22vh 0; }
  .s .in { grid-column: 1 / 7; }
  .s.p-right .in { grid-column: 7 / 13; }
  .s.p-wide .in { grid-column: 3 / 12; }
  .s h2 {
    font-family: "zxx-sans", ui-monospace, monospace;
    font-weight: normal;
    font-size: clamp(38px, 4.2vw, 72px);
    line-height: 1;
    letter-spacing: 0.01em;
    margin: 0 0 30px;
    user-select: none;
  }
  .s .copy { transition: filter 60ms linear; }
  .s p { font-size: 13px; line-height: 1.8; letter-spacing: 0.02em; color: rgba(255, 255, 255, 0.82); margin: 0 0 16px; max-width: 58ch; }
  .s.p-wide p { font-size: 14px; }
  .s p strong { color: #fff; font-weight: normal; border-bottom: 1px solid rgba(255, 255, 255, 0.5); }
  .s a { color: #fff; text-underline-offset: 3px; }
  /* reading plates: text sits on a soft dark field so the brightest stripes
     never fight it */
  .s .in, .hero > * { position: relative; }
  .s .in::before {
    content: "";
    position: absolute;
    inset: -28px -32px;
    background: radial-gradient(closest-side, rgba(5, 5, 5, 0.72), rgba(5, 5, 5, 0.5) 70%, rgba(5, 5, 5, 0));
    z-index: -1;
    pointer-events: none;
  }
  .chroma { filter: drop-shadow(-1.5px 0 0 rgba(0, 255, 255, 0.8)) drop-shadow(1.5px 0 0 rgba(255, 0, 255, 0.8)); }
  [data-wear] span { display: inline-block; }

  /* the end of the record */
  .end { padding: 18vh 0 22vh; }
  .end .in { grid-column: 1 / 13; }
  .end .src { margin: 0; max-width: 64ch; font-size: 11px; line-height: 1.7; color: rgba(255, 255, 255, 0.4); }

  @media (max-width: 900px) {
    .s .in, .s.p-right .in, .s.p-wide .in { grid-column: 1 / 13; }
    .s { padding: 16vh 0; }
  }
</style>
</head>
<body>

<script src="nav.js"></script>

<main>
<canvas id="record" aria-hidden="true"></canvas>
<div class="wrap">
  <header class="hero">
    <h1 data-wear>${esc(fm.title || "about")}</h1>
    <p class="dek">${esc(fm.dek || "")}</p>
  </header>
${sections.map((s, i) => `  <section class="s ${PLACES[i % PLACES.length]}">
    <div class="grid"><div class="in">
      <h2 data-wear>${esc(s.title)}</h2>
      <div class="copy">${s.html}</div>
    </div></div>
  </section>`).join("\n")}
  <div class="end">
    <div class="grid"><div class="in">
      <p class="src">the stripes: NOAA NCEI global land + ocean surface temperature, one band per year, brightness = the annual anomaly against the 20th-century mean.</p>
    </div></div>
  </div>
</div>
</main>

<div id="grain" aria-hidden="true"></div>

<script>
const CLIMATE = ${JSON.stringify({ temps: climate.temps })};
(() => {
  "use strict";
  const T = CLIMATE.temps;                 // [[year, anomaly °C]] 1850–2025
  const Y0 = T[0][0], N = T.length;
  const aMin = Math.min(...T.map((t) => t[1])), aMax = Math.max(...T.map((t) => t[1]));
  const norm = (a) => (a - aMin) / (aMax - aMin); // 0 = coolest year … 1 = warmest

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const main = document.querySelector("main");
  const cv = document.getElementById("record");
  const ctx = cv.getContext("2d");

  // ---- the stripes ----
  let tears = []; // {i, dx} — bands knocked sideways for a moment
  function draw() {
    const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bh = h / N;
    for (let i = 0; i < N; i++) {
      const v = norm(T[i][1]);
      // mono: near-black for the coolest years up to a mid grey for the warmest,
      // linear so the mid-century climb reads before the last few decades
      const l = Math.round(6 + v * 60);
      ctx.fillStyle = "rgb(" + l + "," + l + "," + l + ")";
      const t = tears.find((x) => x.i === i);
      ctx.fillRect(t ? t.dx : 0, Math.floor(i * bh), w, Math.ceil(bh) + 1);
      if (t) { ctx.fillStyle = "#050505"; ctx.fillRect(t.dx < 0 ? w + t.dx : 0, Math.floor(i * bh), Math.abs(t.dx), Math.ceil(bh) + 1); }
    }
  }
  new ResizeObserver(draw).observe(cv);

  // ---- the reading line: the year under the middle of the screen drives the wear ----
  let cur = 0;
  function sync() {
    const r = main.getBoundingClientRect();
    const f = (window.innerHeight * 0.5 - r.top) / r.height;
    cur = Math.max(0, Math.min(N - 1, Math.floor(f * N)));
    // grain belongs to the record — it thins out as the page gives way to the footer
    const onScreen = Math.max(0, Math.min(1, r.bottom / window.innerHeight));
    if (!reduce) document.getElementById("grain").style.opacity = String((0.02 + 0.16 * wear() * wear()) * onScreen);
  }
  const wear = () => norm(T[cur][1]);
  window.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync);
  sync();

  if (reduce) return;

  // ---- wear: everything below scales with the anomaly at the reading line ----
  function poisson(rateFn, fire) {
    (function step() {
      const r = Math.max(0.02, rateFn());
      setTimeout(() => { fire(); step(); }, -Math.log(1 - Math.random()) / r * 1000);
    })();
  }

  // headings: per-char font swaps + scrambles, faster as it warms
  const FONTS = ["zxx-sans", "zxx-noise", "zxx-camo", "zxx-xed"];
  const GLYPHS = "#*/\\\\_+=~<>.,:;|?!@$%^&-";
  for (const el of document.querySelectorAll("[data-wear]")) {
    const txt = el.textContent;
    el.textContent = "";
    const spans = [...txt].map((ch) => {
      const s = document.createElement("span");
      s.textContent = ch === " " ? "\\u00a0" : ch;
      s.dataset.o = s.textContent;
      el.appendChild(s);
      return s;
    });
    const live = spans.filter((s) => s.dataset.o.trim());
    poisson(() => 0.08 + 3.2 * wear() * wear(), () => {
      const n = 1 + Math.floor(wear() * wear() * live.length * 0.6);
      const hit = [...live].sort(() => Math.random() - 0.5).slice(0, n);
      for (const s of hit) {
        if (Math.random() < 0.5) s.style.fontFamily = '"' + FONTS[(Math.random() * FONTS.length) | 0] + '", monospace';
        else s.textContent = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      setTimeout(() => { for (const s of hit) { s.textContent = s.dataset.o; s.style.fontFamily = ""; } }, 70 + Math.random() * 180);
    });
  }

  // body copy: a chroma flicker on the section nearest the reading line
  const copies = [...document.querySelectorAll(".s .copy")];
  poisson(() => 0.01 + 1.4 * Math.pow(wear(), 3), () => {
    const mid = window.innerHeight / 2;
    const c = copies.reduce((best, el) => {
      const r = el.getBoundingClientRect(); const d = Math.abs((r.top + r.bottom) / 2 - mid);
      return !best || d < best.d ? { el, d } : best;
    }, null);
    if (!c) return;
    c.el.classList.add("chroma");
    setTimeout(() => c.el.classList.remove("chroma"), 60 + Math.random() * 90);
  });

  // stripe tears near the reading line, only once it's warm
  poisson(() => 0.02 + 5 * Math.pow(Math.max(0, wear() - 0.45), 2), () => {
    const k = 1 + ((Math.random() * 4) | 0);
    tears = Array.from({ length: k }, () => ({
      i: Math.max(0, Math.min(N - 1, cur + ((Math.random() * 16) | 0) - 8)),
      dx: (Math.random() < 0.5 ? -1 : 1) * (20 + Math.random() * 160 * wear()),
    }));
    draw();
    setTimeout(() => { tears = []; draw(); }, 80 + Math.random() * 160);
  });

  // grain: four pre-made noise tiles, cycled
  const tiles = Array.from({ length: 4 }, () => {
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const g = c.getContext("2d"), img = g.createImageData(256, 256);
    for (let p = 0; p < img.data.length; p += 4) {
      const v = Math.random() < 0.5 ? 0 : (Math.random() * 255) | 0;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v; img.data[p + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return "url(" + c.toDataURL() + ")";
  });
  const grain = document.getElementById("grain");
  let gi = 0;
  setInterval(() => { grain.style.backgroundImage = tiles[gi++ % tiles.length]; }, 90);
})();
</script>
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, "about.html"), html);
console.log(`about.html: ${sections.length} sections`);
