// nav.js — the unified site navigation bar.
//
// self-contained: injects its own fonts/styles/markup, applies the newspeech
// text treatment (poisson font swaps, char scrambles, jitter, chroma flashes,
// cursor proximity-kill on the wordmark), the sticky check-up behavior (hide
// on scroll-down, reveal on scroll-up), and marks the current page.
//
// usage: <script src="nav.js"></script> anywhere in <body>. the bar is fixed;
// pages that need content to clear it offset with
// calc(<their pad> + var(--ns-nav-h, 0px)) — the var tracks live bar height.
//
// the numbered visualizer pages (N-*.html) deliberately do NOT load this:
// they are fullscreen instruments and stay chrome-free.
(function () {
  "use strict";
  if (document.getElementById("ns-top")) return; // idempotent

  const IS_HOME = /(^|\/)(index\.html)?$/.test(location.pathname);

  // the page this location highlights: any post under news/ counts as news
  // (matching by filename alone would light "texture" on /news/texture.html).
  const IN_NEWS = /\/news\/[^/]+$/.test(location.pathname);
  const PAGE = IN_NEWS ? "news.html" : location.pathname.split("/").pop();
  const here = (page) => PAGE === page ? " class=\"current\"" : "";

  // pages in subdirectories (news/<slug>.html) load this as ../nav.js —
  // derive the site root from the script src so fonts + links resolve
  // from any depth.
  const src = (document.currentScript && document.currentScript.getAttribute("src")) || "nav.js";
  const ROOT = src.slice(0, src.lastIndexOf("nav.js"));

  // 3 links | wordmark | 3 links — on the homepage the site links anchor to
  // their vignettes; on sub-pages they go straight to the tools.
  // links drive straight into the tool pages; sequence is the one exception
  // (no standalone page yet — it anchors to its homepage vignette).
  // socials are icons (no data-ns-link — the text treatment skips them).
  const ICON_IG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="12" cy="12" r="4.2"/><circle cx="17.2" cy="6.8" r="1.2" fill="currentColor" stroke="none"/></svg>`;
  const ICON_YT = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M10 9.2v5.6l5-2.8z" fill="currentColor" stroke="none"/></svg>`;
  const PAGES =
    `<a href="${ROOT}news.html"${here("news.html")} data-ns-link>news</a>` +
    `<a href="${IS_HOME ? "#v-sequence" : ROOT + "index.html#v-sequence"}" data-ns-link>sequence</a>` +
    `<a href="${ROOT}texture.html"${here("texture.html")} data-ns-link>texture</a>` +
    `<a href="${ROOT}samples.html"${here("samples.html")} data-ns-link>samples</a>` +
    `<a href="${ROOT}visualizers.html"${here("visualizers.html")} data-ns-link>visuals</a>` +
    `<a href="${ROOT}live.html"${here("live.html")} data-ns-link>code</a>` +
    `<a class="ns-icon" href="https://www.instagram.com/newspeechsound" target="_blank" rel="noopener noreferrer" aria-label="instagram">${ICON_IG}</a>` +
    `<a class="ns-icon" href="https://www.youtube.com/@newspeechsound" target="_blank" rel="noopener noreferrer" aria-label="youtube">${ICON_YT}</a>`;

  const css = `
  @font-face { font-family: "zxx-sans";  src: url("${ROOT}fonts/zxx-sans.woff2")         format("woff2"); font-display: swap; }
  @font-face { font-family: "zxx-bold";  src: url("${ROOT}fonts/zxx-bold-regular.woff2") format("woff2"); font-display: swap; }
  @font-face { font-family: "zxx-noise"; src: url("${ROOT}fonts/zxx-noise.woff2")        format("woff2"); font-display: swap; }
  @font-face { font-family: "zxx-camo";  src: url("${ROOT}fonts/zxx-camo.woff2")         format("woff2"); font-display: swap; }
  @font-face { font-family: "zxx-xed";   src: url("${ROOT}fonts/zxx-xed.woff2")          format("woff2"); font-display: swap; }

  #ns-top {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 10;
    background: #050505;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    transition: transform 0.28s ease;
    /* the 1px line spans the full bar; the links live in a 1280 container */
    border-bottom: 1px solid rgba(255, 255, 255, 0.18);
  }
  #ns-top.nav-hidden { transform: translateY(-100%); }
  #ns-links {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 32px;
    max-width: 1280px;
    margin: 0 auto;
    padding: 20px;
    font-size: 13px;
    line-height: 18px; /* fixed in px so swapping fonts can't shift line-box height */
    letter-spacing: 0.04em;
  }
  #ns-pages {
    display: flex;
    align-items: center;
    gap: 28px;
  }
  .ns-icon { opacity: 0.5; transition: opacity 120ms ease; }
  .ns-icon:hover { opacity: 1; }
  .ns-icon svg { width: 17px; height: 17px; display: block; }
  #ns-burger {
    display: none;
    background: none;
    border: 0;
    color: #fff;
    cursor: pointer;
    padding: 4px;
    opacity: 0.8;
  }
  #ns-burger svg { width: 22px; height: 22px; display: block; }

  /* ---- mobile takeover menu ---- */
  #ns-overlay {
    position: fixed;
    inset: 0;
    z-index: 30;
    background: #050505;
    display: none;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  #ns-overlay.open { display: flex; }
  #ns-overlay .ov-link {
    color: #fff;
    text-decoration: none;
    font-size: 20px;
    letter-spacing: 0.12em;
    padding: 12px 24px;
    opacity: 0.5;
  }
  #ns-overlay .ov-link.current { opacity: 1; }
  #ns-overlay .ov-close {
    position: absolute;
    top: 10px;
    right: 12px;
    background: none;
    border: 0;
    color: #fff;
    font-family: inherit;
    font-size: 28px;
    line-height: 1;
    padding: 12px;
    cursor: pointer;
    opacity: 0.8;
  }
  #ns-overlay .ov-icons {
    position: absolute;
    bottom: 44px;
    display: flex;
    gap: 36px;
  }
  #ns-overlay .ov-icons a { color: #fff; opacity: 0.6; }
  #ns-overlay .ov-icons svg { width: 22px; height: 22px; display: block; }
  #ns-links a {
    color: #fff;
    text-decoration: none;
    display: inline-flex;
    cursor: pointer;
  }
  /* page links rest dim, current page bright; the wordmark stays bright */
  #ns-links a[data-ns-link] {
    opacity: 0.5;
    transition: opacity 120ms ease;
  }
  #ns-links a[data-ns-link]:hover { opacity: 1; }
  #ns-links a span { display: inline-block; }
  #ns-links a.current { opacity: 1; }
  #ns-stage {
    color: #fff;
    text-decoration: none;
    font-family: "zxx-sans", monospace;
    font-size: clamp(18px, 2vw, 26px);
    letter-spacing: 0.04em;
    line-height: 1;
    user-select: none;
  }
  #ns-stage span { display: inline-block; will-change: transform; }
  #ns-stage.chroma {
    text-shadow:
      -2px 0 0 #00ffff,
       2px 0 0 #ff00ff;
  }
  /* the full link row gets cramped below ~1024 — switch to burger + takeover */
  @media (max-width: 1024px) {
    #ns-links { padding: 14px 20px; }
    #ns-stage { font-size: 22px; }
    #ns-pages { display: none; }
    #ns-burger { display: inline-flex; }
  }`;

  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "ns-top";
  const ICON_BURGER = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 6.5h18M3 12h18M3 17.5h18"/></svg>`;
  root.innerHTML =
    `<nav id="ns-links">` +
    `<a id="ns-stage" href="${ROOT}index.html" aria-label="newspeech">NEWSPEECH</a>` +
    `<div id="ns-pages">${PAGES}</div>` +
    `<button id="ns-burger" aria-label="menu" aria-expanded="false">${ICON_BURGER}</button></nav>`;
  document.body.insertBefore(root, document.body.firstChild);

  // ---- mobile takeover: links centered, socials at the bottom ----
  // plain links (no data-ns-link): the scramble treatment locks char widths
  // at startup, and these are display:none then — they'd measure as 0.
  const cur = (page) => PAGE === page ? " current" : "";
  const overlay = document.createElement("div");
  overlay.id = "ns-overlay";
  overlay.innerHTML =
    `<button class="ov-close" aria-label="close">×</button>` +
    `<a class="ov-link${cur("news.html")}" href="${ROOT}news.html">news</a>` +
    `<a class="ov-link" href="${IS_HOME ? "#v-sequence" : ROOT + "index.html#v-sequence"}">sequence</a>` +
    `<a class="ov-link${cur("texture.html")}" href="${ROOT}texture.html">texture</a>` +
    `<a class="ov-link${cur("samples.html")}" href="${ROOT}samples.html">samples</a>` +
    `<a class="ov-link${cur("visualizers.html")}" href="${ROOT}visualizers.html">visuals</a>` +
    `<a class="ov-link${cur("live.html")}" href="${ROOT}live.html">code</a>` +
    `<div class="ov-icons">` +
    `<a href="https://www.instagram.com/newspeechsound" target="_blank" rel="noopener noreferrer" aria-label="instagram">${ICON_IG}</a>` +
    `<a href="https://www.youtube.com/@newspeechsound" target="_blank" rel="noopener noreferrer" aria-label="youtube">${ICON_YT}</a>` +
    `</div>`;
  document.body.appendChild(overlay);

  const burger = document.getElementById("ns-burger");
  function setMenuOpen(open) {
    overlay.classList.toggle("open", open);
    burger.setAttribute("aria-expanded", String(open));
    // lock page scroll behind the takeover (scroll-snap lives on <html>)
    document.documentElement.style.overflow = open ? "hidden" : "";
  }
  burger.addEventListener("click", () => setMenuOpen(true));
  overlay.querySelector(".ov-close").addEventListener("click", () => setMenuOpen(false));
  overlay.addEventListener("click", (e) => { if (e.target.closest("a")) setMenuOpen(false); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenuOpen(false); });
  window.addEventListener("resize", () => { if (window.innerWidth > 1024) setMenuOpen(false); });

  // ---- live bar height → --ns-nav-h (wrapping changes it on mobile) ----
  function syncHeight() {
    document.documentElement.style.setProperty("--ns-nav-h", root.offsetHeight + "px");
  }
  window.addEventListener("resize", syncHeight);
  syncHeight();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(syncHeight);

  // ---- sticky check-up: hide on scroll-down, reveal on scroll-up ----
  // 6px dead-zone so snap-scroll jitter doesn't flicker the bar; always
  // visible near the very top. no-op on non-scrolling pages.
  let lastScrollTop = window.scrollY;
  window.addEventListener("scroll", () => {
    const y = window.scrollY;
    const delta = y - lastScrollTop;
    if (Math.abs(delta) < 6) return;
    if (y < 80) root.classList.remove("nav-hidden");
    else root.classList.toggle("nav-hidden", delta > 0);
    lastScrollTop = y;
  }, { passive: true });

  // ================= text treatment =================
  // a compact copy of the homepage hero treatment, scoped to the bar. the
  // intensity envelope here is local (slow LFO + mouse activity) so the bar
  // behaves identically on pages without the hero's audio/visual envelope.

  let mouseActivity = 0;
  let lastMX = -10000, lastMY = -10000;
  window.addEventListener("mousemove", (e) => {
    const dist = Math.hypot(e.clientX - lastMX, e.clientY - lastMY);
    lastMX = e.clientX;
    lastMY = e.clientY;
    mouseActivity = Math.min(1, mouseActivity + dist * 0.004);
  });

  function intensity() {
    const t = performance.now();
    const sum = 0.5
      + 0.25 * Math.sin(t / 17000)
      + 0.18 * Math.sin(t / 31000)
      + 0.12 * Math.sin(t / 47000);
    return Math.max(0, Math.min(1, sum + mouseActivity * 0.4));
  }

  function poisson(rateFn, fire) {
    (function step() {
      const ratePerMs = Math.max(0.0001, rateFn()) / 1000;
      const wait = -Math.log(1 - Math.random()) / ratePerMs;
      setTimeout(() => { fire(); step(); }, wait);
    })();
  }

  // ---- wordmark: per-char font swaps, jitter, chroma, proximity-kill ----
  const FONTS = [
    ["zxx-sans",  1],
    ["zxx-bold",  0],
    ["zxx-noise", 7],
    ["zxx-camo",  3],
    ["zxx-xed",   5],
  ];
  const TOTAL_W = FONTS.reduce((a, [, w]) => a + w, 0);
  function pickFont() {
    let r = Math.random() * TOTAL_W;
    for (const [f, w] of FONTS) {
      r -= w;
      if (r <= 0) return f;
    }
    return FONTS[FONTS.length - 1][0];
  }

  const stage = document.getElementById("ns-stage");
  const spans = [...stage.textContent].map((ch) => {
    const s = document.createElement("span");
    s.textContent = ch;
    s.style.fontFamily = '"zxx-sans", monospace';
    s._hoverI = 0;
    s._reviveAt = 0;
    return s;
  });
  stage.textContent = "";
  for (const s of spans) stage.appendChild(s);

  for (const s of spans) {
    poisson(
      () => 0.7 + 7.7 * intensity() + 21 * s._hoverI,
      () => { s.style.fontFamily = `"${pickFont()}", monospace`; }
    );
  }

  const JITTER_X = 4; // nav-scale: keep jitter inside the bar
  for (const s of spans) {
    poisson(
      () => 0.030 + 0.270 * intensity() + 0.8 * s._hoverI,
      () => {
        const boost = 1 + 3 * s._hoverI;
        const jx = (Math.random() * 2 - 1) * JITTER_X * boost;
        s.style.transform = `translateX(${jx.toFixed(1)}px)`;
        setTimeout(() => { s.style.transform = ""; }, 80 + Math.random() * 140);
      }
    );
  }

  function chroma(ms) {
    stage.classList.add("chroma");
    setTimeout(() => stage.classList.remove("chroma"), ms);
  }
  poisson(
    () => 0.05 + 0.95 * intensity(),
    () => chroma(80 + Math.random() * 80)
  );

  // proximity-kill: chars die within KILL px of the cursor, revive as a
  // probabilistic binary flicker (no smooth tween — bar vocabulary matches
  // the rest of the site). constants scaled to the nav-size wordmark.
  const HOVER_KILL_DIST = 14;
  const HOVER_RADIUS = 110;
  const REVIVE_MS = 250;
  function updateHover(t) {
    for (const s of spans) {
      const r = s.getBoundingClientRect();
      const dist = Math.hypot(r.left + r.width / 2 - lastMX, r.top + r.height / 2 - lastMY);
      if (dist < HOVER_KILL_DIST) {
        s.style.opacity = "0";
        s._reviveAt = t + REVIVE_MS;
        s._hoverI = 1;
      } else {
        s._hoverI = dist < HOVER_RADIUS
          ? 1 - (dist - HOVER_KILL_DIST) / (HOVER_RADIUS - HOVER_KILL_DIST)
          : 0;
        if (s._reviveAt && t < s._reviveAt) {
          const p = 1 - (s._reviveAt - t) / REVIVE_MS;
          s.style.opacity = Math.random() < p ? "1" : "0";
        } else if (s._reviveAt) {
          s.style.opacity = "1";
          s._reviveAt = 0;
        }
      }
    }
  }

  let lastT = performance.now();
  requestAnimationFrame(function loop(t) {
    const dt = (t - lastT) / 1000;
    lastT = t;
    mouseActivity = Math.max(0, mouseActivity - 1.2 * dt);
    updateHover(t);
    requestAnimationFrame(loop);
  });

  // ---- links: font cycle on hover + ambient char scrambles ----
  const LINK_FONT_CYCLE = ["zxx-sans", "zxx-noise", "zxx-camo", "zxx-xed"];
  const LINK_CYCLE_MS = 80;
  const SCRAMBLE_CHARS = "#*/\\_+=~<>.,:;|?!@$%^&-";

  // lock each char slot to its max width across the cycled variants so the
  // link box can't flex while fonts swap. measuring requires layout: below
  // the burger breakpoint #ns-pages is display:none and every char measures
  // 0 — locking then would freeze the links at zero width. so lock lazily,
  // the first time the desktop row is actually visible.
  const deskMq = window.matchMedia("(min-width: 1025px)");
  const lockables = [];
  let widthsLocked = false;
  function lockLinkWidths() {
    if (widthsLocked || !deskMq.matches) return;
    widthsLocked = true;
    for (const spans of lockables) {
      for (const s of spans) {
        let maxW = s.getBoundingClientRect().width;
        for (const fam of LINK_FONT_CYCLE) {
          s.style.fontFamily = `"${fam}", monospace`;
          const w = s.getBoundingClientRect().width;
          if (w > maxW) maxW = w;
        }
        s.style.fontFamily = "";
        s.style.width = `${(Math.ceil(maxW * 10) / 10).toFixed(1)}px`;
      }
    }
  }
  if (deskMq.addEventListener) deskMq.addEventListener("change", lockLinkWidths);

  async function setupLinks() {
    if (document.fonts && document.fonts.load) {
      await Promise.all(LINK_FONT_CYCLE.map((fam) => document.fonts.load(`13px "${fam}"`)));
    }
    document.querySelectorAll("[data-ns-link]").forEach((link) => {
      const txt = link.textContent;
      link.textContent = "";
      const charSpans = [...txt].map((ch) => {
        const s = document.createElement("span");
        const display = ch === " " ? " " : ch;
        s.textContent = display;
        s.dataset.original = display;
        s.style.display = "inline-block";
        s.style.textAlign = "center";
        link.appendChild(s);
        return s;
      });

      lockables.push(charSpans);

      const idx = charSpans.map(() => (Math.random() * LINK_FONT_CYCLE.length) | 0);
      let timer = null;
      link.addEventListener("mouseenter", () => {
        if (timer) return;
        timer = setInterval(() => {
          for (let i = 0; i < charSpans.length; i++) {
            idx[i] = (idx[i] + 1) % LINK_FONT_CYCLE.length;
            charSpans[i].style.fontFamily = `"${LINK_FONT_CYCLE[idx[i]]}", monospace`;
          }
        }, LINK_CYCLE_MS);
      });
      link.addEventListener("mouseleave", () => {
        clearInterval(timer);
        timer = null;
        for (const s of charSpans) s.style.fontFamily = "";
      });

      poisson(
        () => 0.1 + 0.15 * intensity(),
        () => {
          if (link._scrambling) return;
          const targets = charSpans.filter((s) => s.dataset.original.trim() !== "" && Math.random() < 0.55);
          if (!targets.length) return;
          link._scrambling = true;
          let cycles = 2 + ((Math.random() * 3) | 0);
          (function tick() {
            if (cycles-- <= 0) {
              for (const s of targets) s.textContent = s.dataset.original;
              link._scrambling = false;
              return;
            }
            for (const s of targets) {
              s.textContent = SCRAMBLE_CHARS[(Math.random() * SCRAMBLE_CHARS.length) | 0];
            }
            setTimeout(tick, 50 + Math.random() * 60);
          })();
        }
      );
    });
    lockLinkWidths(); // no-op if the row is hidden; the mq listener retries
  }
  setupLinks();

  // pages can flash the wordmark (the homepage's click-punch uses this)
  window.NSNav = { chroma };
})();
