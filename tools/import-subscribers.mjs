#!/usr/bin/env node
// One-off: move the signups captured by Netlify Forms (homepage "subscribe" +
// plugins "plugin-download") into Resend, through the same upsert the live
// function uses. Pulls straight from Netlify via the CLI — the repo must be
// linked (`netlify link`) — so no email dump lands on disk.
//
//   RESEND_API_KEY=$(netlify env:get RESEND_API_KEY) node tools/import-subscribers.mjs [--dry]
//
// Oldest first, so a contact's `source` property reflects their first touch.

import { execFileSync } from "node:child_process";
import { client, normalizeEmail } from "../netlify/lib/resend.mjs";

const dry = process.argv.includes("--dry");
const SITE = "0b286903-b2a8-4004-a178-a8238ff165a5";
const VERSION_AT_CAPTURE = "1.0.0"; // every plugin was v1.0.0 while Netlify Forms was the store

const api = (cmd, data) =>
  JSON.parse(execFileSync("netlify", ["api", cmd, "--data", JSON.stringify(data)], { encoding: "utf8" }));

const forms = api("listSiteForms", { site_id: SITE });
const rows = [];
for (const f of forms) {
  if (!["subscribe", "plugin-download"].includes(f.name)) continue;
  for (const s of api("listFormSubmissions", { form_id: f.id })) {
    const email = normalizeEmail(s.data?.email || s.email);
    if (!email) continue;
    rows.push({
      at: s.created_at,
      email,
      source: f.name === "subscribe" ? "homepage" : "plugins",
      plugin: f.name === "subscribe" ? undefined : s.data?.plugin,
      version: f.name === "subscribe" ? undefined : VERSION_AT_CAPTURE,
    });
  }
}
rows.sort((a, b) => a.at.localeCompare(b.at));
console.log(`${rows.length} submissions across ${forms.length} forms${dry ? " (dry run)" : ""}`);

const resend = dry ? null : client(process.env.RESEND_API_KEY);
for (const r of rows) {
  const label = `${r.at.slice(0, 10)} ${r.email} ${r.source}${r.plugin ? " " + r.plugin : ""}`;
  if (dry) { console.log("  would import", label); continue; }
  try {
    const out = await resend.subscribe(r);
    console.log(`  ${out.created ? "new  " : "known"} ${label}`);
  } catch (e) {
    console.error(`  FAIL  ${label}: ${e.message}`);
  }
  await new Promise((res) => setTimeout(res, 600)); // Resend allows 2 req/s; each import is several calls
}
