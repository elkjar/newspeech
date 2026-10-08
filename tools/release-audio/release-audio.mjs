#!/usr/bin/env node
// The audio for a private pre-release (see netlify/lib/listen.mjs + r2.mjs).
//
//   node tools/release-audio/release-audio.mjs [assets/ep/dead-ocean.json] [--upload]
//
// For every track in the EP config: encode <audioBase><file> to 256k AAC
// (48k — the rate the page decodes at; never the masters) and cut a 15s
// preview — the public taste before the email. The preview starts at the
// track's `previewStart` (seconds) in the config, or else at the loudest 15s.
// With a `download` block in the config it also builds the full-res zips the
// way Bandcamp hands them out: one per format, "<artist> - <album>.zip" holding
// "<artist> - <album> - 01 <name>.<ext>" per track + cover.jpg, every file
// tagged (and, where the format carries one, the cover embedded).
//
// Everything lands under tools/release-audio/out/<release>/ laid out exactly
// as the bucket keys (gitignored; LISTEN_LOCAL_DIR=tools/release-audio/out
// serves it locally):
//   manifest.json  stream/<slug>.m4a  preview/<slug>.m4a  download/<format>.zip
// --upload then PUTs them to the R2 bucket. R2_* come from the environment,
// or else from ~/.config/newspeech/r2.env (KEY=value lines, outside the repo —
// Netlify marks the keys secret, so they can't be read back from the site).
// Re-run after any new mix; the manifest goes up last, so nobody is offered a
// file that hasn't finished uploading.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const args = process.argv.slice(2);
const upload = args.includes("--upload");
const epPath = path.resolve(root, args.find((a) => !a.startsWith("--")) || "assets/ep/dead-ocean.json");
const ep = JSON.parse(readFileSync(epPath, "utf8"));
const release = ep.private && ep.private.release;
if (!release) { console.error(`${path.relative(root, epPath)} has no private.release — nothing to do`); process.exit(1); }

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
rmSync(out, { recursive: true, force: true });
for (const d of ["stream", "preview", "download", "_stage"]) mkdirSync(path.join(out, d), { recursive: true });
const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], { encoding: "utf8" });
const codec = /\baac_at\b/.test(encoders) ? "aac_at" : "aac"; // AudioToolbox on macOS, ffmpeg's own otherwise

const manifest = { release, codec: `aac ${BITRATE}`, made: new Date().toISOString(), tracks: {}, previews: {} };
for (const t of ep.tracks) {
  const src = path.resolve(root, ep.audioBase || "", t.file);
  const m4a = path.join(out, "stream", `${t.slug}.m4a`);
  console.log(`encode  ${path.relative(root, src)} → ${t.slug}.m4a (${codec} ${BITRATE})`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-vn", "-map_metadata", "-1",
    "-ac", "2", "-ar", "48000", "-c:a", codec, "-b:a", BITRATE, "-movflags", "+faststart", m4a], { stdio: "inherit" });
  const bytes = statSync(m4a).size;
  manifest.tracks[t.slug] = { bytes, type: "audio/mp4" };
  console.log(`        ${(bytes / 1048576).toFixed(1)} MB`);

  const duration = +execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src], { encoding: "utf8" });
  const auto = t.previewStart == null;
  const start = auto ? loudestStart(src, duration) : Math.max(0, Math.min(duration - PREVIEW_S, +t.previewStart));
  const clip = path.join(out, "preview", `${t.slug}.m4a`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(start), "-t", String(PREVIEW_S), "-i", src, "-vn", "-map_metadata", "-1",
    "-af", `afade=t=in:d=${FADE_IN_S},afade=t=out:st=${PREVIEW_S - FADE_OUT_S}:d=${FADE_OUT_S}`,
    "-ac", "2", "-ar", "48000", "-c:a", codec, "-b:a", BITRATE, "-movflags", "+faststart", "-f", "mp4", clip], { stdio: "inherit" });
  manifest.previews[t.slug] = { start, auto, bytes: statSync(clip).size };
  const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`;
  console.log(`preview ${mmss(start)} → ${mmss(start + PREVIEW_S)} ${auto ? "(loudest window — set previewStart in the config to choose)" : "(previewStart)"}`);
}
// ---- the full-res downloads ------------------------------------------------
// every format is encoded from the 24/48 masters, never from each other
const FORMATS = {
  flac: { label: "flac", ext: "flac", cover: true, args: ["-c:a", "flac", "-compression_level", "8", "-sample_fmt", "s32", "-bits_per_raw_sample", "24"] },
  alac: { label: "alac (apple music)", ext: "m4a", cover: true, args: ["-c:a", "alac", "-sample_fmt", "s32p", "-bits_per_raw_sample", "24"] },
  wav: { label: "wav", ext: "wav", cover: false, args: ["-c:a", "pcm_s24le"] },
  mp3: { label: "mp3 320", ext: "mp3", cover: true, args: ["-c:a", "libmp3lame", "-b:a", "320k", "-id3v2_version", "3"] },
};
const dl = ep.download;
if (dl) {
  manifest.downloads = {};
  const artist = ep.artist, album = dl.name || ep.title;
  const cover = path.resolve(root, dl.cover || ep.cover);
  const zipName = `${artist} - ${album}.zip`;
  for (const id of dl.formats || Object.keys(FORMATS)) {
    const f = FORMATS[id];
    if (!f) { console.error(`download: no format "${id}" (have ${Object.keys(FORMATS).join(", ")})`); process.exit(1); }
    const stage = path.join(out, "_stage", id);
    mkdirSync(stage, { recursive: true });
    const files = [];
    ep.tracks.forEach((t, i) => {
      const n = String(i + 1).padStart(2, "0");
      const file = path.join(stage, `${artist} - ${album} - ${n} ${t.name || t.title}.${f.ext}`);
      const tags = { title: t.name || t.title, artist, album_artist: artist, album, date: String(dl.year || ""), genre: dl.genre || "", comment: "newspeechsound.com" };
      // vorbis comments want the number and the total apart; the others take n/total
      if (id === "flac") Object.assign(tags, { TRACKNUMBER: String(i + 1), TRACKTOTAL: String(ep.tracks.length) });
      else tags.track = `${i + 1}/${ep.tracks.length}`;
      const inputs = ["-i", path.resolve(root, ep.audioBase || "", t.file)];
      const maps = ["-map", "0:a"];
      if (f.cover) { inputs.push("-i", cover); maps.push("-map", "1:v", "-c:v", "copy", "-disposition:v", "attached_pic", "-metadata:s:v", "comment=Cover (front)"); }
      execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...inputs, ...maps, "-map_metadata", "-1", ...f.args,
        ...Object.entries(tags).flatMap(([k, v]) => ["-metadata", `${k}=${v}`]), file], { stdio: "inherit" });
      files.push(file);
    });
    const art = path.join(stage, "cover.jpg");
    writeFileSync(art, readFileSync(cover));
    files.push(art);
    // stored, not deflated: the audio doesn't compress and this keeps the zip a plain container
    const zip = path.join(out, "download", `${id}.zip`);
    execFileSync("zip", ["-0", "-X", "-q", "-j", zip, ...files]);
    const bytes = statSync(zip).size;
    manifest.downloads[id] = { label: f.label, name: zipName, bytes, type: "application/zip" };
    console.log(`zip     ${id.padEnd(5)} ${(bytes / 1048576).toFixed(1)} MB`);
  }
}

writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`wrote   ${path.relative(root, out)}/`);

if (upload) {
  const keyFile = path.join(os.homedir(), ".config/newspeech/r2.env");
  let file = {};
  try { file = Object.fromEntries(readFileSync(keyFile, "utf8").split("\n").map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/)).filter(Boolean).map((m) => [m[1], m[2]])); } catch (_) {}
  const env = (k) => process.env[k] || file[k];
  const [account, id, key, bucket] = ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"].map(env);
  if (!account || !id || !key || !bucket) { console.error(`R2_* not set — export them or fill in ${keyFile}`); process.exit(1); }
  const { AwsClient } = await import("aws4fetch");
  const { objectUrl } = await import("../../netlify/lib/r2.mjs");
  const r2 = new AwsClient({ accessKeyId: id, secretAccessKey: key, service: "s3", region: "auto" });
  const base = `https://${account}.r2.cloudflarestorage.com/${bucket}`;
  const put = async (rel, headers) => {
    const file = path.join(out, rel);
    const t0 = Date.now();
    process.stdout.write(`upload  ${release}/${rel} (${(statSync(file).size / 1048576).toFixed(1)} MB) … `);
    const r = await r2.fetch(objectUrl(base, `${release}/${rel}`), { method: "PUT", body: readFileSync(file), headers });
    if (!r.ok) { console.error(`\nR2 ${r.status}: ${await r.text()}`); process.exit(1); }
    console.log(`${((Date.now() - t0) / 1000).toFixed(1)}s`);
  };
  for (const slug of Object.keys(manifest.tracks)) await put(`stream/${slug}.m4a`, { "Content-Type": "audio/mp4" });
  for (const slug of Object.keys(manifest.previews)) await put(`preview/${slug}.m4a`, { "Content-Type": "audio/mp4" });
  for (const [fmt, d] of Object.entries(manifest.downloads || {})) {
    // stored with the object, so the signed GET downloads under the right name
    const disp = `attachment; filename="${d.name.replace(/"/g, "")}"; filename*=UTF-8''${encodeURIComponent(d.name)}`;
    await put(`download/${fmt}.zip`, { "Content-Type": "application/zip", "Content-Disposition": disp });
  }
  await put("manifest.json", { "Content-Type": "application/json", "Cache-Control": "no-store" });
  console.log(`done — live for anyone holding the ${release} listen cookie or link`);
}
