// /api/listen — the door to a private pre-release stream (see ../lib/listen.mjs).
//
//   POST {email, release, bot-field}  file the email in Resend (source = the
//                                     release, property "stream") and mail a
//                                     signed listening link — or, if the mail
//                                     can't go out (quota, outage), set the
//                                     cookie right here: {unlocked: true}
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
import { manifest } from "../lib/r2.mjs";

export const config = { path: "/api/listen" };

const FROM = "newspeech <listen@newspeechsound.com>";
// Chris's copy (10-07)
const INTRO = (title) => `Thanks so much for your interest in ${title} / this project in general. it honestly means the world to me. the state of the music industry right now is kind of a mess and this type of direct support is absolutely incredible. you can listen or download the music below. please share this however you'd like.`;
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

  // the link (and the email's logo) point back at whichever deploy asked —
  // production or a preview
  const base = ALLOWED_ORIGIN.test(url.origin) || LOCAL.test(url.origin) ? url.origin : "https://www.newspeechsound.com";
  let link, token;
  try {
    token = sign("link", release, LINK_DAYS);
    link = `${base}/api/listen?k=${token}`;
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

  // the full-res zips, straight from the email: the same signed token opens
  // /api/stream's download route. listed from the uploaded manifest, so the
  // email only ever offers what's in the bucket; no manifest → no list.
  let zips = [];
  try {
    const m = await manifest(release);
    zips = Object.entries((m && m.downloads) || {}).map(([id, d]) => ({
      label: d.label, size: `${Math.round(d.bytes / 1048576)} MB`,
      href: `${base}/api/stream/${release}/download/${id}?k=${token}`,
    }));
  } catch (e) { console.error("listen: manifest:", e.message); }

  try {
    // filing the contact is for us; the link is for them — a Resend hiccup
    // on the contact side never costs a listener their email
    try { await resend.subscribe({ email, source: release, track: "stream" }); }
    catch (e) { console.error("listen: subscribe:", e.message); }
    await resend.send({
      from: FROM,
      to: email,
      subject: "your download links",
      text: [
        INTRO(rel.title),
        "",
        `listen: ${link}`,
        "",
        ...(zips.length ? ["download the whole ep (zip, full res):", "", ...zips.flatMap((z) => [`${z.label} · ${z.size}`, z.href, ""])] : []),
        `— ${rel.artist}`,
      ].join("\n"),
      html: `<!doctype html><html><body style="margin:0;padding:32px 24px;background:#ffffff;color:#111111;font:14px/1.6 Menlo,Consolas,monospace">
<img src="${base}/assets/email/ns-wordmark-black.png" width="240" height="19" alt="NEWSPEECH" style="display:block;border:0;outline:none;margin:0 0 32px">
<p style="margin:0 0 20px">${INTRO(`<b>${rel.title}</b>`)}</p>
<p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;padding:8px 18px;border:1px solid #111111;color:#111111;text-decoration:none">listen →</a></p>
${zips.length ? `<p style="margin:0 0 10px">download the whole ep (zip, full res):</p>
<p style="margin:0 0 24px">${zips.map((z) => `<a href="${z.href}" style="color:#111111">${z.label}</a> <span style="color:#555555">· ${z.size}</span>`).join("<br>")}</p>
` : ""}<p style="margin:0;color:#555555">— ${rel.artist}</p>
</body></html>`,
    });
    if (sent) { try { await sent.set(key, String(Math.floor(Date.now() / 1000))); } catch (_) {} }
    console.log(`listen: link sent for ${release}`);
    return json(200, { ok: true });
  } catch (e) {
    console.error("listen:", e.message);
    // the email couldn't go out — Resend over quota / rate limited (429),
    // down (5xx) or unreachable. the address is already filed, and the gate
    // is there to collect it, not to guard the record: let this browser in
    // now rather than strand the listener. a 4xx about the address itself
    // (422 etc.) stays an error, so a typo still gets caught.
    const status = e && e.status;
    if (!status || status === 429 || status >= 500) {
      console.log(`listen: unlocked ${release} without the email (${status || "no response"})`);
      return json(200, { ok: true, unlocked: true }, { "Set-Cookie": setCookie(req, release) });
    }
    return json(502, { ok: false, error: "upstream" });
  }
};
