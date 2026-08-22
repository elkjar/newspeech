// climate-seq: write climate-record data into Sequence session candidates.
// Stage one of the method — no taste applied here. Every transform is canon
// from MAPPING.md; changing a rule means changing MAPPING.md first.
//
//   node tools/climate-seq/generate.mjs <base.seq> <out.seq>
//
// Reads the base session (never modified), writes storm tracks per the CONFIG
// below, saves to <out.seq>. Refuses to overwrite an existing output file.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const DATA = JSON.parse(readFileSync(new URL("./data.json", import.meta.url), "utf8"));

// ---- canon constants (MAPPING.md) ----
const WIND_LO = 40, WIND_HI = 165;       // absolute kt scale shared by all storms
const DEGREES = 15;                      // two octaves inclusive
const VEL_LO = 0.3, VEL_HI = 1.0;
const PROB = { satellite: 100, aircraft: 85, shiplog: 70 }; // aircraft value provisional
const SCALES = { minor: [0, 2, 3, 5, 7, 8, 10], major: [0, 2, 4, 5, 7, 9, 11] };

// ---- what to write where (edited per candidate; this is layout, not taste) ----
const CONFIG = {
  bpmFromCo2: 427, // ppm for the movement being generated (2026 = 427)
  storms: [
    { key: "s2025", trackId: "t12", era: "satellite" },
    { key: "s1880", trackId: "t10", era: "shiplog" },
  ],
};

const [, , basePath, outPath] = process.argv;
if (!basePath || !outPath) {
  console.error("usage: node generate.mjs <base.seq> <out.seq>");
  process.exit(1);
}
if (existsSync(outPath)) {
  console.error("refusing to overwrite existing file:", outPath);
  process.exit(1);
}

const session = JSON.parse(readFileSync(basePath, "utf8"));
const iv = SCALES[session.scale] || SCALES.minor;
const degToSemi = (d) => 12 * Math.floor(d / iv.length) + iv[d % iv.length];

const blankStep = () => ({
  on: false, velocity: 1, pitch: 0, probability: 100,
  ratchet: 1, microTiming: 0, gate: 1, tieToNext: false,
});

function writeStorm(track, fixes, probability) {
  track.length = 64;
  track.rate = "1/16";
  track.steps = track.steps.map(blankStep);
  let last = 0;
  fixes.forEach((f, i) => {
    const wind = f[2];
    const t = (wind - WIND_LO) / (WIND_HI - WIND_LO);
    const deg = Math.max(0, Math.min(DEGREES - 1, Math.round(t * (DEGREES - 1))));
    const pos = Math.floor((i * 64) / fixes.length); // E(n,64)
    const s = track.steps[pos];
    s.on = true;
    s.pitch = degToSemi(deg);
    s.velocity = +(VEL_LO + t * (VEL_HI - VEL_LO)).toFixed(3);
    s.probability = probability;
    last = pos;
  });
  track.lastPitch = track.steps[last].pitch;
}

session.bpm = Math.round(CONFIG.bpmFromCo2 * 0.35);

for (const { key, trackId, era } of CONFIG.storms) {
  const storm = DATA.storms[key];
  const track = session.tracks.find((t) => t.id === trackId);
  if (!track) { console.error("no track", trackId); process.exit(1); }
  if (storm.pts.length > 64) {
    console.error(key, "has", storm.pts.length, "fixes (>64) — resample policy not decided yet (MAPPING.md)");
    process.exit(1);
  }
  writeStorm(track, storm.pts, PROB[era]);
  console.log(`${storm.year} ${storm.name} -> ${trackId} (${era}, prob ${PROB[era]}, ${storm.pts.length} fixes)`);
}

writeFileSync(outPath, JSON.stringify(session));
console.log("bpm:", session.bpm, "| wrote:", outPath);
