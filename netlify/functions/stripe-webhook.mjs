// POST /api/stripe-webhook — Stripe calls this when a checkout completes.
// Point a webhook endpoint at it in the Stripe dashboard (event:
// checkout.session.completed) and put its signing secret in
// STRIPE_WEBHOOK_SECRET.
//
// Orders themselves live in Stripe (dashboard → payments, with the shipping
// address); this only files the buyer into the mailing list — source "shop",
// property shop=<product id> — unless they opted out at checkout. A failed
// Resend call answers 500 so Stripe retries.

import { verifySignature } from "../lib/stripe.mjs";
import { client, normalizeEmail } from "../lib/resend.mjs";

export const config = { path: "/api/stripe-webhook" };

let resend = null;

export default async (req) => {
  if (req.method !== "POST") return new Response("post only", { status: 405 });

  // a misconfigured secret answers 500 (Stripe retries, and its delivery log
  // shows why) — only a real signature mismatch is the sender's fault
  const secret = (process.env.STRIPE_WEBHOOK_SECRET || "").trim();
  if (!secret.startsWith("whsec_")) {
    console.error("stripe-webhook: STRIPE_WEBHOOK_SECRET missing or not a whsec_ signing secret");
    return new Response("webhook secret misconfigured — expected the endpoint's whsec_ signing secret", { status: 500 });
  }

  const raw = await req.text();
  if (!verifySignature(raw, req.headers.get("stripe-signature"), secret)) {
    return new Response("bad signature", { status: 400 });
  }

  let event;
  try { event = JSON.parse(raw); } catch (_) { return new Response("bad body", { status: 400 }); }
  if (event.type !== "checkout.session.completed") return new Response("ignored", { status: 200 });

  const s = event.data.object;
  const email = normalizeEmail(s.customer_details?.email);
  const product = s.metadata?.product || "";
  // null = Stripe didn't ask (locale doesn't require it) — a buyer, file them
  if (!email || s.consent?.promotions === "opt_out") {
    console.log(`stripe-webhook: ${product} — not filed (${email ? "opted out" : "no email"})`);
    return new Response("ok", { status: 200 });
  }

  try {
    resend ||= client(process.env.RESEND_API_KEY);
    const r = await resend.subscribe({ email, source: "shop", shop: product });
    console.log(`stripe-webhook: ${r.created ? "new" : "known"} shop ${product}`);
    return new Response("ok", { status: 200 });
  } catch (e) {
    console.error("stripe-webhook:", e.message);
    return new Response("upstream", { status: 500 });
  }
};
