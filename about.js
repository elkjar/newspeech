// about.js — the about page's record + wear (about.html, built by
// tools/build-about.mjs, sets window.CLIMATE before loading this).
//
// the page background is the warming stripes, one band per year, 1850 at the
// top of <main> → 2025 at the bottom. two kinds of breaking, both following
// the anomaly:
//   - built in, by position: each section is as broken as the year it sits
//     on — paragraphs slip sideways, heading letters drift off the line, a
//     share of the characters rot to ghosts. the top reads clean; the bottom
//     is wrecked.
//   - live, by the reading line (the year under the middle of the screen):
//     heading scrambles, section tears (strips of a section jump sideways),
//     chroma flicker, page jolts, stripe tears + flash bands, grain. the live
//     layer runs full while you scroll and eases to ~an eighth once you stop
//     to read — the page breaks as you move through it, holds when you don't.
// prefers-reduced-motion keeps the stripes and drops all of it.
(() => {
  "use strict";
  const T = window.CLIMATE.temps; // [[year, anomaly °C]]
  const N = T.length;
  // a gently smoothed series for the built-in damage (one hot year shouldn't
  // wreck a section more than the decade around it)
  const S = T.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - 5); k <= Math.min(N - 1, i + 5); k++) { sum += T[k][1]; n++; }
    return sum / n;
  });
  const lo = Math.min(...T.map((t) => t[1])), hi = Math.max(...T.map((t) => t[1]));
  const norm = (a) => Math.max(0, Math.min(1, (a - lo) / (hi - lo)));
  const sLo = Math.min(...S), sHi = Math.max(...S);
  const sNorm = (a) => Math.max(0, Math.min(1, (a - sLo) / (sHi - sLo)));

  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const main = document.querySelector("main");
  const cv = document.getElementById("record");
  const ctx = cv.getContext("2d");
  const grain = document.getElementById("grain");
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---- the stripes ----
  let tears = []; // {i, dx, flash}
  function draw() {
    const w = cv.clientWidth, h = cv.clientHeight, dpr = Math.min(2, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bh = h / N;
    for (let i = 0; i < N; i++) {
      const y = Math.floor(i * bh), bhh = Math.ceil(bh) + 1;
      const t = tears.find((x) => x.i === i);
      if (t && t.flash) { ctx.fillStyle = "rgb(235,235,235)"; ctx.fillRect(0, y, w, bhh); continue; }
      // mono: near-black for the coolest years up to a mid grey for the warmest
      const l = Math.round(6 + norm(T[i][1]) * 60);
      ctx.fillStyle = `rgb(${l},${l},${l})`;
      ctx.fillRect(t ? t.dx : 0, y, w, bhh);
      if (t) { ctx.fillStyle = "#050505"; ctx.fillRect(t.dx < 0 ? w + t.dx : 0, y, Math.abs(t.dx), bhh); }
    }
  }
  new ResizeObserver(draw).observe(cv);

  // where an element sits on the record: 0..1 (smoothed anomaly at its center)
  function damageAt(el) {
    const m = main.getBoundingClientRect(), r = el.getBoundingClientRect();
    const f = ((r.top + r.bottom) / 2 - m.top) / m.height;
    const i = Math.max(0, Math.min(N - 1, Math.floor(f * N)));
    return sNorm(S[i]);
  }

  // ---- the reading line ----
  let cur = 0;
  const wear = () => norm(T[cur][1]);
  function sync() {
    const r = main.getBoundingClientRect();
    const f = (window.innerHeight * 0.5 - r.top) / r.height;
    cur = Math.max(0, Math.min(N - 1, Math.floor(f * N)));
    // grain belongs to the record — it thins out as the page gives way to the footer
    const onScreen = Math.max(0, Math.min(1, r.bottom / window.innerHeight));
    if (!reduce) grain.style.opacity = String((0.04 + 0.42 * Math.pow(wear(), 1.3)) * onScreen);
  }
  window.addEventListener("scroll", sync, { passive: true });
  window.addEventListener("resize", sync);
  sync();

  if (reduce) return;

  // events per second at the CURRENT wear: every effect is checked on one
  // shared ~25 Hz tick, so a fast scroll into the warm end breaks at once
  // (scheduling each next event from the rate at the last one would leave a
  // reader who scrolls quickly waiting on a wait drawn from the cool top)
  const hazards = [];
  function poisson(rateFn, fire) { hazards.push({ rateFn, fire }); }
  // scroll activity: 1 while moving, easing to 0 over ~1.5 s once still
  let moving = 0, lastY = window.scrollY;
  window.addEventListener("scroll", () => {
    moving = Math.min(1, moving + Math.abs(window.scrollY - lastY) / 120);
    lastY = window.scrollY;
  }, { passive: true });
  const live = () => 0.12 + 0.88 * moving;
  let lastTick = performance.now();
  setInterval(() => {
    const now = performance.now(), dt = Math.min(0.25, (now - lastTick) / 1000);
    lastTick = now;
    moving = Math.max(0, moving - dt / 1.5);
    if (document.hidden) return;
    const m = live();
    for (const h of hazards) if (Math.random() < 1 - Math.exp(-h.rateFn() * m * dt)) h.fire();
  }, 40);
  const FONTS = ["zxx-sans", "zxx-noise", "zxx-camo", "zxx-xed"];
  const GLYPHS = "#*/\\_+=~<>.,:;|?!@$%^&-";

  // ================= built in: damage by position =================
  // split every text node of an element into per-char spans (keeps <strong>,
  // <a> etc. intact around them)
  function charSpans(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const frag = document.createDocumentFragment();
      for (const ch of node.textContent) {
        if (/\s/.test(ch)) { frag.appendChild(document.createTextNode(ch)); continue; }
        const s = document.createElement("span");
        s.className = "ch";
        s.textContent = ch;
        frag.appendChild(s);
        out.push(s);
      }
      node.replaceWith(frag);
    }
    return out;
  }

  const sections = [...document.querySelectorAll(".s")];
  const damage = new Map(); // section → 0..1
  function build() {
    for (const sec of sections) {
      const d = damageAt(sec);
      damage.set(sec, d);
      // the coolest stretch of the record reads clean; damage starts after it
      const k = Math.pow(Math.max(0, (d - 0.15) / 0.85), 1.1);
      // paragraphs slip sideways, alternating, more the lower they sit
      [...sec.querySelectorAll(".copy > *")].forEach((p, j) => {
        const dx = (j % 2 ? 1 : -1) * k * rand(14, 52);
        p.style.transform = `translateX(${dx.toFixed(1)}px)`;
      });
      // the heading's letters drift off the line
      for (const s of sec.querySelectorAll("h1 [data-o], h2 [data-o]")) {
        s.style.transform = `translate(${(k * rand(-14, 14)).toFixed(1)}px, ${(k * rand(-30, 30)).toFixed(1)}px) rotate(${(k * rand(-18, 18)).toFixed(1)}deg)`;
      }
      // a share of the characters rot to ghosts — still there, still readable
      for (const s of sec._chars) {
        if (s._t === undefined) s._t = Math.random();
        s.classList.toggle("rot", s._t < k * 0.12);
        s.classList.toggle("gone", s._t < k * 0.025);
      }
    }
  }

  // headings (the lead h1 + the section h2s): wrap for scrambles + drift
  for (const el of document.querySelectorAll("[data-wear]")) {
    const txt = el.textContent;
    el.textContent = "";
    for (const ch of txt) {
      const s = document.createElement("span");
      s.textContent = ch === " " ? " " : ch;
      s.dataset.o = s.textContent;
      el.appendChild(s);
    }
  }
  for (const sec of sections) sec._chars = charSpans(sec.querySelector(".copy"));
  // measure once the fonts have settled (positions shift as zxx loads)
  (document.fonts ? document.fonts.ready : Promise.resolve()).then(build);
  let rebuildT = 0;
  window.addEventListener("resize", () => { clearTimeout(rebuildT); rebuildT = setTimeout(build, 200); });

  // ================= live: the reading line =================
  // heading scrambles, faster + wider as it warms
  for (const el of document.querySelectorAll("[data-wear]")) {
    const live = [...el.children].filter((s) => s.dataset.o.trim());
    poisson(() => 0.2 + 9 * Math.pow(wear(), 1.3), () => {
      const n = 1 + Math.floor(Math.pow(wear(), 1.2) * live.length);
      const hit = [...live].sort(() => Math.random() - 0.5).slice(0, n);
      for (const s of hit) {
        if (Math.random() < 0.5) s.style.fontFamily = `"${FONTS[(Math.random() * FONTS.length) | 0]}", monospace`;
        else s.textContent = GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      setTimeout(() => { for (const s of hit) { s.textContent = s.dataset.o; s.style.fontFamily = ""; } }, 70 + Math.random() * 220);
    });
  }

  // body characters flip to glyphs for a moment, near the reading line
  function nearest() {
    const mid = window.innerHeight / 2;
    let best = null;
    for (const sec of sections) {
      const r = sec.getBoundingClientRect();
      const dist = Math.abs((r.top + r.bottom) / 2 - mid);
      if (r.bottom > 0 && r.top < window.innerHeight && (!best || dist < best.dist)) best = { sec, dist };
    }
    return best && best.sec;
  }
  poisson(() => 0.2 + 10 * Math.pow(wear(), 1.6), () => {
    const sec = nearest(); if (!sec) return;
    const ch = sec._chars;
    const n = 1 + ((Math.random() * (2 + 10 * wear())) | 0);
    const hit = Array.from({ length: n }, () => ch[(Math.random() * ch.length) | 0]);
    for (const s of hit) { s._o = s._o || s.textContent; s.textContent = GLYPHS[(Math.random() * GLYPHS.length) | 0]; }
    setTimeout(() => { for (const s of hit) s.textContent = s._o; }, 60 + Math.random() * 140);
  });

  // section tears: strips of the nearest section jump sideways — clones of
  // the block, each clipped to a horizontal strip, on a solid ground so the
  // strip reads as torn out and put back wrong
  poisson(() => 0.06 + 5 * Math.pow(Math.max(0, wear() - 0.1), 1.3), () => {
    const sec = nearest(); if (!sec) return;
    const inner = sec.querySelector(".in");
    const h = inner.offsetHeight;
    const strips = 1 + ((Math.random() * (2 + 9 * wear())) | 0);
    const made = [];
    for (let k = 0; k < strips; k++) {
      const top = rand(0, h * 0.92), sh = rand(6, 20 + 160 * wear());
      const c = inner.cloneNode(true);
      c.classList.add("tear");
      c.setAttribute("aria-hidden", "true");
      c.style.cssText = `position:absolute;left:${inner.offsetLeft}px;top:${inner.offsetTop}px;width:${inner.offsetWidth}px;` +
        `clip-path:inset(${top.toFixed(0)}px 0 ${Math.max(0, h - top - sh).toFixed(0)}px 0);` +
        `transform:translateX(${((Math.random() < 0.5 ? -1 : 1) * rand(16, 60 + 360 * wear())).toFixed(0)}px);`;
      inner.parentNode.appendChild(c);
      made.push(c);
    }
    setTimeout(() => made.forEach((c) => c.remove()), 70 + Math.random() * 180);
  });

  // chroma: the nearest section fringes; when it's hot, the whole page does
  poisson(() => 0.1 + 6 * Math.pow(wear(), 1.6), () => {
    const target = wear() > 0.55 && Math.random() < 0.5 ? main : (nearest() || main).querySelector(".copy") || main;
    target.classList.add("chroma");
    setTimeout(() => target.classList.remove("chroma"), 60 + Math.random() * 120);
  });

  // jolts: the whole record shifts, then snaps back
  const wrap = main.querySelector(".wrap");
  poisson(() => 0.02 + 4 * Math.pow(Math.max(0, wear() - 0.25), 1.5), () => {
    const dx = (Math.random() < 0.5 ? -1 : 1) * rand(4, 8 + 60 * wear());
    const dy = rand(-10, 10) * wear();
    wrap.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    setTimeout(() => { wrap.style.transform = ""; }, 50 + Math.random() * 90);
  });

  // stripe tears + flash bands around the reading line
  poisson(() => 0.1 + 14 * Math.pow(Math.max(0, wear() - 0.1), 1.3), () => {
    const k = 1 + ((Math.random() * (4 + 26 * wear())) | 0);
    tears = Array.from({ length: k }, () => ({
      i: Math.max(0, Math.min(N - 1, cur + ((Math.random() * 30) | 0) - 15)),
      dx: (Math.random() < 0.5 ? -1 : 1) * rand(30, 60 + 600 * wear()),
      flash: wear() > 0.4 && Math.random() < 0.22 * wear(),
    }));
    draw();
    setTimeout(() => { tears = []; draw(); }, 70 + Math.random() * 200);
  });

  // grain: pre-made noise tiles, cycled
  const tiles = Array.from({ length: 4 }, () => {
    const c = document.createElement("canvas"); c.width = c.height = 256;
    const g = c.getContext("2d"), img = g.createImageData(256, 256);
    for (let p = 0; p < img.data.length; p += 4) {
      const v = Math.random() < 0.5 ? 0 : (Math.random() * 255) | 0;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v; img.data[p + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    return `url(${c.toDataURL()})`;
  });
  let gi = 0;
  setInterval(() => { grain.style.backgroundImage = tiles[gi++ % tiles.length]; }, 90);
})();
