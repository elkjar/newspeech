// POST /api/checkout — the shop's buy buttons. Body (JSON):
//   product   id from shop.json
//   option    size etc. — required when the product lists options
//   region    shop.json shipping key ("us" | "world")
// Prices, names and shipping come from shop.json, never from the browser.
// Answers { ok, url } → the page sends the visitor to Stripe's hosted
// checkout; Stripe returns them to /shop.html?order=<session id>.

import { catalog, findProduct, isSoldOut, isTestKey, stripe } from "../lib/stripe.mjs";

export const config = { path: "/api/checkout" };

const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(newspeechsound\.com|netlify\.app)$/i;

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

  const product = findProduct(String(fields.product || ""));
  if (!product) return json(400, { ok: false, error: "product" });
  // drafts are for previews — they never sell against a live key
  if (product.draft && !isTestKey(key)) return json(400, { ok: false, error: "product" });

  const options = product.options || [];
  const option = options.length ? String(fields.option || "") : "";
  if (options.length && !options.includes(option)) return json(400, { ok: false, error: "option" });
  if (isSoldOut(product, option)) return json(409, { ok: false, error: "sold out" });

  const ship = catalog.shipping[String(fields.region || "")];
  if (!ship) return json(400, { ok: false, error: "region" });

  const base = new URL(req.url).origin;
  const image = product.image ? new URL(product.image, base + "/").href : undefined;

  const session = {
    mode: "payment",
    line_items: [{
      quantity: 1,
      adjustable_quantity: { enabled: true, minimum: 1, maximum: 5 },
      price_data: {
        currency: catalog.currency,
        unit_amount: product.price,
        product_data: {
          name: option ? `${product.name} — ${option}` : product.name,
          images: image ? [image] : undefined,
        },
      },
    }],
    shipping_address_collection: { allowed_countries: ship.countries },
    shipping_options: [{
      shipping_rate_data: {
        type: "fixed_amount",
        display_name: ship.name,
        fixed_amount: { amount: ship.amount, currency: catalog.currency },
      },
    }],
    // Stripe shows the marketing opt-in where the buyer's locale requires one;
    // the webhook reads the answer before adding anyone to the list
    consent_collection: { promotions: "auto" },
    automatic_tax: process.env.STRIPE_TAX === "on" ? { enabled: true } : undefined,
    metadata: { product: product.id, option },
    success_url: `${base}/shop.html?order={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/shop.html`,
  };

  try {
    const s = await stripe(key, "POST", "/checkout/sessions", session);
    console.log(`checkout: ${product.id}${option ? " " + option : ""} ${fields.region}`);
    return json(200, { ok: true, url: s.url });
  } catch (e) {
    console.error("checkout:", e.message);
    return json(502, { ok: false, error: "upstream" });
  }
};
