// POST /api/subscribe — the one door for both the homepage mailing-list box
// and the plugin download gates. Body (JSON or urlencoded):
//   email       required
//   source      "homepage" | "plugins"
//   plugin      vibe | saturate | slice | glitch   (plugins source only)
//   version     build the visitor is downloading, e.g. "1.0.0"
//   bot-field   honeypot — any value → pretend success, store nothing
// Replaces the Netlify Forms capture (100 submissions/month cap) with Resend
// contacts + segments; see ../lib/resend.mjs for the data model.

import { client, normalizeEmail, PLUGINS, SOURCES } from "../lib/resend.mjs";

export const config = { path: "/api/subscribe" };

const ALLOWED_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*(newspeechsound\.com|netlify\.app)$/i;

const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

let resend = null;

export default async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "post only" });

  // same-site only when a browser tells us where it came from; curl has no Origin
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGIN.test(origin) && !/^http:\/\/localhost(:\d+)?$/.test(origin)) {
    return json(403, { ok: false, error: "origin" });
  }

  let fields = {};
  try {
    const type = req.headers.get("content-type") || "";
    if (type.includes("application/json")) fields = await req.json();
    else fields = Object.fromEntries(new URLSearchParams(await req.text()));
  } catch (_) {
    return json(400, { ok: false, error: "unreadable body" });
  }

  if (fields["bot-field"]) return json(200, { ok: true }); // honeypot

  const email = normalizeEmail(fields.email);
  if (!email) return json(400, { ok: false, error: "email" });
  const source = SOURCES.includes(fields.source) ? fields.source : fields.plugin ? "plugins" : "homepage";
  const plugin = fields.plugin ? String(fields.plugin).toLowerCase() : undefined;
  if (plugin && !PLUGINS.includes(plugin)) return json(400, { ok: false, error: "plugin" });
  const version = fields.version ? String(fields.version).slice(0, 32) : undefined;

  if (!process.env.RESEND_API_KEY) {
    console.error("subscribe: RESEND_API_KEY missing");
    return json(503, { ok: false, error: "not configured" });
  }
  resend ||= client(process.env.RESEND_API_KEY);

  try {
    const r = await resend.subscribe({ email, source, plugin, version });
    console.log(`subscribe: ${r.created ? "new" : "known"} ${source}${plugin ? " " + plugin : ""}`);
    return json(200, { ok: true });
  } catch (e) {
    console.error("subscribe:", e.message);
    return json(502, { ok: false, error: "upstream" });
  }
};
