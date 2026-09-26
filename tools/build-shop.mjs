#!/usr/bin/env node
// build-shop.mjs — one static page per shop.json product.
//
// shop.json in, shop/<id>.html out (gitignored; build.sh runs this per deploy).
// the page is real HTML — name, price, photos, copy, its own og: share card
// and Product JSON-LD — so a shared link previews properly. what's live
// (sold out, draft visibility) and the cart come from shop.js at runtime,
// same as the shelf.
//
// per product, beyond what the shelf reads:
//   images        list of photos, first one is the card + share image
//   color         true → photos in colour (default: greyscale, like the site)
//   audio         [{ title, src }] preview clips for music
//   longer copy   products/<id>.md if it exists (the site's markdown subset,
//                 tools/md.mjs), else a `description` string in shop.json
//
// run from the repo root: node tools/build-shop.mjs
import fs from "node:fs";
import path from "node:path";
import { esc, mdToHtml } from "./md.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT_DIR = path.join(ROOT, "shop");
const COPY_DIR = path.join(ROOT, "products");
const SITE = "https://www.newspeechsound.com";

const cat = JSON.parse(fs.readFileSync(path.join(ROOT, "shop.json"), "utf8"));
const money = (c) => "$" + (c % 100 ? (c / 100).toFixed(2) : String(c / 100));
const attr = (s) => esc(String(s)).replace(/"/g, "&quot;");
const images = (p) => (Array.isArray(p.images) && p.images.length ? p.images : p.image ? [p.image] : []);
const abs = (p) => (/^https?:\/\//.test(p) ? p : `${SITE}/${p.replace(/^\//, "")}`);
const rel = (p) => (/^https?:\/\//.test(p) ? p : `../${p.replace(/^\//, "")}`);

function copyFor(p) {
  const file = path.join(COPY_DIR, `${p.id}.md`);
  if (fs.existsSync(file)) return mdToHtml(fs.readFileSync(file, "utf8"));
  return p.description ? mdToHtml(p.description) : "";
}

// shipping, spelled out from the catalog so the page never drifts from it
function shippingLine() {
  return Object.values(cat.shipping)
    .map((r) => `${r.label === "us" ? "US" : r.label}: ${money(r.first)} for the first item, +${money(r.additional)} each after`)
    .join(" · ");
}

const PAGE_CSS = `
  .crumb { display: flex; justify-content: space-between; align-items: center; gap: 16px; margin-bottom: 18px; }
  .crumb a { color: #777; text-decoration: none; letter-spacing: 0.2em; font-size: 11px; }
  .crumb a:hover { color: #fff; }

  .pdp { display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(0, 1fr); gap: 28px; align-items: start; }
  .gallery { min-width: 0; }
  .main { aspect-ratio: 1; background: #0a0a0a; border: 1px solid #1c1c1c; position: relative; overflow: hidden; cursor: pointer; }
  .main img { width: 100%; height: 100%; object-fit: cover; display: block; filter: grayscale(1); }
  .color .main img, .color .thumbs img { filter: none; }
  .main .ph {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; padding: 32px;
    font-family: "zxx-noise", ui-monospace, monospace; font-size: 48px; line-height: 1.05; text-align: center;
    color: rgba(255,255,255,.16); text-transform: uppercase; word-break: break-word;
  }
  .main .count { position: absolute; bottom: 10px; right: 10px; font-size: 10px; letter-spacing: 0.14em; color: #999; background: rgba(5,5,5,.8); padding: 1px 6px; }
  .thumbs { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  .thumbs button { padding: 0; width: 72px; height: 72px; border: 1px solid #1c1c1c; background: #0a0a0a; overflow: hidden; }
  .thumbs button.on { border-color: #ddd; }
  .thumbs img { width: 100%; height: 100%; object-fit: cover; display: block; filter: grayscale(1); opacity: .7; }
  .thumbs button.on img, .thumbs button:hover img { opacity: 1; }

  .info { position: sticky; top: calc(24px + var(--ns-nav-h, 0px)); display: flex; flex-direction: column; gap: 14px; min-width: 0; }
  .info .tag { align-self: flex-start; font-size: 10px; letter-spacing: 0.18em; text-transform: uppercase; color: #050505; background: #ddd; padding: 1px 6px; }
  .info h1 { font-family: "zxx-sans", ui-monospace, monospace; font-size: 26px; line-height: 1.15; letter-spacing: 0.04em; text-transform: lowercase; margin: 0; }
  .info .price { color: #bbb; font-size: 14px; font-variant-numeric: tabular-nums; }
  .info .blurb { color: #999; margin: 0; }
  .buyrow { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .buyrow .buy { padding: 10px 20px; border-color: #ddd; color: #fff; }
  .buyrow .msg { color: #666; }
  .gone { color: #999; }

  .tracks { border-top: 1px solid #1c1c1c; padding-top: 12px; display: flex; flex-direction: column; gap: 2px; }
  .tracks .lbl { color: #666; font-size: 10px; text-transform: uppercase; letter-spacing: 0.14em; margin-bottom: 6px; }
  .track { display: grid; grid-template-columns: auto 1fr auto; gap: 10px; align-items: center; padding: 6px 0; border: 0; text-align: left; color: #bbb; letter-spacing: 0.04em; }
  .track:hover { color: #fff; }
  .track .ic { width: 14px; color: #888; }
  .track.on .ic, .track.on { color: #fff; }
  .tracks .track.on, .tracks .track:hover { background: none; border: 0; } /* not the generic button.on fill */
  .track .t { font-variant-numeric: tabular-nums; color: #666; }
  .track .bar { grid-column: 2 / -1; height: 1px; background: #1c1c1c; position: relative; }
  .track .bar i { position: absolute; left: 0; top: 0; bottom: 0; background: #ddd; width: 0; }

  .copy { border-top: 1px solid #1c1c1c; padding-top: 14px; color: #999; line-height: 1.7; }
  .copy p { margin: 0 0 12px; }
  .copy h2, .copy h3 { font-size: 11px; font-weight: 400; letter-spacing: 0.25em; text-transform: uppercase; color: #ddd; margin: 18px 0 8px; }
  .copy ul, .copy ol { padding-left: 18px; margin: 0 0 12px; }
  .copy a { color: #ddd; }
  .ship { color: #555; font-size: 11px; border-top: 1px solid #1c1c1c; padding-top: 12px; }

  @media (max-width: 820px) {
    .pdp { grid-template-columns: 1fr; gap: 20px; }
    .info { position: static; }
    .thumbs button { width: 60px; height: 60px; }
  }`;

function page(p) {
  const imgs = images(p);
  const title = `NEWSPEECH // ${p.name}`;
  const desc = p.blurb || `${p.name} — ${money(p.price)}`;
  const url = `${SITE}/shop/${p.id}.html`;
  const og = imgs.length ? abs(imgs[0]) : `${SITE}/og-image.png`;
  const soldOutAll = p.soldOut === true;
  const ld = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: p.name,
    description: desc,
    image: imgs.map(abs),
    brand: { "@type": "Brand", name: "NEWSPEECH" },
    offers: {
      "@type": "Offer",
      url,
      price: (p.price / 100).toFixed(2),
      priceCurrency: cat.currency.toUpperCase(),
      availability: `https://schema.org/${soldOutAll ? "SoldOut" : "InStock"}`,
    },
  };
  const opts = p.options || [];
  const audio = Array.isArray(p.audio) ? p.audio : [];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#050505">
<!-- generated by tools/build-shop.mjs from shop.json — edit the catalog, not this file -->
${p.draft ? '<meta name="robots" content="noindex, nofollow">\n' : ""}<title>${esc(title)}</title>
<link rel="icon" type="image/svg+xml" href="../favicon.svg">
<link rel="canonical" href="${url}">
<meta name="description" content="${attr(desc)}">
<meta property="og:title" content="${attr(title)}">
<meta property="og:description" content="${attr(desc)}">
<meta property="og:type" content="product">
<meta property="og:url" content="${url}">
<meta property="og:site_name" content="NEWSPEECH">
<meta property="og:locale" content="en_US">
<meta property="og:image" content="${og}">
<meta property="og:image:alt" content="${attr(p.name)}">
<meta property="product:price:amount" content="${(p.price / 100).toFixed(2)}">
<meta property="product:price:currency" content="${cat.currency.toUpperCase()}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${attr(title)}">
<meta name="twitter:description" content="${attr(desc)}">
<meta name="twitter:image" content="${og}">
<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\\u003c")}</script>
<link rel="stylesheet" href="../shop.css">
<style>${PAGE_CSS}
</style>
</head>
<body>
<script src="../nav.js"></script>
<script src="../grain.js"></script>

<div class="crumb">
  <a href="../shop.html" id="back">← // SHOP</a>
  <button id="cart-open" hidden>CART 0</button>
</div>

<main class="pdp${p.color ? " color" : ""}" data-id="${attr(p.id)}">
  <div class="gallery">
    <div class="main" id="main">${imgs.length
      ? `<img id="main-img" src="${attr(rel(imgs[0]))}" alt="${attr(p.name)}">${imgs.length > 1 ? `<span class="count" id="count">1 / ${imgs.length}</span>` : ""}`
      : `<div class="ph">${esc(p.name)}</div>`}</div>${imgs.length > 1 ? `
    <div class="thumbs" id="thumbs">${imgs.map((src, i) => `
      <button class="${i === 0 ? "on" : ""}" data-i="${i}" aria-label="photo ${i + 1}"><img src="${attr(rel(src))}" alt="" loading="lazy"></button>`).join("")}
    </div>` : ""}
  </div>

  <div class="info">
    ${p.draft ? '<span class="tag">draft</span>\n    ' : ""}<h1>${esc(p.name)}</h1>
    <span class="price">${money(p.price)}</span>
    ${p.blurb ? `<p class="blurb">${esc(p.blurb)}</p>` : ""}
    ${opts.length ? `<div class="seg" id="opts"><span class="seglabel">${p.kind === "shirt" ? "size" : "option"}</span>${opts.map((o) => `<button data-o="${attr(o)}">${esc(o)}</button>`).join("")}</div>` : ""}
    <div class="buyrow"><button class="buy" id="buy" disabled>ADD TO CART</button><span class="msg" id="msg"></span></div>
    <p class="gone" id="gone" hidden>not on the shelf right now.</p>${audio.length ? `
    <div class="tracks" id="tracks"><span class="lbl">listen</span>${audio.map((a, i) => `
      <button class="track" data-i="${i}" data-src="${attr(rel(a.src))}"><span class="ic">▶</span><span>${esc(a.title)}</span><span class="t">0:00</span><span class="bar"><i></i></span></button>`).join("")}
    </div>` : ""}${(() => { const c = copyFor(p); return c ? `
    <div class="copy">
${c}
    </div>` : ""; })()}
    <p class="ship">ships by hand from the US · ${esc(shippingLine())}</p>
  </div>
</main>

<script src="../shop.js"></script>
<script>
// ---- product page: gallery, options, add to cart, audio previews. the
// static markup above is the fallback; shop.js has the live catalog + cart.
(() => {
  const S = window.NewspeechShop;
  const $ = (id) => document.getElementById(id);
  const id = document.querySelector(".pdp").dataset.id;
  if (S.SHOW_DRAFTS && S.PROD) $("back").href += "?drafts";

  // gallery: thumbs pick, the main photo steps forward, arrow keys step
  const thumbs = [...document.querySelectorAll("#thumbs button")];
  let cur = 0;
  function show(i) {
    if (!thumbs.length) return;
    cur = (i + thumbs.length) % thumbs.length;
    $("main-img").src = thumbs[cur].querySelector("img").getAttribute("src");
    $("count").textContent = (cur + 1) + " / " + thumbs.length;
    thumbs.forEach((b, j) => b.classList.toggle("on", j === cur));
  }
  thumbs.forEach((b, i) => b.addEventListener("click", () => show(i)));
  $("main").addEventListener("click", () => show(cur + 1));
  window.addEventListener("keydown", (e) => {
    if (!$("cart-wrap") || !$("cart-wrap").hidden || e.target !== document.body) return;
    if (e.key === "ArrowRight") show(cur + 1);
    if (e.key === "ArrowLeft") show(cur - 1);
  });

  // audio previews: one player, one track at a time
  const player = new Audio();
  const rows = [...document.querySelectorAll(".track")];
  let playing = null;
  const fmt = (s) => Math.floor(s / 60) + ":" + String(Math.floor(s % 60)).padStart(2, "0");
  function stopRow(r) { r.classList.remove("on"); r.querySelector(".ic").textContent = "▶"; }
  rows.forEach((r) => r.addEventListener("click", () => {
    if (playing === r) { player.paused ? player.play() : player.pause(); return; }
    if (playing) stopRow(playing);
    playing = r;
    player.src = r.dataset.src;
    player.play().catch(() => {});
    r.classList.add("on");
  }));
  player.addEventListener("play", () => { if (playing) playing.querySelector(".ic").textContent = "❚❚"; });
  player.addEventListener("pause", () => { if (playing) playing.querySelector(".ic").textContent = "▶"; });
  player.addEventListener("timeupdate", () => {
    if (!playing || !player.duration) return;
    playing.querySelector(".t").textContent = fmt(player.currentTime);
    playing.querySelector(".bar i").style.width = (100 * player.currentTime / player.duration) + "%";
  });
  player.addEventListener("ended", () => { if (playing) { stopRow(playing); playing.querySelector(".bar i").style.width = "0"; playing = null; } });

  // options + add to cart, against the live catalog
  S.ready.then(({ byId }) => {
    const p = byId.get(id);
    const buy = $("buy"), msg = $("msg");
    if (!p) { buy.hidden = true; const o = $("opts"); if (o) o.hidden = true; $("gone").hidden = false; return; }
    const opts = p.options || [];
    let option = "";
    const refresh = () => {
      const out = S.soldOut(p) || S.soldOut(p, option);
      buy.disabled = out || (opts.length && !option);
      buy.textContent = out ? "SOLD OUT" : opts.length && !option ? "PICK A SIZE" : "ADD TO CART";
    };
    document.querySelectorAll("#opts button").forEach((b) => {
      if (S.soldOut(p, b.dataset.o)) b.classList.add("out");
      b.addEventListener("click", () => {
        option = b.dataset.o;
        document.querySelectorAll("#opts button").forEach((x) => x.classList.toggle("on", x === b));
        msg.textContent = "";
        refresh();
      });
    });
    let flash = 0;
    buy.addEventListener("click", () => {
      msg.textContent = "added — " + S.add(p.id, option) + " in the cart";
      clearTimeout(flash);
      flash = setTimeout(() => { msg.textContent = ""; }, 2400);
    });
    refresh();
  }).catch(() => { $("buy").hidden = true; $("gone").hidden = false; });
})();
</script>
</body>
</html>
`;
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const p of cat.products) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(p.id)) throw new Error(`shop.json: bad product id "${p.id}"`);
  fs.writeFileSync(path.join(OUT_DIR, `${p.id}.html`), page(p));
}
console.log(`build-shop: ${cat.products.length} product ${cat.products.length === 1 ? "page" : "pages"} → shop/`);
