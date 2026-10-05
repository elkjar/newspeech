#!/usr/bin/env node
// Stream copies for a private pre-release (see netlify/lib/listen.mjs).
//
//   node tools/release-audio/release-audio.mjs [assets/ep/dead-ocean.json] [--upload]
//
// For every track in the EP config: encode <audioBase><file> to 256k AAC
// (48k — the rate the page decodes at; never the masters), cut it into 2 MiB
// parts, and cut a 15s preview — the public taste before the email. The
// preview starts at the track's `previewStart` (seconds) in the config, or
// else at the loudest 15s of the track. Everything lands under
// tools/release-audio/out/<release>/ (gitignored; LISTEN_LOCAL_DIR=
// tools/release-audio/out serves it locally).
// --upload then puts every part, preview + the manifest in the site's "releases"
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
const PREVIEW_S = 15, FADE_IN_S = 0.5, FADE_OUT_S = 1.5;

// the loudest PREVIEW_S window by mean power, one RMS reading per second,
// kept off the first 10% (intros) and the last 15 seconds
function loudestStart(src, duration) {
  const out = execFileSync("ffmpeg", ["-hide_banner", "-nostats", "-i", src, "-af",
    "aresample=8000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1,ametadata=print:key=lavfi.astats.Overall.RMS_level:file=-",
    "-f", "null", "-"], { encoding: "utf8", maxBuffer: 64 << 20, stdio: ["ignore", "pipe", "ignore"] });
  const db = [...out.matchAll(/RMS_level=(-?[\d.]+|-inf)/g)].map((m) => (m[1] === "-inf" ? -120 : +m[1]));
  const pw = db.map((d) => Math.pow(10, d / 10));
  const lo = Math.floor(duration * 0.1), hi = Math.min(pw.length, Math.floor(duration)) - PREVIEW_S;
  let best = lo, bestSum = -1;
  for (let s = lo; s <= hi; s++) {
    let sum = 0; for (let k = 0; k < PREVIEW_S; k++) sum += pw[s + k] || 0;
    if (sum > bestSum) { bestSum = sum; best = s; }
  }
  return best;
}
const out = path.join(here, "out", release);
const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
const codec = /\baac_at\b/.test(encoders) ? "aac_at" : "aac"; // AudioToolbox on macOS, ffmpeg's own otherwise

const manifest = { release, codec: `aac ${BITRATE}`, made: new Date().toISOString(), tracks: {}, previews: {} };
mkdirSync(path.join(out, "preview"), { recursive: true });
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

  const duration = +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src], { encoding: "utf8" });
  const auto = t.previewStart == null;
  const start = auto ? loudestStart(src, duration) : Math.max(0, Math.min(duration - PREVIEW_S, +t.previewStart));
  const clip = path.join(out, "preview", t.slug);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-t", String(PREVIEW_S), "-i", src, "-vn", "-map_metadata", "-1",
    "-af", `afade=t=in:d=${FADE_IN_S},afade=t=out:st=${PREVIEW_S - FADE_OUT_S}:d=${FADE_OUT_S}`,
    "-ac", "2", "-ar", "48000", "-c:a", codec, "-b:a", BITRATE, "-movflags", "+faststart", "-f", "mp4", clip], { stdio: "inherit" });
  manifest.previews[t.slug] = { start, auto, bytes: statSync(clip).size };
  const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`;
  console.log(`preview ${mmss(start)} → ${mmss(start + PREVIEW_S)} ${auto ? "(loudest window — set previewStart in the config to choose)" : "(previewStart)"}`);
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
  for (const slug of Object.keys(manifest.previews)) set(`${release}/preview/${slug}`, path.join(out, "preview", slug));
  console.log(`upload  ${Object.keys(manifest.previews).length} previews (public)`);
  set(`${release}/manifest`, path.join(out, "manifest"));
  console.log(`upload  ${release}/manifest — live for anyone holding the listen cookie`);
}
