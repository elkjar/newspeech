#!/usr/bin/env node
// textscan — find pool clips with on-screen text (title cards, captions, signs),
// so recipes can skip them when typography goes on top later.
//
// Samples one frame per second of every clip, runs macOS Vision text
// recognition (textscan.swift), and caches the hits per clip in
// <pool>/_text-scan.json. Only clips missing from the cache are scanned, so
// re-running after new clips land in the pool is cheap.
//
// Usage:
//   node textscan.mjs [--pool ~/Documents/newspeech-visuals] [--list]
//   (--list prints every flagged clip with what was read)
// recipe.mjs calls scanPool() itself when a recipe sets base.noText.
import { execFileSync, spawnSync } from 'node:child_process';
import { readFile, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_POOL = join(homedir(), 'Documents', 'newspeech-visuals');

// A clip "has text" when any sampled frame reads ≥3 letters/digits at
// confidence ≥0.5 — deliberately inclusive (signs, newspapers count too).
export const hasText = (entry) => entry.hits.length > 0;
const isHit = (t) => t.c >= 0.5 && (t.s.match(/[A-Za-z0-9]/g) || []).length >= 3;

export async function scanPool(pool = DEFAULT_POOL, { log = console.log } = {}) {
  const cachePath = join(pool, '_text-scan.json');
  const cache = existsSync(cachePath) ? JSON.parse(await readFile(cachePath, 'utf8')) : {};
  const clips = (await readdir(pool)).filter((f) => /\.mp4$/i.test(f) && !f.startsWith('_')).sort();
  const todo = clips.filter((f) => !cache[f]);
  if (todo.length) {
    log(`  textscan: scanning ${todo.length} clip(s) for on-screen text…`);
    const dir = await mkdtemp(join(tmpdir(), 'textscan-'));
    const frames = [];
    for (const f of todo) {
      const stem = basename(f, '.mp4');
      execFileSync('ffmpeg', ['-v', 'error', '-i', join(pool, f), '-vf', 'fps=1,scale=960:-2', join(dir, `${stem}__%02d.png`)]);
      frames.push(...(await readdir(dir)).filter((x) => x.startsWith(`${stem}__`)).map((x) => join(dir, x)));
    }
    // Vision in batches (one swift process per batch keeps startup cost down).
    const byClip = Object.fromEntries(todo.map((f) => [f, []]));
    for (let i = 0; i < frames.length; i += 200) {
      const r = spawnSync('swift', [join(HERE, 'textscan.swift'), ...frames.slice(i, i + 200)], { maxBuffer: 1 << 26 });
      if (r.status !== 0) throw new Error(`textscan.swift failed: ${r.stderr}`);
      for (const line of r.stdout.toString().trim().split('\n').filter(Boolean)) {
        const { path, texts } = JSON.parse(line);
        const clip = basename(path).replace(/__\d+\.png$/, '.mp4');
        byClip[clip].push(...texts.filter((t) => t.s && isHit(t)).map((t) => t.s));
      }
    }
    for (const f of todo) cache[f] = { hits: [...new Set(byClip[f])] };
    await writeFile(cachePath, JSON.stringify(cache, null, 1) + '\n');
    await rm(dir, { recursive: true, force: true });
  }
  return cache;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--pool');
  const pool = i > 0 ? process.argv[i + 1].replace(/^~/, homedir()) : DEFAULT_POOL;
  const cache = await scanPool(pool);
  const flagged = Object.entries(cache).filter(([, e]) => hasText(e));
  console.log(`${flagged.length}/${Object.keys(cache).length} clips have on-screen text`);
  if (process.argv.includes('--list')) for (const [f, e] of flagged) console.log(`  ${f}: ${e.hits.slice(0, 6).join(' | ')}`);
}
