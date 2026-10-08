// GET /api/stream/<release>/manifest            {tracks, previews, downloads}
// GET /api/stream/<release>/<slug>              → the track's stream copy
// GET /api/stream/<release>/preview/<slug>      → the track's 15s preview — PUBLIC
// GET /api/stream/<release>/download/<format>   → the full-res zip; takes the
//                                                 emailed link's ?k= as well as
//                                                 the cookie, so the email can
//                                                 link the zips directly
//
// Everything but the previews is only for a listener (../lib/listen.mjs). The
// audio answers are 302s to short-lived presigned R2 GETs (../lib/r2.mjs) —
// the bytes never pass through here.
//
// Local dev: LISTEN_LOCAL_DIR=tools/release-audio/out serves the bytes from
// disk instead of redirecting.

import { RELEASES, DOWNLOAD_ID, listener, verify, setCookie } from "../lib/listen.mjs";
import { local, manifest, presign, readLocal } from "../lib/r2.mjs";

export const config = { path: "/api/stream/*" };

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const STREAM_TTL = 6 * 3600; // outlives any listening session
const PREVIEW_TTL = 3600;
const DOWNLOAD_TTL = 3600; // long enough to start; a running download outlives it

const deny = (status, error) =>
  new Response(JSON.stringify({ ok: false, error }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

const TYPES = { m4a: "audio/mp4", zip: "application/zip" };

// the object: a redirect to R2, or (local dev) the bytes themselves
// (in R2 a zip's Content-Disposition is stored with the object at upload)
async function serve(key, ttl, { filename, ...headers } = {}) {
  if (local()) {
    const buf = await readLocal(key);
    if (!buf) return deny(404, "not built");
    if (filename) headers["Content-Disposition"] = `attachment; filename="${filename}"`;
    return new Response(buf, { headers: { "Content-Type": TYPES[key.split(".").pop()] || "application/octet-stream", "Cache-Control": "no-store", ...headers } });
  }
  // never cache the redirect — the signature it carries runs out
  return new Response(null, { status: 302, headers: { Location: await presign(key, ttl), "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...headers } });
}

export default async (req) => {
  if (req.method !== "GET" && req.method !== "HEAD") return deny(405, "get only");
  const url = new URL(req.url);
  const bits = url.pathname.replace(/^\/api\/stream\//, "").split("/");
  const [release, a, b] = bits;
  const rel = RELEASES[release];
  if (!rel) return deny(404, "release");

  try {
    // the previews are the taste before the email — no cookie needed
    if (bits.length === 3 && a === "preview") {
      if (!SLUG.test(b || "")) return deny(404, "path");
      return await serve(`${release}/preview/${b}.m4a`, PREVIEW_TTL);
    }

    // a listener: the cookie, or — for the zips only — the emailed link itself
    let who = listener(req, release), viaLink = false;
    const isDownload = bits.length === 3 && a === "download";
    if (!who && isDownload && url.searchParams.get("k")) { who = verify("link", url.searchParams.get("k"), release); viaLink = !!who; }
    if (!who) {
      // someone clicking an emailed zip link lands on the page, not on json
      if (isDownload) return new Response(null, { status: 302, headers: { Location: `${rel.page}?listen=expired`, "Cache-Control": "no-store" } });
      return deny(401, "locked");
    }

    const m = await manifest(release);
    if (!m) return deny(404, "no audio uploaded");

    if (bits.length === 2 && a === "manifest") {
      return new Response(JSON.stringify(m), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
    }
    if (isDownload) {
      if (!DOWNLOAD_ID.test(b || "") || !(m.downloads || {})[b]) return deny(404, "format");
      console.log(`stream: download ${release} ${b}${viaLink ? " (email)" : ""}`);
      // the email link also opens the record in this browser, like the listen link
      return await serve(`${release}/download/${b}.zip`, DOWNLOAD_TTL, { filename: m.downloads[b].name, ...(viaLink ? { "Set-Cookie": setCookie(req, release) } : {}) });
    }
    if (bits.length === 2 && SLUG.test(a || "") && (m.tracks || {})[a]) {
      return await serve(`${release}/stream/${a}.m4a`, STREAM_TTL);
    }
    return deny(404, "path");
  } catch (e) {
    console.error("stream:", e.message);
    return deny(503, "not configured");
  }
};
