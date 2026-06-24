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
import { spawn, execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { readdir, stat, writeFile, mkdir, readFile } from 'node:fs/promises';
import { join, extname, resolve, dirname, basename, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..'); // repo root (core.js + N-*.html)

function parseArgs(argv) {
  const a = {
    audioDir: join(homedir(), 'Desktop'),
    outDir: join(homedir(), 'Desktop'),
    sourceDir: join(homedir(), 'Documents', 'newspeech-visuals'),
    port: 4321,
  };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--audio-dir') { a.audioDir = resolve(argv[++i]); }
    else if (argv[i] === '--out-dir') { a.outDir = resolve(argv[++i]); }
    else if (argv[i] === '--source-dir') { a.sourceDir = resolve(argv[++i]); }
    else if (argv[i] === '--port') { a.port = parseInt(argv[++i], 10); }
  }
  return a;
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.gif': 'image/gif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.aif': 'audio/aiff', '.aiff': 'audio/aiff', '.flac': 'audio/flac', '.m4a': 'audio/mp4',
};
const AUDIO_EXT = new Set(['.wav', '.mp3', '.aif', '.aiff', '.flac', '.m4a']);
const SOURCE_EXT = new Set(['.mp4', '.mov', '.webm', '.m4v', '.png', '.jpg', '.jpeg', '.gif']);

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'access-control-allow-origin': '*' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function serveFile(res, path) {
  res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
  createReadStream(path).pipe(res);
}
const LOOKS_FILE = join(HERE, 'looks.json');
// Looks are GLOBAL presets — a flat list of { name, page, state }; each look
// captures its visualizer, so the selector can jump between any of them.
async function readLooks() {
  try { const d = JSON.parse(await readFile(LOOKS_FILE, 'utf8')); return Array.isArray(d) ? d : []; } catch { return []; }
}
async function writeLooks(looks) {
  await writeFile(LOOKS_FILE, JSON.stringify(looks, null, 2));
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
        const files = (await readdir(ROOT))
          .filter((f) => /^\d+-.*\.html$/.test(f))
          .sort((x, y) => parseInt(x) - parseInt(y));
        const pages = [];
        for (const f of files) {
          // Source-reliant pages composite a picked image/video — not yet
          // supported by the renderer, so flag them in the UI.
          let source = false;
          try { source = /getSource|id="src-file"|panel-source/.test(await readFile(join(ROOT, f), 'utf8')); } catch {}
          pages.push({ file: f, source });
        }
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
      if (p === '/api/sources') {
        const files = await readdir(a.sourceDir).catch(() => []);
        const list = files.filter((f) => SOURCE_EXT.has(extname(f).toLowerCase())).sort();
        return send(res, 200, list);
      }
      if (p.startsWith('/source/')) {
        const name = basename(decodeURIComponent(p.slice('/source/'.length)));
        const path = join(a.sourceDir, name);
        const s = await stat(path).catch(() => null);
        if (!s) return send(res, 404, { error: 'not found' });
        return serveFile(res, path);
      }
      // Native macOS file chooser — lets you grab audio/source from anywhere on
      // disk, not just the configured dirs. Returns the absolute path; the UI
      // then references it via /file?path=… (preview) and passes it to render.
      if (p === '/api/pick') {
        const type = u.searchParams.get('type') === 'source' ? 'source' : 'audio';
        const prompt = type === 'source' ? 'Pick a source video / image' : 'Pick an audio file';
        const uti = type === 'source' ? '{"public.movie", "public.image"}' : '{"public.audio"}';
        const script = `POSIX path of (choose file with prompt "${prompt}" of type ${uti})`;
        const picked = await new Promise((done) => {
          execFile('osascript', ['-e', script], (err, stdout, stderr) => {
            if (err) return done({ canceled: /-128|User canceled/.test(stderr || '') ? true : undefined, error: /-128|User canceled/.test(stderr || '') ? undefined : (stderr || err.message).trim() });
            done({ path: stdout.trim() });
          });
        });
        if (picked.path) return send(res, 200, { path: picked.path, name: basename(picked.path) });
        return send(res, picked.error ? 500 : 200, picked);
      }
      // Serve any file on disk by absolute path (browsed picks), gated to known
      // media extensions. Localhost-only server, so this is the access boundary.
      if (p === '/file') {
        const fp = u.searchParams.get('path');
        if (!fp || !isAbsolute(fp)) return send(res, 400, { error: 'absolute path required' });
        const ext = extname(fp).toLowerCase();
        if (!AUDIO_EXT.has(ext) && !SOURCE_EXT.has(ext)) return send(res, 403, { error: 'unsupported type' });
        const s = await stat(fp).catch(() => null);
        if (!s || s.isDirectory()) return send(res, 404, { error: 'not found' });
        return serveFile(res, fp);
      }
      if (p === '/api/render' && req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        return runRender(res, a, body);
      }
      // Saved per-visualizer "looks" (named state snapshots), persisted to disk.
      if (p === '/api/looks' && req.method === 'GET') {
        return send(res, 200, await readLooks());
      }
      if (p === '/api/looks' && req.method === 'POST') {
        const { page, name, state } = JSON.parse(await readBody(req));
        let looks = (await readLooks()).filter((l) => l.name !== name);
        looks.push({ name, page, state });
        await writeLooks(looks);
        return send(res, 200, { ok: true, looks });
      }
      if (p === '/api/looks/delete' && req.method === 'POST') {
        const { name } = JSON.parse(await readBody(req));
        const looks = (await readLooks()).filter((l) => l.name !== name);
        await writeLooks(looks);
        return send(res, 200, { ok: true, looks });
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

  const outName = `${body.page}-${stamp}.mp4`;
  const outPath = join(a.outDir, outName);
  const args = [
    join(HERE, 'render.mjs'),
    '--fps', String(body.fps ?? 30),
    '--scale', String(body.scale ?? 2),
    '--gain', String(body.gain ?? 1),
    '--out', outPath,
  ];
  // A picked file may be an absolute path (native browse) or a bare filename
  // from the configured dir — resolve each accordingly.
  const absOrIn = (dir, name) => (isAbsolute(name) ? name : join(dir, basename(name)));
  if (body.jpeg !== false) args.push('--jpeg'); // studio defaults to fast JPEG capture
  if (body.audio) args.push('--audio', absOrIn(a.audioDir, body.audio));

  // Source filenames from the UI → absolute paths the renderer can serve.
  const srcPath = (name) => (name ? absOrIn(a.sourceDir, name) : undefined);

  if (body.timeline) {
    // Multi-visualizer performance: a segment timeline (hard cuts).
    for (const seg of body.timeline.segments || []) {
      if (seg.state?.source) seg.state.source = srcPath(seg.state.source);
    }
    const tlPath = join(tmpDir, `timeline-${stamp}.json`);
    await writeFile(tlPath, JSON.stringify(body.timeline));
    args.push('--timeline', tlPath);
  } else {
    // Single visualizer (+ optional automation).
    const statePath = join(tmpDir, `state-${stamp}.json`);
    await writeFile(statePath, JSON.stringify({
      localStorage: body.localStorage || {},
      params: body.params || {},
      automation: body.automation || [],
      source: srcPath(body.source),
      useSourceAudio: !!body.useSourceAudio,
    }));
    args.push('--page', body.page, '--seconds', String(body.seconds ?? 30), '--state', statePath);
  }

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
