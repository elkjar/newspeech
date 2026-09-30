#!/usr/bin/env node
// edit — local hardware editor for the synth rack.
// MIDI lives in the browser (Web MIDI, Chrome); this server only serves the UI,
// the device schemas, and writes BACKUPS. The synth's own memory is the source
// of truth — there's no patch library; backups are whole-memory .syx dumps
// (plus single slots saved just before "store" overwrites them).
//
//   node tools/rack/server.mjs            → http://127.0.0.1:4330
//   RACK_LIBRARY=/path node server.mjs    → backups root elsewhere

import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4330);
const LIBRARY = process.env.RACK_LIBRARY ||
  path.join(os.homedir(), "Library/CloudStorage/Dropbox-Personal/___MUSIC/___NEWSPEECH/__RACK");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" };

// device ids and patch names become path segments — keep them tame
const safe = (s) => String(s).replace(/[^\w .\-()+#]/g, "_").trim().slice(0, 80) || "untitled";

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

// each synth gets a folder named after it ("DSI Mopho"), from the schema's
// name (or an explicit `folder`); backups go in <synth>/backups/
const folders = new Map();
async function backupDir(id) {
  if (!folders.has(id)) {
    let name = id;
    try {
      const d = JSON.parse(await fs.readFile(path.join(HERE, "devices", safe(id) + ".json"), "utf8"));
      name = d.folder || d.name || id;
    } catch {}
    folders.set(id, path.join(LIBRARY, safe(name), "backups"));
  }
  return folders.get(id);
}

async function listDevices() {
  const dir = path.join(HERE, "devices");
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".json") && !f.includes(".layout."));
  const out = [];
  for (const f of files) {
    try {
      const d = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
      out.push({ id: d.id, name: d.name, transport: d.transport });
    } catch (e) { out.push({ id: f.replace(/\.json$/, ""), name: f, error: String(e.message) }); }
  }
  return out;
}

async function listBackups(device) {
  const dir = await backupDir(device);
  let files = [];
  try { files = await fs.readdir(dir); } catch { return []; }
  const out = [];
  for (const f of files.filter((f) => f.endsWith(".json"))) {
    try {
      const j = JSON.parse(await fs.readFile(path.join(dir, f), "utf8"));
      out.push({ file: f.replace(/\.json$/, ".syx"), at: j.at, count: j.slots?.length ?? 0, failed: j.failed ?? 0 });
    } catch {}
  }
  return out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(url.pathname);
  try {
    if (p === "/api/devices") return send(res, 200, await listDevices());

    let m;
    const dirOf = async (id, sub = "") => { const d = path.join(await backupDir(id), sub); await fs.mkdir(d, { recursive: true }); return d; };

    // whole-memory backup: every slot's dump concatenated into one .syx (any
    // sysex tool can send it back) + a .json index of slot names
    if ((m = p.match(/^\/api\/backups\/([^/]+)$/))) {
      if (req.method === "GET") return send(res, 200, { dir: await backupDir(m[1]), backups: await listBackups(m[1]) });
      if (req.method === "PUT") {
        const body = JSON.parse(await readBody(req));
        const dir = await dirOf(m[1]);
        const base = path.join(dir, safe(body.stamp));
        await fs.writeFile(base + ".syx", Buffer.from(body.syx));
        await fs.writeFile(base + ".json", JSON.stringify({ device: m[1], at: body.at, slots: body.slots, failed: body.failed }, null, 2));
        return send(res, 200, { ok: true, file: base + ".syx" });
      }
    }

    // one slot, saved just before "store" overwrites it: backups/slots/
    if ((m = p.match(/^\/api\/backup\/([^/]+)\/([^/]+)$/)) && req.method === "PUT") {
      const body = JSON.parse(await readBody(req));
      const base = path.join(await dirOf(m[1], "slots"), safe(m[2]));
      await fs.writeFile(base + ".json", JSON.stringify({ ...body, backedUpAt: new Date().toISOString() }, null, 2));
      if (body.syx) await fs.writeFile(base + ".syx", Buffer.from(body.syx));
      return send(res, 200, { ok: true, file: base + ".syx" });
    }

    // static — the site's zxx fonts come straight from the repo
    const FONTS = path.join(HERE, "../../fonts");
    const rel = p === "/" ? "index.html" : p.slice(1);
    const file = rel.startsWith("fonts/") ? path.join(FONTS, rel.slice(6)) : path.join(HERE, rel);
    if (!file.startsWith(HERE) && !file.startsWith(FONTS)) return send(res, 403, "no");
    return send(res, 200, await fs.readFile(file), MIME[path.extname(file)] || "application/octet-stream");
  } catch (e) {
    return send(res, e.code === "ENOENT" ? 404 : 500, { error: String(e.message) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`edit → http://127.0.0.1:${PORT}   (open in Chrome — Web MIDI + SysEx)`);
  console.log(`backups → ${LIBRARY}/<synth>/backups`);
});
