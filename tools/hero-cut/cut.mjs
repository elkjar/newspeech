// hero-cut — the homepage hero loop, cut from an edit list.
//
// usage: node tools/hero-cut/cut.mjs            → assets/hero/hero.mp4 + hero.jpg
//        HERO_W=1920 HERO_CRF=12 HERO_DENOISE=0 HERO_OUT=~/Desktop HERO_NAME=hero-master node tools/hero-cut/cut.mjs
//                                            → high-quality master for further mangling
// shot choice: closeups over wides.
//
// the cut follows the SOUP homepage header idea but faster: ~0.5 s holds broken
// by bursts of 8-frame stutters, live footage from the sequence test-flight master intercut
// with visualizer renders from the pool. no audio. everything is forced mono.
// durations are in FRAMES at 24 fps so cuts land exactly.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FPS = 24;
const W = Number(process.env.HERO_W || 1280);
const H = Math.round((W * 9) / 16);
const OUT_DIR = path.resolve(process.env.HERO_OUT || "assets/hero");
const NAME = process.env.HERO_NAME || "hero";

const H2 = process.env.HERO_H2 ||
  path.join(os.homedir(), "Library/CloudStorage/Dropbox-Personal/___MUSIC/___NEWSPEECH/CONTENT/VIDEO/20260610_NS_T1/20260613_NS_T1_H2_1.mov");
const POOL = process.env.HERO_POOL || path.join(os.homedir(), "Documents/newspeech-visuals/_originals");
const pool = (name) => path.join(POOL, name);
// a colour-bars test pattern — flashed in COLOUR, the one exception to mono
// (the same idiom as the wordmark's chroma flash)
const BARS = process.env.HERO_BARS || path.join(os.homedir(), "Desktop/test-video.mp4");
// the PIPER MARU 3 edit (Resolve export) — archival space-program footage.
// exported to the Desktop 2026-09-09; move it beside the test-flight master
// in Dropbox CONTENT/VIDEO and point HERO_PM at it once it lives there.
// black-eyes-2 (EP2 NIGHT SCHOOL social cut) — one continuous snare closeup
const BE2 = process.env.HERO_BE2 || path.join(os.homedir(),
  "Library/CloudStorage/Dropbox-Personal/___MUSIC/___NEWSPEECH/__EP2_NIGHT_SCHOOL/03 - BLACK EYES/SOCIAL/black-eyes-2.mp4");
const PM = process.env.HERO_PM || path.join(os.homedir(), "Desktop/PIPER MARU 3 - edit.mov");

// holds are short — nothing sits (Chris, 2026-09-09: the hold shots aren't
// cool enough to sit on). ~0.5 s vs 8-frame stutters.
const HOLD = 14, HOLD_S = 12, HOLD_L = 16, STUT = 8; // frames

// [source, in-point seconds, frames, opts?]  opts.color keeps the clip's colour
const EDL = [
  [H2, 28.2, HOLD_L],              // drummer, wide
  [H2, 21.8, HOLD_S],              // knobs, close
  [pool("grid-01.mp4"), 4.0, STUT],
  [PM, 46.0, STUT],                // archival: missile in flight
  [H2, 100.1, STUT],               // launchpad lights
  [pool("network-01.mp4"), 2.0, STUT],
  [H2, 24.5, HOLD],                // hand on the keys
  [H2, 69.0, HOLD_S],              // guitar hands
  [H2, 60.0, STUT],                // density terminal
  [H2, 31.0, STUT],                // eye, glitched close
  [PM, 162.0, STUT],               // archival: moon edge, near-white flash
  [pool("scans-01.mp4"), 5.0, STUT],
  [BARS, 1.2, STUT, { color: true }], // test pattern flash
  [H2, 86.0, HOLD],                // guitar hands, pick
  [H2, 38.5, HOLD_S],              // pedals + knobs, close
  [PM, 124.9, HOLD_S],             // archival: rocket launch
  [pool("v04.mp4"), 15.0, STUT],
  [PM, 51.5, STUT],                // archival: radar screen
  [H2, 103.0, STUT],               // pads screen
  [H2, 20.0, STUT],                // knobs
  [H2, 112.5, HOLD_L],             // eye, glitched
  [H2, 30.6, HOLD_S],              // arm + terminal
  [pool("v06.mp4"), 10.0, STUT],
  [H2, 110.0, STUT],               // eye, glitched
  [PM, 258.5, STUT],               // archival: cosmonaut helmet
  [pool("v08.mp4"), 4.0, STUT],
  [H2, 41.2, HOLD_S],              // pedalboard
  [H2, 71.5, HOLD_S],              // guitar hands 2
  [PM, 110.0, STUT],               // archival: crosswalk from above
  [H2, 76.0, STUT],                // amp
  [pool("swarm-02.mp4"), 5.0, STUT],
  [PM, 227.6, STUT],               // archival: mission control
  [H2, 96.5, HOLD],                // feet on pedals
  [BE2, 9.0, HOLD_S],              // snare head, sticks
  [H2, 100.3, STUT],               // launchpad
  [H2, 60.8, STUT],                // density terminal 2
  [PM, 246.0, STUT],               // archival: launch flame
  [pool("grid-01.mp4"), 12.0, STUT],
  [PM, 264.0, STUT],               // archival: satellite
  [BARS, 4.0, STUT / 2, { color: true }], // test pattern, half a beat
  [H2, 92.5, HOLD_S],              // hands
  [BE2, 22.0, STUT],               // snare, hit
  [H2, 105.5, HOLD],               // pads screen → loops into the opening
];

for (const [src] of EDL) if (!fs.existsSync(src)) { console.error("missing source:", src); process.exit(1); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "hero-cut-"));
// light temporal denoise: the source grain costs bits and the site lays its own
// grain over the hero anyway (core.js). HERO_DENOISE=0 keeps the source grain.
const DENOISE = process.env.HERO_DENOISE === "0" ? "" : ",hqdn3d=2:1.5:4:4";
const CRF = process.env.HERO_CRF || "27";
const fit = `fps=${FPS},scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}${DENOISE}`;
const segs = EDL.map(([src, t, n, opts = {}], i) => {
  const vf = `${fit}${opts.color ? "" : ",hue=s=0"},format=yuv420p`;
  const out = path.join(tmp, `seg${String(i).padStart(2, "0")}.mp4`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", src, "-frames:v", String(n),
    "-vf", vf, "-an", "-c:v", "libx264", "-crf", "10", "-preset", "fast", out], { stdio: "inherit" });
  return out;
});
const list = path.join(tmp, "list.txt");
fs.writeFileSync(list, segs.map((s) => `file '${s}'`).join("\n") + "\n");

fs.mkdirSync(OUT_DIR, { recursive: true });
const mp4 = path.join(OUT_DIR, `${NAME}.mp4`);
execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list,
  "-c:v", "libx264", "-crf", CRF, "-preset", "slow", "-profile:v", "high", "-pix_fmt", "yuv420p",
  "-g", String(FPS * 2), "-movflags", "+faststart", "-an", mp4], { stdio: "inherit" });
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", mp4, "-frames:v", "1", "-q:v", "4", path.join(OUT_DIR, `${NAME}.jpg`)], { stdio: "inherit" });

const frames = EDL.reduce((a, [, , n]) => a + n, 0);
console.log(`hero-cut: ${EDL.length} cuts, ${(frames / FPS).toFixed(1)} s, ${W}x${H} → ${mp4} (${(fs.statSync(mp4).size / 1e6).toFixed(1)} MB)`);
fs.rmSync(tmp, { recursive: true, force: true });
