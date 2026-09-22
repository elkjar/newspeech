// pool-shots — feed the BROADCAST video pool with the homepage supercut's
// shots. Every live / archival in-point the hero EDL (cut.mjs) uses becomes
// one 8 s clip in ~/Documents/newspeech-visuals/, encoded with the pool
// recipe (see the chunk-pool-videos skill: 720p, H.264 main, GOP = 1 s,
// no audio, faststart) and named word_hex like the chunked pool files.
// Mono is baked in, as in the supercut. Also writes one still per shot to
// ~/Desktop/BROADCAST/BACKGROUNDS/ for the desktop ground.
//
// usage: node tools/hero-cut/pool-shots.mjs            (skips shots already cut — see .pool-shots.json)
//        POOL_SHOTS_STILLS=0 node …                      (clips only)
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const DB = path.join(os.homedir(), "Library/CloudStorage/Dropbox-Personal/___MUSIC/___NEWSPEECH");
const H2 = path.join(DB, "CONTENT/VIDEO/20260610_NS_T1/20260613_NS_T1_H2_1.mov");
const BE2 = path.join(DB, "__EP2_NIGHT_SCHOOL/03 - BLACK EYES/SOCIAL/black-eyes-2.mp4");
const PM = path.join(DB, "__EP2_NIGHT_SCHOOL/02 - PIPER MARU/VIDEO ASSETS/PIPER MARU 3 - edit.mov");
const POOL = path.join(os.homedir(), "Documents/newspeech-visuals");
const BG = path.join(os.homedir(), "Desktop/BROADCAST/BACKGROUNDS");
const LEDGER = path.join(POOL, ".pool-shots.json");
const SECS = 8;
const LEAD = 1; // start a second before the supercut's in-point

// [source, in-point s, note] — the supercut's shots, near-duplicates folded.
const SHOTS = [
  [H2, 28.2, "drummer wide"], [H2, 21.8, "knobs close"], [H2, 100.1, "launchpad lights"],
  [H2, 24.5, "hand on keys"], [H2, 69.0, "guitar hands"], [H2, 60.0, "density terminal"],
  [H2, 31.0, "eye glitched"], [H2, 86.0, "guitar hands pick"], [H2, 38.5, "pedals knobs"],
  [H2, 103.0, "pads screen"], [H2, 20.0, "knobs"], [H2, 112.5, "eye glitched 2"],
  [H2, 45.0, "face cymbal"], [H2, 110.0, "eye glitched 3"], [H2, 41.2, "pedalboard"],
  [H2, 84.0, "guitar hands 2"], [H2, 76.0, "amp"], [H2, 96.5, "feet on pedals"],
  [H2, 62.5, "kit wide"], [H2, 92.5, "hands"],
  [PM, 46.0, "missile"], [PM, 162.0, "moon edge"], [PM, 124.9, "rocket launch"],
  [PM, 51.5, "radar"], [PM, 258.5, "cosmonaut"], [PM, 110.0, "crosswalk"],
  [PM, 227.6, "mission control"], [PM, 246.0, "launch flame"], [PM, 264.0, "satellite"],
  [BE2, 9.0, "snare head"], [BE2, 22.0, "snare hit"],
];
const WORDS = ("static hiss null void fracture drift decay smear dropout bleed stutter shred scrape ash soot rust scar lapse gap snag kink " +
  "drone husk blur halo flare spark smoke melt sear jitter glitch lurch scuff scour dust frost char snap fold plank hatch vault " +
  "mire churn slick slag gnaw mince slough warp blot pivot fray crawl creep floe brine grit knot welt rasp clamp slip").split(/\s+/);

for (const [src] of SHOTS) if (!fs.existsSync(src)) { console.error("missing source:", src); process.exit(1); }
fs.mkdirSync(POOL, { recursive: true });
fs.mkdirSync(BG, { recursive: true });
const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : {};
const taken = new Set(fs.readdirSync(POOL).map((f) => f.toLowerCase()));
const name = () => {
  for (;;) {
    const n = `${WORDS[Math.floor(Math.random() * WORDS.length)]}_${crypto.randomBytes(2).toString("hex")}.mp4`;
    if (!taken.has(n)) { taken.add(n); return n; }
  }
};
const fit = "fps=24,scale=1280:720:force_original_aspect_ratio=increase,crop=1280:720,hue=s=0,format=yuv420p";
const stills = process.env.POOL_SHOTS_STILLS !== "0";
let made = 0;
for (const [src, t, note] of SHOTS) {
  const key = `${path.basename(src)}@${t}`;
  if (ledger[key] && fs.existsSync(path.join(POOL, ledger[key]))) continue;
  const out = name();
  const ss = Math.max(0, t - LEAD);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(ss), "-i", src, "-t", String(SECS), "-vf", fit, "-an",
    "-c:v", "libx264", "-profile:v", "main", "-preset", "slow", "-crf", "23", "-g", "24", "-keyint_min", "24", "-sc_threshold", "0",
    "-movflags", "+faststart", path.join(POOL, out)], { stdio: "inherit" });
  if (stills) {
    // the ground sits under the windows: mono, pulled down a little so the
    // chrome reads over it, 1080p from the shot's own in-point
    const still = path.join(BG, out.replace(/\.mp4$/, ".jpg"));
    execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", src, "-frames:v", "1",
      "-vf", "scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,hue=s=0,eq=brightness=-0.12:contrast=1.15", "-q:v", "3", still], { stdio: "inherit" });
  }
  ledger[key] = out;
  fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 2) + "\n");
  made++;
  console.log(`${out}  ← ${path.basename(src)} @ ${t}s  (${note})`);
}
console.log(`pool-shots: ${made} new clip(s), ${Object.keys(ledger).length} total from the supercut → ${POOL}`);
