// POST /api/checkout — the shop cart's checkout button. Body (JSON):
//   items     [{ product, option, qty }] — product = shop.json id; option
//             required when the product lists options; qty 1–MAX_QTY
//   region    shop.json shipping key ("us" | "world")
// Prices, names and shipping come from shop.json, never from the browser.
// Answers { ok, url } → the page sends the visitor to Stripe's hosted
// checkout; Stripe returns them to /shop.html?order=<session id>.
// Errors name the offending line: { ok:false, error, product?, option? }.

import { catalog, findProduct, isSoldOut, isTestKey, shippingFor, stripe } from "../lib/stripe.mjs";

export const config = { path: "/api/checkout" };

const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(newspeechsound\.com|netlify\.app)$/i;
const MAX_LINES = 20;
const MAX_QTY = 10;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

export default async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "post only" });

  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGIN.test(origin) && !/^http:\/\/localhost(:\d+)?$/.test(origin)) {
    return json(403, { ok: false, error: "origin" });
  }

  let fields = {};
  try { fields = await req.json(); } catch (_) { return json(400, { ok: false, error: "unreadable body" }); }

  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    console.error("checkout: STRIPE_SECRET_KEY missing");
    return json(503, { ok: false, error: "not configured" });
  }

  const region = catalog.shipping[String(fields.region || "")];
  if (!region) return json(400, { ok: false, error: "region" });

  const items = Array.isArray(fields.items) ? fields.items : [];
  if (!items.length || items.length > MAX_LINES) return json(400, { ok: false, error: "cart" });

  // validate every line; the same product + option twice folds into one
  const lines = new Map();
  for (const it of items) {
    const product = findProduct(String(it?.product || ""));
    // drafts are for previews — they never sell against a live key
    if (!product || (product.draft && !isTestKey(key))) return json(400, { ok: false, error: "product", product: it?.product });
    const opts = product.options || [];
    const option = opts.length ? String(it.option || "") : "";
    if (opts.length && !opts.includes(option)) return json(400, { ok: false, error: "option", product: product.id });
    if (isSoldOut(product, option)) return json(409, { ok: false, error: "sold out", product: product.id, option });
    const qty = Number(it.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return json(400, { ok: false, error: "qty", product: product.id });
    const k = `${product.id}:${option}`;
    const prev = lines.get(k);
    lines.set(k, { product, option, qty: Math.min(MAX_QTY, (prev ? prev.qty : 0) + qty) });
  }

  const base = new URL(req.url).origin;
  const list = [...lines.values()];
  // metadata values cap at 500 chars; the webhook reads `product` (first
  // line), `items` is for eyeballing orders in the dashboard
  const summary = list.map((l) => `${l.product.id}${l.option ? ":" + l.option : ""}×${l.qty}`).join(",").slice(0, 500);

  const session = {
    mode: "payment",
    // Managed Payments (Stripe as merchant of record) is on by default for new
    // accounts but is digital-only — it refuses shipping. Physical goods sell
    // as us. (Worth revisiting for the digital pay-what-you-want phase.)
    managed_payments: { enabled: false },
    // quantities are fixed here — shipping was priced from them
    line_items: list.map((l) => ({
      quantity: l.qty,
      price_data: {
        currency: catalog.currency,
        unit_amount: l.product.price,
        product_data: {
          name: l.option ? `${l.product.name} — ${l.option}` : l.product.name,
          images: l.product.image ? [new URL(l.product.image, base + "/").href] : undefined,
        },
      },
    })),
    shipping_address_collection: { allowed_countries: region.countries },
    shipping_options: [{
      shipping_rate_data: {
        type: "fixed_amount",
        display_name: region.name,
        fixed_amount: { amount: shippingFor(region, list), currency: catalog.currency },
      },
    }],
    // Stripe shows the marketing opt-in where the buyer's locale requires one;
    // the webhook reads the answer before adding anyone to the list
    consent_collection: { promotions: "auto" },
    automatic_tax: process.env.STRIPE_TAX === "on" ? { enabled: true } : undefined,
    metadata: { product: list[0].product.id, items: summary },
    success_url: `${base}/shop.html?order={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/shop.html`,
  };

  try {
    const s = await stripe(key, "POST", "/checkout/sessions", session);
    console.log(`checkout: ${summary} → ${fields.region}`);
    return json(200, { ok: true, url: s.url });
  } catch (e) {
    console.error("checkout:", e.message);
    return json(502, { ok: false, error: "upstream" });
  }
};
