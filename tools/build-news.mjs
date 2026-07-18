#!/usr/bin/env node
// build-news.mjs — the news/blog generator.
//
// posts/*.md (tiny frontmatter: title / date / dek / image) in, static pages
// out. deliberately NOT an SSG framework — a markdown subset plus raw-HTML
// passthrough is the whole feature set. emits:
//   news/<slug>.html   one page per post (slug = filename minus date prefix)
//   news/assets/       verbatim copy of posts/assets/
//   news.html          dated index at the site root
//   feed.xml           RSS
//
// post layout: title block at 960px, featured image at 1280px, body copy at
// 720px — all centered columns. inline embeds (images, audio, video, iframes)
// are raw HTML in the markdown body and pass through untouched; a block-level
// <figure class="wide"> breaks out of the 720px column to 1280px.
//
// run from the repo root: node tools/build-news.mjs
// build.sh runs it on every deploy. outputs are gitignored.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const POSTS_DIR = path.join(ROOT, "posts");
const OUT_DIR = path.join(ROOT, "news");
const SITE = "https://www.newspeechsound.com";

// =========================================================================
// frontmatter + markdown subset
// =========================================================================
function parseFrontmatter(raw, file) {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) throw new Error(`${file}: missing frontmatter block`);
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  for (const k of ["title", "date"]) {
    if (!meta[k]) throw new Error(`${file}: frontmatter needs "${k}"`);
  }
  return { meta, body: raw.slice(m[0].length) };
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function figureHtml(src, alt, caption, cls) {
  return `<figure${cls ? ` class="${cls}"` : ""}><img src="${src}" alt="${esc(alt)}" loading="lazy">${
    caption ? `<figcaption>${esc(caption)}</figcaption>` : ""}</figure>`;
}

// inline spans: text is escaped first, then `code` / **bold** / *em* / links.
function inline(s) {
  s = esc(s);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, txt, href) => {
    const ext = /^https?:\/\//.test(href);
    return `<a href="${href}"${ext ? ` target="_blank" rel="noopener noreferrer"` : ""}>${txt}</a>`;
  });
  return s;
}

// block-level markdown → HTML. raw HTML blocks (a line opening with <) pass
// through verbatim until the next blank line — that's the audio/video/iframe
// escape hatch.
function mdToHtml(md) {
  const lines = md.split("\n");
  const out = [];
  let i = 0;
  const collect = (pred) => {
    const got = [];
    while (i < lines.length && pred(lines[i])) got.push(lines[i++]);
    return got;
  };
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { i++; continue; }

    if (t.startsWith("```")) {                               // fenced code
      i++;
      const code = collect((l) => !l.trim().startsWith("```"));
      i++; // closing fence
      out.push(`<pre><code>${esc(code.join("\n"))}</code></pre>`);
    } else if (t.startsWith("<")) {                          // raw HTML passthrough
      out.push(collect((l) => l.trim() !== "").join("\n"));
    } else if (/^#{1,4} /.test(t)) {                         // headings
      const level = t.match(/^#+/)[0].length;
      out.push(`<h${level}>${inline(t.replace(/^#+ /, ""))}</h${level}>`);
      i++;
    } else if (/^(-{3,}|\*{3,})$/.test(t)) {                 // hr
      out.push("<hr>");
      i++;
    } else if (t.startsWith("> ")) {                         // blockquote
      const quote = collect((l) => l.trim().startsWith(">"));
      out.push(`<blockquote>${quote.map((l) => inline(l.trim().replace(/^>\s?/, ""))).join("<br>")}</blockquote>`);
    } else if (/^[-*] /.test(t)) {                           // unordered list
      const items = collect((l) => /^[-*] /.test(l.trim()));
      out.push(`<ul>${items.map((l) => `<li>${inline(l.trim().slice(2))}</li>`).join("")}</ul>`);
    } else if (/^\d+\. /.test(t)) {                          // ordered list
      const items = collect((l) => /^\d+\. /.test(l.trim()));
      out.push(`<ol>${items.map((l) => `<li>${inline(l.trim().replace(/^\d+\. /, ""))}</li>`).join("")}</ol>`);
    } else if (/^!\[/.test(t)) {                             // image on its own line → figure
      const m = t.match(/^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)$/);
      if (m) { out.push(figureHtml(m[2], m[1], m[3], "")); i++; }
      else { out.push(`<p>${inline(t)}</p>`); i++; }
    } else {                                                 // paragraph
      const para = collect((l) => {
        const s = l.trim();
        return s !== "" && !/^(#{1,4} |```|> |[-*] |\d+\. |<|!\[)/.test(s);
      });
      out.push(`<p>${para.map((l) => inline(l.trim())).join("<br>")}</p>`);
    }
  }
  return out.join("\n");
}

// =========================================================================
// page templates — the shared site scaffold (nav.js + zxx faces + mono type)
// =========================================================================
function headBlock({ title, description, url, ogImage, rootPrefix }) {
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#050505">
<title>NEWSPEECH // ${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="${rootPrefix}favicon.svg">
<link rel="alternate" type="application/rss+xml" title="NEWSPEECH // news" href="${SITE}/feed.xml">
<meta name="description" content="${esc(description)}">
<meta property="og:title" content="NEWSPEECH // ${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="NEWSPEECH">
<meta property="og:locale" content="en_US">
<meta property="og:image" content="${ogImage}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="NEWSPEECH // ${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${ogImage}">`;
}

const SHARED_CSS = `
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #050505; color: #fff; }
  body {
    min-height: 100vh;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    /* clears the fixed site nav (nav.js maintains --ns-nav-h) */
    padding: calc(24px + var(--ns-nav-h, 0px)) 20px 80px;
    font-size: 13px;
    line-height: 1.6;
  }
  a { color: inherit; }
  .kicker {
    display: inline-block;
    font-size: 14px;
    letter-spacing: 0.2em;
    color: #eee;
    text-decoration: none;
    margin: 0 0 4px;
  }
  a.kicker:hover { color: #fff; }
  .sub { font-size: 12px; color: #666; margin: 0; }
  .sub a {
    color: inherit;
    text-decoration: none;
    border-bottom: 1px solid rgba(255, 255, 255, 0.25);
  }
  .sub a:hover { color: #ddd; border-bottom-color: rgba(255, 255, 255, 0.7); }`;

// the three-width post layout: head 960 / featured 1280 / body 720
const POST_CSS = `
  @font-face { font-family: "zxx-sans"; src: url("../fonts/zxx-sans.woff2") format("woff2"); font-display: swap; }
${SHARED_CSS}
  .post-head { max-width: 960px; margin: 0 auto; }
  .post-head .title {
    font-family: "zxx-sans", monospace;
    font-size: clamp(28px, 4.6vw, 48px);
    font-weight: 400;
    letter-spacing: 0.04em;
    line-height: 1.08;
    margin: 22px 0 12px;
  }
  .featured { max-width: 1280px; margin: 32px auto 44px; }

  article { max-width: 720px; margin: 0 auto; font-size: 14px; line-height: 1.75; color: rgba(255, 255, 255, 0.88); }
  article p { margin: 0 0 18px; }
  article h2, article h3, article h4 {
    font-size: 13px;
    font-weight: 400;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: #eee;
    margin: 40px 0 14px;
  }
  article h3, article h4 { font-size: 12px; color: #ccc; }
  article a { border-bottom: 1px solid rgba(255, 255, 255, 0.25); text-decoration: none; }
  article a:hover { color: #fff; border-bottom-color: rgba(255, 255, 255, 0.7); }
  article ul, article ol { margin: 0 0 18px; padding-left: 22px; }
  article li { margin: 0 0 6px; }
  article blockquote {
    margin: 24px 0;
    padding-left: 16px;
    border-left: 1px solid rgba(255, 255, 255, 0.25);
    color: #999;
  }
  article pre {
    background: rgba(255, 255, 255, 0.05);
    border-left: 1px solid rgba(255, 255, 255, 0.15);
    padding: 14px 16px;
    overflow-x: auto;
    font-size: 12px;
    line-height: 1.6;
    margin: 0 0 18px;
  }
  article code { background: rgba(255, 255, 255, 0.07); padding: 1px 5px; font-size: 0.92em; }
  article pre code { background: none; padding: 0; }
  article hr { border: 0; border-top: 1px solid rgba(255, 255, 255, 0.15); width: 120px; margin: 36px auto; }

  /* media — inline figures break the text column slightly: 780 wide, centered */
  figure { margin: 28px 0; }
  article figure {
    width: min(780px, 100vw - 40px);
    margin-left: 50%;
    transform: translateX(-50%);
  }
  figure img, article img, article video { display: block; width: 100%; height: auto; }
  figcaption { font-size: 11px; color: #666; margin-top: 8px; letter-spacing: 0.06em; }
  article audio { display: block; width: 100%; margin: 28px 0; }
  /* video embeds break the text column: 1080 wide, centered */
  .video {
    position: relative;
    aspect-ratio: 16 / 9;
    width: min(1080px, 100vw - 40px);
    margin: 36px 0 36px 50%;
    transform: translateX(-50%);
  }
  .video iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
  /* case-by-case breakout: <figure class="wide"> spans the 1280 column */
  article .wide { width: min(1280px, 100vw - 40px); margin-left: 50%; transform: translateX(-50%); }

  .post-foot { max-width: 720px; margin: 40px auto 0; font-size: 12px; color: #666; }
  .post-foot a { text-decoration: none; border-bottom: 1px solid rgba(255, 255, 255, 0.25); }
  .post-foot a:hover { color: #ddd; border-bottom-color: rgba(255, 255, 255, 0.7); }

  /* newsletter — same Netlify form as the homepage dialog, quieter dress */
  #subscribe {
    max-width: 720px;
    margin: 64px auto 0;
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 24px 26px;
    border: 1px solid rgba(255, 255, 255, 0.22);
    font-size: 12px;
    line-height: 18px;
    letter-spacing: 0.04em;
  }
  #subscribe .hp { display: none; }
  #subscribe .sub-label { color: #999; cursor: pointer; }
  #subscribe .sub-row { display: flex; gap: 12px; }
  #subscribe input[type="email"] {
    flex: 1;
    min-width: 0;
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.35);
    color: #fff;
    font: inherit;
    letter-spacing: 0.04em;
    padding: 7px 12px;
    border-radius: 0;
    outline: none;
  }
  #subscribe input[type="email"]:focus { border-color: rgba(255, 255, 255, 0.9); }
  #subscribe input[type="email"]::placeholder { color: rgba(255, 255, 255, 0.3); }
  #subscribe button {
    background: transparent;
    border: 1px solid rgba(255, 255, 255, 0.55);
    color: #fff;
    font: inherit;
    letter-spacing: 0.04em;
    padding: 7px 16px;
    cursor: pointer;
    flex-shrink: 0;
  }
  #subscribe button:hover { background: rgba(255, 255, 255, 0.08); }
  #subscribe button:disabled { opacity: 0.4; cursor: default; }
  #subscribe .sub-msg { color: #ddd; letter-spacing: 0.06em; }
  #subscribe .sub-msg.err { color: #888; }
  @media (max-width: 480px) {
    #subscribe .sub-row { flex-direction: column; }
  }`;

function postPage(post) {
  const { meta, html, slug } = post;
  const url = `${SITE}/news/${slug}.html`;
  const ogImage = meta.image ? new URL(meta.image, `${SITE}/news/`).href : `${SITE}/og-image.png`;
  const featured = meta.image
    ? `\n  <div class="featured">${figureHtml(meta.image, meta.image_alt || meta.title, meta.image_caption, "")}</div>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
${headBlock({ title: meta.title, description: meta.dek || meta.title, url, ogImage, rootPrefix: "../" })}
<style>${POST_CSS}
</style>
</head>
<body>
  <script src="../nav.js"></script>
  <header class="post-head">
    <a class="kicker" href="../news.html">// NEWS</a>
    <h1 class="title">${esc(meta.title)}</h1>
    <p class="sub">${meta.date}${meta.dek ? ` &nbsp;·&nbsp; ${esc(meta.dek)}` : ""}</p>
  </header>${featured}
  <article>
${html}
  </article>
  <form id="subscribe" name="subscribe" method="POST" action="/" data-netlify="true" netlify-honeypot="bot-field">
    <input type="hidden" name="form-name" value="subscribe">
    <p class="hp" aria-hidden="true"><label>leave this empty: <input name="bot-field" tabindex="-1" autocomplete="off"></label></p>
    <label class="sub-label" for="sub-email">mailing list — releases + new tools, straight from the workshop</label>
    <div class="sub-row">
      <input id="sub-email" type="email" name="email" required placeholder="you@…" spellcheck="false" autocomplete="email">
      <button type="submit">subscribe</button>
    </div>
  </form>
  <footer class="post-foot"><a href="../news.html">← all posts</a></footer>
<script>
// AJAX post to Netlify Forms so the page never navigates — same form name as
// the homepage dialog, so submissions land in the same bucket. only works on
// the deployed site; local POSTs 404 and fall into the error branch.
const subForm = document.getElementById("subscribe");
subForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = subForm.querySelector("button");
  btn.disabled = true;
  const oldMsg = subForm.querySelector(".sub-msg");
  if (oldMsg) oldMsg.remove();
  try {
    const res = await fetch("/", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(new FormData(subForm)).toString(),
    });
    if (!res.ok) throw new Error(String(res.status));
    subForm.innerHTML = '<span class="sub-msg">signal received — you\\'re on the list</span>';
  } catch (err) {
    btn.disabled = false;
    const msg = document.createElement("span");
    msg.className = "sub-msg err";
    msg.textContent = "transmission failed — try again";
    subForm.appendChild(msg);
  }
});
</script>
</body>
</html>
`;
}

const INDEX_CSS = `${SHARED_CSS}
  body { max-width: 1060px; margin: 0 auto; }
  h1 { font-size: 14px; font-weight: 400; letter-spacing: 0.2em; color: #eee; margin: 0 0 4px; }
  .sub { margin-bottom: 28px; }
  #posts { max-width: 960px; }
  .post-row {
    display: flex;
    align-items: flex-start;
    gap: 20px;
    text-decoration: none;
    padding: 12px 10px;
    margin: 0 -10px;
    transition: background 80ms ease;
  }
  .post-row:hover { background: rgba(255, 255, 255, 0.05); }
  .post-row .thumb {
    width: 112px;
    aspect-ratio: 16 / 10;
    flex-shrink: 0;
    border: 1px solid rgba(255, 255, 255, 0.12);
  }
  .post-row .thumb img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
    filter: grayscale(1);
    opacity: 0.75;
    transition: opacity 80ms ease;
  }
  .post-row:hover .thumb img { opacity: 1; }
  .post-row .txt { min-width: 0; }
  .post-row .line { display: flex; align-items: baseline; gap: 24px; }
  .post-row .date { color: #666; font-variant-numeric: tabular-nums; flex-shrink: 0; }
  .post-row .ttl { color: rgba(255, 255, 255, 0.9); letter-spacing: 0.04em; }
  .post-row:hover .ttl { color: #fff; }
  .post-row .dek { display: block; color: #666; font-size: 12px; margin-top: 3px; }
  @media (max-width: 640px) {
    .post-row { gap: 14px; }
    .post-row .thumb { width: 84px; }
    .post-row .line { flex-direction: column; gap: 2px; }
  }`;

// one index row — shared by news.html and the homepage's news-latest.html
// snippet (both live at the site root, so the relative paths line up).
// post image paths are relative to news/ — reprefix for root-level pages.
// posts without an image keep an empty bordered slot so rows stay aligned.
function postRowHtml(p) {
  const thumb = p.meta.image
    ? `<span class="thumb"><img src="${new URL(p.meta.image, "https://x/news/").pathname.slice(1)}" alt="" loading="lazy"></span>`
    : `<span class="thumb"></span>`;
  return `    <a class="post-row" href="news/${p.slug}.html">
      ${thumb}
      <span class="txt">
        <span class="line"><span class="date">${p.meta.date}</span><span class="ttl">${esc(p.meta.title)}</span></span>${
    p.meta.dek ? `\n        <span class="dek">${esc(p.meta.dek)}</span>` : ""}
      </span>
    </a>`;
}

function indexPage(posts) {
  const rows = posts.map(postRowHtml).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
${headBlock({ title: "news", description: "newspeech — news, releases, and process notes.", url: `${SITE}/news.html`, ogImage: `${SITE}/og-image.png`, rootPrefix: "" })}
<style>${INDEX_CSS}
</style>
</head>
<body>
  <script src="nav.js"></script>
  <h1>// NEWS</h1>
  <p class="sub">news, releases, and process notes &nbsp;·&nbsp; ${posts.length} ${posts.length === 1 ? "post" : "posts"} &nbsp;·&nbsp; <a href="feed.xml">rss</a></p>
  <div id="posts">
${rows}
  </div>
<script>
// film grain — a compact standalone copy of the core.js #bg-grain layer
// (screen-blended noise tiles, ~12fps cycle, random offset per frame).
// honors the site-wide grain slider via the same localStorage key.
(function () {
  let amount = 0.5;
  try { const v = parseFloat(localStorage.getItem("newspeech.grain")); if (isFinite(v)) amount = Math.max(0, Math.min(1, v)); } catch (_) {}
  if (amount <= 0) return;
  const canvas = document.createElement("canvas");
  canvas.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2;mix-blend-mode:screen;opacity:" + (amount * 0.22).toFixed(3);
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  const tiles = [];
  for (let n = 0; n < 6; n++) {
    const off = document.createElement("canvas");
    off.width = off.height = 256;
    const octx = off.getContext("2d");
    const img = octx.createImageData(256, 256);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const fine = Math.random();
      const coarse = (Math.random() + Math.random() + Math.random()) / 3;
      const v = (fine * 0.7 + coarse * 0.3) * 200;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    tiles.push(off);
  }
  function size() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
  }
  size();
  window.addEventListener("resize", size);
  (function tick() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const tile = tiles[(performance.now() / 80 | 0) % tiles.length];
    const tw = tile.width * 1.5 * dpr, th = tile.height * 1.5 * dpr;
    const offX = -((Math.random() * tw) | 0), offY = -((Math.random() * th) | 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = offY; y < canvas.height; y += th) {
      for (let x = offX; x < canvas.width; x += tw) {
        ctx.drawImage(tile, x, y, tw, th);
      }
    }
    requestAnimationFrame(tick);
  })();
})();
</script>
</body>
</html>
`;
}

function rss(posts) {
  const items = posts.map((p) => `  <item>
    <title>${esc(p.meta.title)}</title>
    <link>${SITE}/news/${p.slug}.html</link>
    <guid>${SITE}/news/${p.slug}.html</guid>
    <pubDate>${new Date(`${p.meta.date}T12:00:00Z`).toUTCString()}</pubDate>
    <description>${esc(p.meta.dek || p.meta.title)}</description>
  </item>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
<channel>
  <title>NEWSPEECH // news</title>
  <link>${SITE}/news.html</link>
  <description>newspeech — news, releases, and process notes.</description>
${items}
</channel>
</rss>
`;
}

// =========================================================================
// build
// =========================================================================
const files = fs.existsSync(POSTS_DIR)
  ? fs.readdirSync(POSTS_DIR).filter((f) => f.endsWith(".md")).sort()
  : [];
if (!files.length) {
  console.log("build-news: no posts/*.md — skipping news build");
  process.exit(0);
}

const posts = files.map((f) => {
  const raw = fs.readFileSync(path.join(POSTS_DIR, f), "utf8");
  const { meta, body } = parseFrontmatter(raw, f);
  // slug = filename minus extension and any YYYY-MM-DD- prefix
  const slug = f.replace(/\.md$/, "").replace(/^\d{4}-\d{2}-\d{2}-/, "");
  return { slug, meta, html: mdToHtml(body) };
});
posts.sort((a, b) => b.meta.date.localeCompare(a.meta.date) || a.slug.localeCompare(b.slug));

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const p of posts) {
  fs.writeFileSync(path.join(OUT_DIR, `${p.slug}.html`), postPage(p));
}
const ASSETS = path.join(POSTS_DIR, "assets");
if (fs.existsSync(ASSETS)) {
  fs.cpSync(ASSETS, path.join(OUT_DIR, "assets"), { recursive: true });
}
fs.writeFileSync(path.join(ROOT, "news.html"), indexPage(posts));
fs.writeFileSync(path.join(ROOT, "feed.xml"), rss(posts));
// bare rows for the homepage news block (index.html fetches + injects it)
fs.writeFileSync(path.join(ROOT, "news-latest.html"), posts.slice(0, 3).map(postRowHtml).join("\n") + "\n");
console.log(`build-news: ${posts.length} ${posts.length === 1 ? "post" : "posts"} → news/, news.html, news-latest.html, feed.xml`);
