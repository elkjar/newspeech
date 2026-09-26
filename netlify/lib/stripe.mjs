// Stripe for the newspeech shop — shared by functions/checkout.mjs and
// functions/stripe-webhook.mjs. Plain fetch against the REST API, no SDK.
//
// env  STRIPE_SECRET_KEY      sk_test_… on previews, sk_live_… on production
//                             (Netlify env vars scope per deploy context)
//      STRIPE_WEBHOOK_SECRET  whsec_… of the endpoint pointed at /api/stripe-webhook
//      STRIPE_TAX             "on" → Stripe Tax computes sales tax at checkout
//                             (needs Stripe Tax set up in the dashboard first)

import crypto from "node:crypto";
import catalog from "../../shop.json" with { type: "json" };

export { catalog };

export const isTestKey = (key) => String(key || "").startsWith("sk_test_");

export function findProduct(id) {
  return catalog.products.find((p) => p.id === id) || null;
}

export function isSoldOut(product, option) {
  const s = product.soldOut;
  if (s === true) return true;
  return Array.isArray(s) && option ? s.includes(option) : false;
}

// Stripe takes application/x-www-form-urlencoded with bracketed nesting:
// { a: { b: [ { c: 1 } ] } } → a[b][0][c]=1
export function formEncode(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe(key, method, path, body) {
  const res = await fetch("https://api.stripe.com/v1" + path, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body ? formEncode(body).toString() : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(`stripe ${res.status} ${path}: ${json?.error?.message || "?"}`);
  return json;
}

// Stripe-Signature: t=<unix>,v1=<hex hmac-sha256 of "<t>.<raw body>">[,v1=…]
export function verifySignature(rawBody, header, secret, toleranceS = 300) {
  if (!header || !secret) return false;
  const parts = header.split(",").map((kv) => kv.split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const sigs = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > toleranceS) return false;
  const want = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return sigs.some((s) => {
    const got = Buffer.from(s, "hex");
    return got.length === want.length && crypto.timingSafeEqual(got, want);
  });
}
