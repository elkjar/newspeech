// The release audio lives in a private Cloudflare R2 bucket — stream copies,
// 15s previews, the full-res zips and a manifest per release, put there by
// tools/release-audio/release-audio.mjs --upload:
//
//   <release>/manifest.json
//   <release>/stream/<slug>.m4a
//   <release>/preview/<slug>.m4a
//   <release>/download/<format>.zip     (Content-Disposition set at upload)
//
// No object is public. A function checks the listener, then answers with a
// 302 to a short-lived presigned GET, so the bytes go browser ↔ R2 directly:
// no function size limit, no Netlify bandwidth, and a zip downloads like any
// file (progress, resume). The bucket's CORS policy allows GET from anywhere —
// the page fetch()es the streams to decode them; the signature is the lock.
//
// Env (same names as the SOUP dashboard): R2_ACCOUNT_ID, R2_ACCESS_KEY_ID,
// R2_SECRET_ACCESS_KEY, R2_BUCKET.
// Local dev: LISTEN_LOCAL_DIR=tools/release-audio/out serves the same keys
// from disk instead (release-audio.mjs writes them there before uploading).

import { AwsClient } from "aws4fetch";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const local = () => process.env.LISTEN_LOCAL_DIR || "";

let client = null;
function r2() {
  const { R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: id, R2_SECRET_ACCESS_KEY: key, R2_BUCKET: bucket } = process.env;
  if (!account || !id || !key || !bucket) throw new Error("R2_* env is not set");
  client ||= new AwsClient({ accessKeyId: id, secretAccessKey: key, service: "s3", region: "auto" });
  return { client, base: `https://${account}.r2.cloudflarestorage.com/${bucket}` };
}

export const objectUrl = (base, key) => `${base}/${key.split("/").map(encodeURIComponent).join("/")}`;

// a GET anyone can follow for ttl seconds
export async function presign(key, ttl) {
  const { client, base } = r2();
  const url = new URL(objectUrl(base, key));
  url.searchParams.set("X-Amz-Expires", String(ttl));
  const signed = await client.sign(new Request(url), { aws: { signQuery: true } });
  return signed.url;
}

// the manifest, held a minute per warm function so a page load's handful of
// requests don't each go to R2
const cache = new Map();
export async function manifest(release) {
  const hit = cache.get(release);
  if (hit && Date.now() - hit.at < 60000) return hit.m;
  let m = null;
  if (local()) {
    try { m = JSON.parse(await readFile(path.join(local(), release, "manifest.json"), "utf8")); } catch (_) {}
  } else {
    const { client, base } = r2();
    const r = await client.fetch(objectUrl(base, `${release}/manifest.json`));
    if (r.ok) m = await r.json();
    else if (r.status !== 404) throw new Error(`R2 ${r.status} reading the ${release} manifest`);
  }
  if (m) cache.set(release, { at: Date.now(), m });
  return m;
}

// local dev only: the object's bytes
export const readLocal = (key) => readFile(path.join(local(), key)).catch(() => null);
