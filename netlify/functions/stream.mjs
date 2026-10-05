// GET /api/stream/<release>/manifest        {tracks: {<slug>: {parts, bytes, type}}}
// GET /api/stream/<release>/<slug>/<part>   one slice of a track's stream copy
// GET /api/stream/<release>/preview/<slug>  the track's 15s preview — PUBLIC
//
// Everything but the previews is only for a browser holding the release's
// listen cookie (see ../lib/listen.mjs).
// The parts live in the "releases" Netlify Blobs store under the same keys,
// put there by tools/release-audio/release-audio.mjs. The page fetches a track's parts in
// order and joins them before decoding.
//
// Local dev: LISTEN_LOCAL_DIR=tools/release-audio/out reads the same keys from
// disk instead of Blobs (release-audio.mjs writes them there before uploading).

import { getStore } from "@netlify/blobs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { RELEASES, listener } from "../lib/listen.mjs";

export const config = { path: "/api/stream/*" };

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

const deny = (status, error) =>
  new Response(JSON.stringify({ ok: false, error }), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });

async function read(key, type) {
  const dir = process.env.LISTEN_LOCAL_DIR;
  if (dir) {
    try {
      const buf = await readFile(path.join(dir, key));
      return type === "json" ? JSON.parse(buf.toString()) : buf;
    } catch (_) { return null; }
  }
  return getStore("releases").get(key, { type: type === "json" ? "json" : "arrayBuffer" });
}

export default async (req) => {
  if (req.method !== "GET") return deny(405, "get only");
  const bits = new URL(req.url).pathname.replace(/^\/api\/stream\//, "").split("/");
  const [release, slug, part] = bits;
  if (!RELEASES[release]) return deny(404, "release");

  // the previews are the taste before the email — no cookie needed
  if (bits.length === 3 && slug === "preview") {
    if (!SLUG.test(part || "")) return deny(404, "path");
    const clip = await read(`${release}/preview/${part}`, "bytes");
    if (!clip) return deny(404, "no preview uploaded");
    return new Response(clip, { headers: { "Content-Type": "audio/mp4", "Cache-Control": "public, max-age=600", "X-Robots-Tag": "noindex" } });
  }

  let who = null;
  try { who = listener(req, release); } catch (e) { console.error("stream:", e.message); return deny(503, "not configured"); }
  if (!who) return deny(401, "locked");

  // private, so only this browser caches it — a replay doesn't fetch again
  const headers = { "Cache-Control": "private, max-age=86400", "X-Robots-Tag": "noindex" };

  if (bits.length === 2 && slug === "manifest") {
    const m = await read(`${release}/manifest`, "json");
    if (!m) return deny(404, "no audio uploaded");
    return new Response(JSON.stringify(m), { headers: { ...headers, "Content-Type": "application/json" } });
  }

  if (bits.length !== 3 || !SLUG.test(slug || "") || !/^\d{1,4}$/.test(part || "")) return deny(404, "path");
  const data = await read(`${release}/${slug}/${Number(part)}`, "bytes");
  if (!data) return deny(404, "part");
  return new Response(data, { headers: { ...headers, "Content-Type": "application/octet-stream" } });
};
