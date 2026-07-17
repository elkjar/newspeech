#!/usr/bin/env node
// build-samples-manifest.mjs — pre-bake the samples.html tree.
//
// samples.html used to fetch 47 kit.seqkit files sequentially at page load
// (one await per pack ≈ seconds of round-trips). this script does that walk
// at build time instead and emits ONE render-ready samples-manifest.json the
// page fetches in a single request.
//
// run from the repo root: node tools/build-samples-manifest.mjs
// build.sh runs it on every deploy, so dropping a new pack folder under
// sequencer/public/samples/<category>/<pack>/ (with its kit.seqkit) is all
// an update takes — the next push republishes the manifest.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SAMPLES_DIR = path.join(ROOT, "sequencer", "public", "samples");
const OUT = path.join(ROOT, "samples-manifest.json");
// URL base the page serves WAVs from (build.sh publishes the samples tree there)
const SAMPLE_BASE = "sequencer/samples";

// fixed presentation order; any new category directories append after these
const CATEGORY_ORDER = ["drums", "bass", "instruments", "pads"];

const byName = (a, b) => a.toLowerCase().localeCompare(b.toLowerCase());

function fileLeaf(rel, baseUrl) {
  return { name: rel.split("/").pop(), url: `${baseUrl}/${rel}` };
}

// same adapter samples.html used client-side:
// drum packs:    voices: { id: { files: [...] } }           → voice subfolders
// pitched packs: voices: { id: { roots: [{ midi, files }] } } → flat, midi-sorted
function packToNode(packName, manifest, baseUrl) {
  const voices = manifest.voices ?? {};
  const isDrumPack = Object.values(voices).some((v) => Array.isArray(v.files));
  if (isDrumPack) {
    const children = Object.entries(voices).map(([voiceId, voice]) => ({
      name: voiceId,
      children: (voice.files ?? []).map((rel) => fileLeaf(rel, baseUrl)),
    }));
    return { name: packName, children };
  }
  const leaves = [];
  for (const voice of Object.values(voices)) {
    for (const root of voice.roots ?? []) {
      for (const rel of root.files ?? []) {
        leaves.push({ ...fileLeaf(rel, baseUrl), midi: root.midi });
      }
    }
  }
  leaves.sort((a, b) => (a.midi ?? 0) - (b.midi ?? 0));
  return { name: packName, children: leaves };
}

const onDisk = fs.readdirSync(SAMPLES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
const categories = [
  ...CATEGORY_ORDER.filter((c) => onDisk.includes(c)),
  ...onDisk.filter((c) => !CATEGORY_ORDER.includes(c)).sort(byName),
];

let packCount = 0;
let fileCount = 0;
const tree = [];
for (const cat of categories) {
  const catDir = path.join(SAMPLES_DIR, cat);
  const packs = fs.readdirSync(catDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(catDir, d.name, "kit.seqkit")))
    .map((d) => d.name)
    .sort(byName);
  const catNode = { name: cat, children: [] };
  for (const pack of packs) {
    const seqkitPath = path.join(catDir, pack, "kit.seqkit");
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(seqkitPath, "utf8"));
    } catch (err) {
      console.warn(`skipping ${cat}/${pack}: unreadable kit.seqkit (${err.message})`);
      continue;
    }
    const node = packToNode(pack, manifest, `${SAMPLE_BASE}/${cat}/${pack}`);
    const n = (function count(nd) {
      return nd.children ? nd.children.reduce((s, c) => s + count(c), 0) : 1;
    })(node);
    packCount += 1;
    fileCount += n;
    catNode.children.push(node);
  }
  tree.push(catNode);
}

fs.writeFileSync(OUT, JSON.stringify(tree));
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`samples-manifest.json: ${categories.length} categories, ${packCount} packs, ${fileCount} files (${kb} KB)`);
