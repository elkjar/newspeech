// /api/listen — the door to a private pre-release stream (see ../lib/listen.mjs).
//
//   POST {email, release, bot-field}  file the email in Resend (source = the
//                                     release, property "stream") and mail a
//                                     signed listening link
//   GET  ?k=<token>                   the link from that email: set the
//                                     release's cookie, land on its page
//   GET  ?r=<release>                 {unlocked} — does this browser hold a
//                                     valid cookie for the release?
//
// Env: LISTEN_SECRET, RESEND_API_KEY. LISTEN_DRY_RUN=1 (local dev only) skips
// Resend and hands the link back in the response instead of mailing it.

import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";
import { client, normalizeEmail } from "../lib/resend.mjs";
import { RELEASES, LINK_DAYS, sign, verify, setCookie, listener } from "../lib/listen.mjs";

export const config = { path: "/api/listen" };

const FROM = "newspeech <listen@newspeechsound.com>";
const RESEND_AFTER_S = 120; // one email per address per release per two minutes
const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(newspeechsound\.com|netlify\.app)$/i;
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const json = (status, body, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
const redirect = (to, headers = {}) => new Response(null, { status: 302, headers: { Location: to, "Cache-Control": "no-store", ...headers } });

let resend = null;

export default async (req) => {
  const url = new URL(req.url);

  if (req.method === "GET") {
    // the emailed link
    const k = url.searchParams.get("k");
    if (k) {
      let p = null;
      try { p = verify("link", k); } catch (e) { console.error("listen:", e.message); return json(503, { ok: false, error: "not configured" }); }
      if (!p) {
        // expired or mangled: back to the page (if we can tell which), which offers a fresh link
        let r = null;
        try { r = JSON.parse(Buffer.from(k.split(".")[0], "base64url").toString()).r; } catch (_) {}
        return redirect(`${(RELEASES[r] || {}).page || "/"}?listen=expired`);
      }
      console.log(`listen: opened ${p.r}`);
      return redirect(`${RELEASES[p.r].page}?listen=1`, { "Set-Cookie": setCookie(req, p.r) });
    }
    // status
    const r = url.searchParams.get("r");
    if (!RELEASES[r]) return json(404, { ok: false, error: "release" });
    let p = null;
    try { p = listener(req, r); } catch (e) { console.error("listen:", e.message); return json(503, { ok: false, error: "not configured" }); }
    return json(200, { ok: true, unlocked: !!p });
  }

  if (req.method !== "POST") return json(405, { ok: false, error: "get or post" });

  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGIN.test(origin) && !LOCAL.test(origin)) return json(403, { ok: false, error: "origin" });

  let fields = {};
  try {
    const type = req.headers.get("content-type") || "";
    if (type.includes("application/json")) fields = await req.json();
    else fields = Object.fromEntries(new URLSearchParams(await req.text()));
  } catch (_) {
    return json(400, { ok: false, error: "unreadable body" });
  }
  if (fields["bot-field"]) return json(200, { ok: true }); // honeypot

  const email = normalizeEmail(fields.email);
  if (!email) return json(400, { ok: false, error: "email" });
  const release = String(fields.release || "");
  const rel = RELEASES[release];
  if (!rel) return json(400, { ok: false, error: "release" });

  let link;
  try {
    // the link points back at whichever deploy asked (production or a preview)
    const base = ALLOWED_ORIGIN.test(url.origin) || LOCAL.test(url.origin) ? url.origin : "https://www.newspeechsound.com";
    link = `${base}/api/listen?k=${sign("link", release, LINK_DAYS)}`;
  } catch (e) {
    console.error("listen:", e.message);
    return json(503, { ok: false, error: "not configured" });
  }

  if (process.env.LISTEN_DRY_RUN) {
    console.log(`listen (dry run): ${release} ${link}`);
    return json(200, { ok: true, dev_link: link });
  }

  // throttle: a second ask inside the window answers ok and sends nothing, so
  // the form can't be used to flood someone's inbox. best-effort — a Blobs
  // hiccup never blocks the email.
  let sent = null;
  const key = `sent/${release}/${createHash("sha256").update(email).digest("hex").slice(0, 32)}`;
  try {
    sent = getStore("listen");
    const last = await sent.get(key);
    if (last && Date.now() / 1000 - Number(last) < RESEND_AFTER_S) return json(200, { ok: true });
  } catch (e) {
    console.error("listen: throttle store:", e.message);
    sent = null;
  }

  if (!process.env.RESEND_API_KEY) {
    console.error("listen: RESEND_API_KEY missing");
    return json(503, { ok: false, error: "not configured" });
  }
  resend ||= client(process.env.RESEND_API_KEY);

  try {
    await resend.subscribe({ email, source: release, track: "stream" });
    await resend.send({
      from: FROM,
      to: email,
      subject: `${rel.title} — your private listen`,
      text: [
        `here's your link to hear ${rel.title} before it's out:`,
        "",
        link,
        "",
        `it opens the record in this browser and works for ${LINK_DAYS} days. it's meant for you — please don't pass it around.`,
        "",
        `— ${rel.artist}`,
      ].join("\n"),
      html: `<!doctype html><html><body style="margin:0;padding:32px 24px;background:#ffffff;color:#111111;font:14px/1.6 Menlo,Consolas,monospace">
<p style="margin:0 0 20px">here's your link to hear <b>${rel.title}</b> before it's out:</p>
<p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;padding:8px 18px;border:1px solid #111111;color:#111111;text-decoration:none">listen →</a></p>
<p style="margin:0 0 20px;color:#555555">it opens the record in this browser and works for ${LINK_DAYS} days. it's meant for you — please don't pass it around.</p>
<p style="margin:0;color:#555555">— ${rel.artist}</p>
</body></html>`,
    });
    if (sent) { try { await sent.set(key, String(Math.floor(Date.now() / 1000))); } catch (_) {} }
    console.log(`listen: link sent for ${release}`);
    return json(200, { ok: true });
  } catch (e) {
    console.error("listen:", e.message);
    return json(502, { ok: false, error: "upstream" });
  }
};
