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
  const here = (page) => location.pathname.endsWith("/" + page) ? " class=\"current\"" : "";

  // 3 links | wordmark | 3 links — on the homepage the site links anchor to
  // their vignettes; on sub-pages they go straight to the tools.
  const LEFT =
    `<a href="${IS_HOME ? "#v-sequence" : "index.html#v-sequence"}" data-ns-link>sequence</a>` +
    `<a href="${IS_HOME ? "#v-texture" : "texture.html"}"${here("texture.html")} data-ns-link>texture</a>` +
    `<a href="${IS_HOME ? "#v-samples" : "samples.html"}"${here("samples.html")} data-ns-link>samples</a>`;
  const RIGHT =
    `<a href="${IS_HOME ? "#v-visuals" : "visualizers.html"}"${here("visualizers.html")} data-ns-link>visuals</a>` +
    `<a href="${IS_HOME ? "#v-code" : "live.html"}"${here("live.html")} data-ns-link>code</a>` +
    `<a href="https://www.instagram.com/newspeechsound" target="_blank" rel="noopener noreferrer" data-ns-link>instagram</a>`;

  const css = `
  @font-face { font-family: "zxx-sans";  src: url("fonts/zxx-sans.woff2")         format("woff2"); font-display: swap; }
  @font-face { font-family: "zxx-bold";  src: url("fonts/zxx-bold-regular.woff2") format("woff2"); font-display: swap; }
  @font-face { font-family: "zxx-noise"; src: url("fonts/zxx-noise.woff2")        format("woff2"); font-display: swap; }
  @font-face { font-family: "zxx-camo";  src: url("fonts/zxx-camo.woff2")         format("woff2"); font-display: swap; }
  @font-face { font-family: "zxx-xed";   src: url("fonts/zxx-xed.woff2")          format("woff2"); font-display: swap; }

  #ns-top {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 10;
    background: #050505;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    transition: transform 0.28s ease;
  }
  #ns-top.nav-hidden { transform: translateY(-100%); }
  #ns-links {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 32px;
    padding: 20px 40px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.18);
    font-size: 13px;
    line-height: 18px; /* fixed in px so swapping fonts can't shift line-box height */
    letter-spacing: 0.04em;
  }
  #ns-links a {
    color: #fff;
    text-decoration: none;
    display: inline-flex;
    cursor: pointer;
  }
  #ns-links a span { display: inline-block; }
  #ns-links a.current { opacity: 0.45; }
  #ns-stage {
    color: #fff;
    text-decoration: none;
    font-family: "zxx-sans", monospace;
    font-size: clamp(18px, 2vw, 26px);
    letter-spacing: 0.04em;
    line-height: 1;
    user-select: none;
    padding: 0 16px;
  }
  #ns-stage span { display: inline-block; will-change: transform; }
  #ns-stage.chroma {
    text-shadow:
      -2px 0 0 #00ffff,
       2px 0 0 #ff00ff;
  }
  @media (max-width: 640px) {
    #ns-links {
      flex-wrap: wrap;
      gap: 12px 18px;
      padding: 14px 20px;
    }
    #ns-stage {
      order: -1;
      flex-basis: 100%;
      text-align: center;
      font-size: 26px;
      padding: 4px 0 10px;
    }
  }`;

  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "ns-top";
  root.innerHTML =
    `<nav id="ns-links">${LEFT}` +
    `<a id="ns-stage" href="index.html" aria-label="newspeech">NEWSPEECH</a>` +
    `${RIGHT}</nav>`;
  document.body.insertBefore(root, document.body.firstChild);

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

      // lock each char slot to its max width across the cycled variants so
      // the link box can't flex while fonts swap
      for (const s of charSpans) {
        let maxW = s.getBoundingClientRect().width;
        for (const fam of LINK_FONT_CYCLE) {
          s.style.fontFamily = `"${fam}", monospace`;
          const w = s.getBoundingClientRect().width;
          if (w > maxW) maxW = w;
        }
        s.style.fontFamily = "";
        s.style.width = `${(Math.ceil(maxW * 10) / 10).toFixed(1)}px`;
      }

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
  }
  setupLinks();

  // pages can flash the wordmark (the homepage's click-punch uses this)
  window.NSNav = { chroma };
})();
