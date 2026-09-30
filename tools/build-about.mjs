// build-about.mjs — about.md → about.html (run by build.sh; the output is
// gitignored, like the news pages). the words live in about.md: frontmatter
// for the title/dek/og, then one `## ` section per block of the page.
//
// the layout is the climate record: the page background is the NOAA warming
// stripes, one band per year, 1850 at the top of the page and 2025 at the
// bottom — no years or readouts on screen, the record is only felt. the page
// breaks as it warms: see about.js (the stripes + all the wear). disorder
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
  .grid { position: relative; display: grid; grid-template-columns: repeat(12, minmax(0, 1fr)); column-gap: 28px; }

  /* sections: staggered across the column, a long gap between each so the
     years spread out under them */
  .s { padding: 22vh 0; }
  .s .in { grid-column: 1 / 7; }
  .s.p-right .in { grid-column: 7 / 13; }
  .s.p-wide .in { grid-column: 3 / 12; }
  /* the first section opens the page: clears the nav, headline-size title */
  .s.lead { padding-top: calc(16vh + var(--ns-nav-h, 0px)); }
  .s.lead .in { grid-column: 1 / 13; }
  .s.lead .copy { max-width: 58ch; }
  .s.lead h1 {
    font-family: "zxx-sans", ui-monospace, monospace;
    font-weight: normal;
    font-size: clamp(54px, 9.35vw, 143px);
    line-height: 0.95;
    letter-spacing: 0.01em;
    margin: 0 0 36px;
    white-space: nowrap; /* per-letter spans would otherwise break mid-word */
    user-select: none;
  }
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
  .s .in { position: relative; }
  .s .in::before {
    content: "";
    position: absolute;
    inset: -28px -32px;
    background: radial-gradient(closest-side, rgba(5, 5, 5, 0.72), rgba(5, 5, 5, 0.5) 70%, rgba(5, 5, 5, 0));
    z-index: -1;
    pointer-events: none;
  }
  /* built-in damage (about.js): rotted characters, and ones nearly gone */
  .ch.rot { opacity: 0.45; }
  .ch.gone { opacity: 0.2; }
  .s .copy > * { transform-origin: left center; }
  .s h2 span { transition: none; }
  /* a section tear: a clipped clone of the block on a solid ground */
  .tear { background: #050505; z-index: 4; pointer-events: none; }
  .tear::before { display: none; }
  .wrap { will-change: transform; }
  .chroma { filter: drop-shadow(-1.5px 0 0 rgba(0, 255, 255, 0.8)) drop-shadow(1.5px 0 0 rgba(255, 0, 255, 0.8)); }
  [data-wear] span { display: inline-block; }

  /* the end of the record */
  .end { padding: 4vh 0 8vh; }
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
${sections.map((s, i) => `  <section class="s ${PLACES[i % PLACES.length]}${i === 0 ? " lead" : ""}">
    <div class="grid"><div class="in">
      <${i === 0 ? "h1" : "h2"} data-wear>${esc(s.title)}</${i === 0 ? "h1" : "h2"}>
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

<script>window.CLIMATE = ${JSON.stringify({ temps: climate.temps })};</script>
<script src="about.js"></script>
</body>
</html>
`;

fs.writeFileSync(path.join(ROOT, "about.html"), html);
console.log(`about.html: ${sections.length} sections`);
