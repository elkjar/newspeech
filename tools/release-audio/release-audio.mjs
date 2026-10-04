#!/usr/bin/env node
// Stream copies for a private pre-release (see netlify/lib/listen.mjs).
//
//   node tools/release-audio/release-audio.mjs [assets/ep/dead-ocean.json] [--upload]
//
// For every track in the EP config: encode <audioBase><file> to 256k AAC
// (48k — the rate the room decodes at; never the masters), cut it into 2 MiB
// parts, and write a manifest — all under tools/release-audio/out/<release>/
// (gitignored; LISTEN_LOCAL_DIR=tools/release-audio/out serves it in netlify dev).
// --upload then puts every part + the manifest in the site's "releases"
// Netlify Blobs store with the netlify CLI (needs `netlify login` + the
// linked site). Re-run after any new mix; the manifest is written last, so a
// listener never sees a part count that hasn't finished uploading.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync, openSync, readSync, closeSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const args = process.argv.slice(2);
const upload = args.includes("--upload");
const epPath = path.resolve(root, args.find((a) => !a.startsWith("--")) || "assets/ep/dead-ocean.json");
const ep = JSON.parse(readFileSync(epPath, "utf8"));
const release = ep.private && ep.private.release;
if (!release) { console.error(`${path.relative(root, epPath)} has no private.release — nothing to do`); process.exit(1); }

const PART = 2 * 1024 * 1024; // keeps each /api/stream response well under the buffered-function cap
const BITRATE = "256k";
const out = path.join(here, "out", release);
const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
const codec = /\baac_at\b/.test(encoders) ? "aac_at" : "aac"; // AudioToolbox on macOS, ffmpeg's own otherwise

const manifest = { release, codec: `aac ${BITRATE}`, made: new Date().toISOString(), tracks: {} };
for (const t of ep.tracks) {
  const src = path.resolve(root, ep.audioBase || "", t.file);
  const dir = path.join(out, t.slug);
  const m4a = path.join(out, `${t.slug}.m4a`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  console.log(`encode  ${path.relative(root, src)} → ${t.slug}.m4a (${codec} ${BITRATE})`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vn", "-map_metadata", "-1",
    "-ac", "2", "-ar", "48000", "-c:a", codec, "-b:a", BITRATE, "-movflags", "+faststart", m4a], { stdio: "inherit" });
  const bytes = statSync(m4a).size;
  const fd = openSync(m4a, "r");
  let parts = 0;
  for (let off = 0; off < bytes; off += PART, parts++) {
    const buf = Buffer.alloc(Math.min(PART, bytes - off));
    readSync(fd, buf, 0, buf.length, off);
    writeFileSync(path.join(dir, String(parts)), buf);
  }
  closeSync(fd);
  manifest.tracks[t.slug] = { parts, bytes, type: "audio/mp4" };
  console.log(`        ${(bytes / 1048576).toFixed(1)} MB in ${parts} parts`);
}
writeFileSync(path.join(out, "manifest"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote   ${path.relative(root, out)}/`);

if (upload) {
  const set = (key, file) => execFileSync("netlify", ["blobs:set", "releases", key, "--input", file, "--force"], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
  for (const [slug, t] of Object.entries(manifest.tracks)) {
    for (let i = 0; i < t.parts; i++) {
      process.stdout.write(`\rupload  ${slug} ${i + 1}/${t.parts}   `);
      set(`${release}/${slug}/${i}`, path.join(out, slug, String(i)));
    }
    process.stdout.write("\n");
  }
  set(`${release}/manifest`, path.join(out, "manifest"));
  console.log(`upload  ${release}/manifest — live for anyone holding the listen cookie`);
}
