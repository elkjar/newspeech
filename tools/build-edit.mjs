#!/usr/bin/env node
// edit (tools/rack) on the site: the page, its modules and device files go to
// _site/edit/, and devices.json stands in for server.mjs's /api/devices.
// server.mjs itself stays local — it's what writes backups into Dropbox.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "tools/rack");
const OUT = path.join(ROOT, "_site/edit");

fs.mkdirSync(OUT, { recursive: true });
for (const f of fs.readdirSync(SRC)) {
  if (f.endsWith(".html") || f.endsWith(".js")) fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
}
fs.cpSync(path.join(SRC, "devices"), path.join(OUT, "devices"), { recursive: true });

// same shape as server.mjs listDevices(); a file that doesn't parse is left out
const devices = [];
for (const f of fs.readdirSync(path.join(SRC, "devices")).sort()) {
  if (!f.endsWith(".json") || f.includes(".layout.")) continue;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(SRC, "devices", f), "utf8"));
    devices.push({ id: d.id, name: d.name, transport: d.transport });
  } catch (e) { console.warn(`edit: skipping ${f} — ${e.message}`); }
}
fs.writeFileSync(path.join(OUT, "devices.json"), JSON.stringify(devices));
console.log(`edit: ${devices.length} devices → _site/edit/`);
