// Private pre-release streams — shared by /api/listen and /api/stream.
//
// A release is private while it's listed in RELEASES. The flow:
//   1. the album page posts an email to /api/listen
//   2. Resend mails a link: /api/listen?k=<token>  (signed, 30 days)
//   3. opening it sets an HttpOnly cookie for that release and lands on the page
//   4. the page pulls the audio from /api/stream/<release>/…, which checks the cookie
//
// The audio never touches git (the repo is public): tools/release-audio.sh
// encodes stream copies, splits them into parts and uploads them to the
// "releases" Netlify Blobs store. Parts keep every response small and quick —
// no streamed-function size or duration limit to hit on a slow connection.
//
// Going public on release day: delete the release from RELEASES and the
// `private` block from its EP config, and point the config at public files.
//
// LISTEN_SECRET (any long random string) signs links and cookies. Rotating it
// signs everyone out and kills every link already sent.

import { createHmac, timingSafeEqual } from "node:crypto";

export const RELEASES = {
  "dead-ocean": { title: "dead ocean", artist: "newspeech", page: "/dead-ocean.html" },
};

export const LINK_DAYS = 30;
export const COOKIE_DAYS = 30;
const DAY = 86400;

const b64 = (s) => Buffer.from(s).toString("base64url");
const unb64 = (s) => Buffer.from(s, "base64url").toString();

function secret() {
  const s = (process.env.LISTEN_SECRET || "").trim();
  if (s.length < 16) throw new Error("LISTEN_SECRET is not set (or shorter than 16 chars)");
  return s;
}
const sig = (body) => createHmac("sha256", secret()).update(body).digest("base64url");

// kind keeps a link from being replayed as a cookie and vice versa. the body
// is only encoded, not encrypted — anyone holding a link can read it — so it
// carries nothing personal: kind, release, expiry.
export function sign(kind, release, days) {
  const body = b64(JSON.stringify({ k: kind, r: release, x: Math.floor(Date.now() / 1000) + days * DAY }));
  return `${body}.${sig(kind + "." + body)}`;
}

export function verify(kind, token, release) {
  if (typeof token !== "string") return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const want = Buffer.from(sig(kind + "." + body));
  const got = Buffer.from(mac);
  if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
  let p;
  try { p = JSON.parse(unb64(body)); } catch (_) { return null; }
  if (p.k !== kind || !RELEASES[p.r] || (release && p.r !== release)) return null;
  if (!(p.x > Date.now() / 1000)) return null;
  return p;
}

export const cookieName = (release) => `ns_listen_${release}`;

export function readCookie(req, name) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

// the cookie rides only on /api requests (status + stream); Secure everywhere
// except plain-http local dev
export function setCookie(req, release) {
  const secure = new URL(req.url).protocol === "https:" ? "; Secure" : "";
  const val = sign("cookie", release, COOKIE_DAYS);
  return `${cookieName(release)}=${val}; Path=/api; Max-Age=${COOKIE_DAYS * DAY}; HttpOnly; SameSite=Lax${secure}`;
}

export function listener(req, release) {
  return verify("cookie", readCookie(req, cookieName(release)), release);
}
