#!/usr/bin/env node
// reel-render studio — a local UI to tune a visualizer against your audio with
// a live, audio-reactive preview, then trigger the offline (pristine) render.
//
// Serves the repo root + a studio shell, lets you pick a visualizer + an audio
// file, previews the visualizer reacting to that audio in real time (a
// browser-side analyser feeds Newspeech.setExternalAudio), and on Render hands
// the tuned params off to render.mjs for the deterministic 1080x1920 export.
//
// Usage:
//   node studio.mjs [--audio-dir ~/Desktop] [--out-dir ~/Desktop] [--port 4321]
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // repo root (core.js + N-*.html)

function parseArgs(argv) {
  const a = { audioDir: join(homedir(), 'Desktop'), outDir: join(homedir(), 'Desktop'), port: 4321 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--audio-dir') { a.audioDir = resolve(argv[++i]); }
    else if (argv[i] === '--out-dir') { a.outDir = resolve(argv[++i]); }
    else if (argv[i] === '--port') { a.port = parseInt(argv[++i], 10); }
  }
  return a;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.webm': 'video/webm',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.flac': 'audio/flac',
};
const AUDIO_EXT = new Set(['.wav', '.mp3', '.aif', '.aiff', '.flac', '.m4a']);

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function serveFile(res, path) {
  res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
  createReadStream(path).pipe(res);
}
function readBody(req) {
  return new Promise((resolveBody) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
  });
}

async function main() {
  const a = parseArgs(process.argv);

  const server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://localhost');
      const p = u.pathname;

      if (p === '/' || p === '/studio') return serveFile(res, join(HERE, 'studio.html'));

      if (p === '/api/pages') {
        const files = await readdir(ROOT);
        const pages = files.filter((f) => /^\d+-.*\.html$/.test(f)).sort((x, y) => parseInt(x) - parseInt(y));
        return send(res, 200, pages);
      }
      if (p === '/api/audio') {
        const files = await readdir(a.audioDir).catch(() => []);
        const list = files.filter((f) => AUDIO_EXT.has(extname(f).toLowerCase())).sort();
        return send(res, 200, list);
      }
      if (p.startsWith('/audio/')) {
        const name = basename(decodeURIComponent(p.slice('/audio/'.length)));
        const path = join(a.audioDir, name);
        const s = await stat(path).catch(() => null);
        if (!s) return send(res, 404, { error: 'not found' });
        return serveFile(res, path);
      }
      if (p.startsWith('/out/')) {
        const name = basename(decodeURIComponent(p.slice('/out/'.length)));
        const path = join(a.outDir, name);
        const s = await stat(path).catch(() => null);
        if (!s) return send(res, 404, { error: 'not found' });
        return serveFile(res, path);
      }
      if (p === '/api/render' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        return runRender(res, a, body);
      }

      // static: serve from repo root
      const path = resolve(ROOT, '.' + decodeURIComponent(p));
      if (!path.startsWith(ROOT)) return send(res, 403, { error: 'forbidden' });
      const s = await stat(path).catch(() => null);
      if (!s || s.isDirectory()) return send(res, 404, { error: 'not found' });
      return serveFile(res, path);
    } catch (e) {
      send(res, 500, { error: String(e) });
    }
  });

  server.listen(a.port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${a.port}/studio`;
    console.log(`[studio] ${url}`);
    console.log(`[studio] audio dir: ${a.audioDir}`);
    console.log(`[studio] output dir: ${a.outDir}`);
    spawn('open', [url]).on('error', () => {}); // macOS convenience; ignore elsewhere
  });
}

// Spawn render.mjs with the studio's settings + tuned state, stream progress.
async function runRender(res, a, body) {
  const tmpDir = join(HERE, '.studio');
  await mkdir(tmpDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const statePath = join(tmpDir, `state-${stamp}.json`);
  await writeFile(statePath, JSON.stringify({
    localStorage: body.localStorage || {},
    params: body.params || {},
    automation: body.automation || [],
  }));

  const outName = `${body.page}-${stamp}.mp4`;
  const outPath = join(a.outDir, outName);
  const args = [
    join(HERE, 'render.mjs'),
    '--page', body.page,
    '--seconds', String(body.seconds ?? 30),
    '--fps', String(body.fps ?? 30),
    '--scale', String(body.scale ?? 2),
    '--gain', String(body.gain ?? 1),
    '--state', statePath,
    '--out', outPath,
  ];
  if (body.jpeg !== false) args.push('--jpeg'); // studio defaults to fast JPEG capture
  if (body.audio) args.push('--audio', join(a.audioDir, body.audio));

  res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  const child = spawn('node', args, { cwd: HERE });
  let log = '';
  const cap = (d) => { log += d.toString(); };
  child.stdout.on('data', cap);
  child.stderr.on('data', cap);
  child.on('close', (code) => {
    res.end(JSON.stringify({ ok: code === 0, out: code === 0 ? outName : null, log: log.slice(-4000) }));
  });
}

main();
