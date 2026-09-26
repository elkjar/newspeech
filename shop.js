// shop.js — the cart + checkout, shared by shop.html (the shelf) and the
// generated product pages (shop/<id>.html, tools/build-shop.mjs).
//
// loads shop.json, keeps the cart in this browser's localStorage
// (newspeech.cart), injects the cart window, and wires #cart-open if the page
// has one. checkout → POST /api/checkout → Stripe's hosted page → back to
// shop.html?order=<session id>. prices + shipping live in shop.json and the
// function prices from it — every total here is display only.
//
// drafts render off the production host (previews, local) or with ?drafts.
//
// usage: <link rel="stylesheet" href="shop.css"> + <script src="shop.js">
// (../ from shop/), then NewspeechShop.ready.then(({ cat, list, byId }) => …)
// and NewspeechShop.add(id, option) from the page's own buttons.
(function () {
  "use strict";
  if (window.NewspeechShop) return;

  const src = (document.currentScript && document.currentScript.getAttribute("src")) || "shop.js";
  const ROOT = src.slice(0, src.lastIndexOf("shop.js"));
  const q = new URLSearchParams(location.search);
  const PROD = /^(www\.)?newspeechsound\.com$/.test(location.hostname);
  const SHOW_DRAFTS = !PROD || q.has("drafts");
  const CART_KEY = "newspeech.cart";
  const REGION_KEY = "newspeech.cartRegion";
  const MAX_QTY = 10; // matches netlify/functions/checkout.mjs

  const $ = (id) => document.getElementById(id);
  const get = (k) => { try { return localStorage.getItem(k); } catch (_) { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (_) {} };
  const money = (c) => "$" + (c % 100 ? (c / 100).toFixed(2) : String(c / 100));
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  function soldOut(p, opt) {
    if (p.soldOut === true) return true;
    return Array.isArray(p.soldOut) && opt ? p.soldOut.includes(opt) : false;
  }
  // `images` (a list) — or the older single `image`
  const images = (p) => (Array.isArray(p.images) && p.images.length ? p.images : p.image ? [p.image] : []);
  const url = (p) => `${ROOT}shop/${p.id}.html${SHOW_DRAFTS && PROD ? "?drafts" : ""}`;
  const asset = (path) => (/^(https?:)?\/\//.test(path) || path.startsWith("/") ? path : ROOT + path);

  // mirrors shippingFor() in netlify/lib/stripe.mjs
  function shippingFor(r, lines) {
    const units = lines.reduce((n, l) => n + (l.p.units || 1) * l.qty, 0);
    return units ? r.first + r.additional * (units - 1) : 0;
  }

  let cat = null;
  let byId = new Map();
  let cart = []; // [{ id, option, qty }]
  let region = get(REGION_KEY) || "us";
  let bad = null; // { product, option, why } from the last failed checkout

  // back from Stripe: the order's in, the cart's done
  if (q.has("order")) set(CART_KEY, "[]");

  function loadCart() {
    let raw = [];
    try { raw = JSON.parse(get(CART_KEY) || "[]"); } catch (_) {}
    // drop anything the catalog no longer sells (or this host doesn't show)
    cart = (Array.isArray(raw) ? raw : []).filter((l) => {
      const p = byId.get(l && l.id);
      if (!p || !Number.isInteger(l.qty) || l.qty < 1) return false;
      const opts = p.options || [];
      return opts.length ? opts.includes(l.option) : !l.option;
    }).map((l) => ({ id: l.id, option: l.option || "", qty: Math.min(MAX_QTY, l.qty) }));
    if (!cat.shipping[region]) region = Object.keys(cat.shipping)[0];
  }
  function saveCart() { set(CART_KEY, JSON.stringify(cart)); }
  const count = () => cart.reduce((n, l) => n + l.qty, 0);

  function add(id, option) {
    const l = cart.find((x) => x.id === id && x.option === (option || ""));
    if (l) l.qty = Math.min(MAX_QTY, l.qty + 1);
    else cart.push({ id, option: option || "", qty: 1 });
    bad = null;
    saveCart();
    renderCart();
    return count();
  }

  // ---- the cart window ---------------------------------------------------
  const wrap = el("div");
  wrap.id = "cart-wrap";
  wrap.hidden = true;
  wrap.innerHTML = `
  <aside id="cart" aria-label="cart">
    <div class="bar"><span class="idx">//</span><span class="title">cart</span><button class="x" id="cart-close" aria-label="close">×</button></div>
    <div class="lines" id="cart-lines"></div>
    <div class="foot">
      <div class="seg" id="cart-region"><span class="seglabel">ship to</span></div>
      <span class="shipnote" id="cart-shipnote" hidden></span>
      <div class="sum"><span>items</span><span id="cart-sub"></span></div>
      <div class="sum"><span id="cart-shipname">shipping</span><span id="cart-ship"></span></div>
      <div class="sum total"><span>total</span><span id="cart-total"></span></div>
      <button id="checkout">CHECKOUT</button>
      <span id="checkout-msg"></span>
    </div>
  </aside>`;
  document.body.appendChild(wrap);

  function openCart() { wrap.hidden = false; renderCart(); }
  function closeCart() { wrap.hidden = true; renderCart(); }
  $("cart-close").addEventListener("click", closeCart);
  wrap.addEventListener("click", (e) => { if (e.target === wrap) closeCart(); });
  window.addEventListener("keydown", (e) => { if (e.key === "Escape" && !wrap.hidden) closeCart(); });
  const openBtn = $("cart-open");
  if (openBtn) openBtn.addEventListener("click", openCart);

  function renderCart() {
    if (!cat) return;
    const n = count();
    if (openBtn) {
      openBtn.hidden = !n && wrap.hidden;
      openBtn.textContent = "CART " + n;
      openBtn.classList.toggle("has", n > 0);
    }
    if (wrap.hidden) return;

    const box = $("cart-lines");
    box.textContent = "";
    const lines = cart.map((l) => ({ ...l, p: byId.get(l.id) }));
    if (!lines.length) box.appendChild(el("div", "none", "the cart's empty."));
    for (const l of lines) {
      const isBad = bad && bad.product === l.id && (!bad.option || bad.option === l.option);
      const row = el("div", "line" + (isBad ? " bad" : ""));
      const nm = el("a", "nm", l.p.name);
      nm.href = url(l.p);
      if (l.option) { nm.append(" "); nm.appendChild(el("small", null, l.option)); }
      const rm = el("button", "rm", "×");
      rm.setAttribute("aria-label", "remove");
      rm.addEventListener("click", () => { cart = cart.filter((x) => !(x.id === l.id && x.option === l.option)); bad = null; saveCart(); renderCart(); });
      row.append(nm, el("span", "amt", money(l.p.price * l.qty)), rm);
      const qty = el("div", "qty");
      const minus = el("button", null, "−"), plus = el("button", null, "+");
      const step = (d) => {
        const c = cart.find((y) => y.id === l.id && y.option === l.option);
        c.qty = Math.max(1, Math.min(MAX_QTY, c.qty + d));
        saveCart(); renderCart();
      };
      minus.addEventListener("click", () => step(-1));
      plus.addEventListener("click", () => step(1));
      minus.disabled = l.qty <= 1; plus.disabled = l.qty >= MAX_QTY;
      qty.append(minus, el("span", null, String(l.qty)), plus);
      row.appendChild(qty);
      if (isBad) row.appendChild(el("span", "why", bad.why));
      box.appendChild(row);
    }

    const segBox = $("cart-region");
    segBox.querySelectorAll("button").forEach((b) => b.remove());
    for (const [key, r] of Object.entries(cat.shipping)) {
      const b = el("button", key === region ? "on" : null, r.label);
      b.addEventListener("click", () => { region = key; set(REGION_KEY, key); renderCart(); });
      segBox.appendChild(b);
    }
    const r = cat.shipping[region];
    $("cart-shipnote").hidden = !r.note;
    $("cart-shipnote").textContent = r.note || "";
    const sub = lines.reduce((s, l) => s + l.p.price * l.qty, 0);
    const ship = shippingFor(r, lines);
    $("cart-sub").textContent = money(sub);
    $("cart-shipname").textContent = r.name;
    $("cart-ship").textContent = lines.length ? money(ship) : "—";
    $("cart-total").textContent = money(sub + ship);
    $("checkout").disabled = !lines.length;
  }

  $("checkout").addEventListener("click", async () => {
    const btn = $("checkout"), msg = $("checkout-msg");
    btn.disabled = true;
    msg.textContent = "opening checkout…";
    try {
      const res = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ region, items: cart.map((l) => ({ product: l.id, option: l.option, qty: l.qty })) }),
      });
      const r = await res.json().catch(() => ({}));
      if (res.ok && r.url) { location.href = r.url; return; }
      if (r.product) {
        bad = { product: r.product, option: r.option, why: r.error === "sold out" ? "just sold out — remove it to check out" : "can't sell this one right now — remove it to check out" };
        msg.textContent = "";
      } else {
        msg.textContent = r.error === "not configured" ? "checkout isn't wired up yet" : "transmission failed — try again";
      }
    } catch (_) {
      msg.textContent = "transmission failed — try again";
    }
    renderCart();
  });

  // ---- boot --------------------------------------------------------------
  const ready = fetch(ROOT + "shop.json", { cache: "no-store" })
    .then((r) => r.json())
    .then((c) => {
      cat = c;
      const list = cat.products.filter((p) => SHOW_DRAFTS || !p.draft);
      byId = new Map(list.map((p) => [p.id, p]));
      loadCart();
      saveCart();
      renderCart();
      return { cat, list, byId };
    });

  window.NewspeechShop = { ready, add, count, openCart, money, soldOut, images, url, asset, SHOW_DRAFTS, PROD, ROOT };
})();
