// Resend contact capture for newspeechsound.com — shared by the subscribe
// function and tools/import-subscribers.mjs.
//
// Model (Resend, 2026): contacts are global per team; SEGMENTS are static
// groups a contact is added to (broadcasts address one segment); PROPERTIES
// are typed key/values on the contact and must exist before they're set.
//
//   segments   General            everyone who ever signed up anywhere (Resend's
//                                 default segment — names match case-insensitively)
//              Plugins            took at least one plugin
//              plugin-<name>      took that plugin — USED IF PRESENT, never created:
//                                 the free plan allows 3 segments, so these get
//                                 made by hand (dashboard or API) after upgrading,
//                                 then backfilled from the <plugin> property
//   properties source             first touch: "homepage" | "plugins"
//              <plugin>           version string of the build they downloaded
//
// Segments + properties are created on demand and cached for the life of the
// function instance, so the only config is RESEND_API_KEY.

const API = "https://api.resend.com";
export const PLUGINS = ["vibe", "saturate", "slice", "glitch"];
export const SOURCES = ["homepage", "plugins"];

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
export function normalizeEmail(raw) {
  const e = String(raw || "").trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

export class ResendError extends Error {
  constructor(status, body, path) {
    super(`resend ${status} ${path}: ${body?.message || body?.name || JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

export function client(key) {
  if (!key) throw new Error("RESEND_API_KEY is not set");
  const req = async (method, path, body) => {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (_) {}
    if (!res.ok) throw new ResendError(res.status, json, path);
    return json;
  };

  // name → id caches; populated lazily, created if missing
  let segments = null;
  let properties = null;

  // optional segments are looked up but never created (plan segment cap)
  const ensureSegment = async (name, optional = false) => {
    const k = name.toLowerCase();
    if (!segments) {
      const list = await req("GET", "/segments");
      segments = new Map((list.data || []).map((s) => [s.name.toLowerCase(), s.id]));
    }
    if (!segments.has(k)) {
      if (optional) return null;
      const made = await req("POST", "/segments", { name });
      segments.set(k, made.id);
    }
    return segments.get(k);
  };

  const ensureProperty = async (key) => {
    if (!properties) {
      const list = await req("GET", "/contact-properties");
      properties = new Set((list.data || []).map((p) => p.key));
    }
    if (!properties.has(key)) {
      await req("POST", "/contact-properties", { key, type: "string" });
      properties.add(key);
    }
  };

  const getContact = async (email) => {
    try {
      return await req("GET", `/contacts/${encodeURIComponent(email)}`);
    } catch (e) {
      if (e.status === 404) return null;
      throw e;
    }
  };

  // Upsert one contact and file it into its segments. `plugin`/`version` are
  // optional (homepage subscribe passes neither).
  const subscribe = async ({ email, source, plugin, version }) => {
    if (!normalizeEmail(email)) throw new Error("bad email");
    if (!SOURCES.includes(source)) throw new Error("bad source");
    if (plugin && !PLUGINS.includes(plugin)) throw new Error("bad plugin");

    const props = {};
    if (plugin) props[plugin] = String(version || "1");
    await ensureProperty("source");
    for (const k of Object.keys(props)) await ensureProperty(k);

    const existing = await getContact(email);
    let created = false;
    if (!existing) {
      await req("POST", "/contacts", { email, properties: { source, ...props } });
      created = true;
    } else if (Object.keys(props).length) {
      // merge over what's there so a PATCH can't drop another plugin's key
      const merged = {};
      for (const [k, v] of Object.entries(existing.properties || {})) {
        if (v && v.value !== undefined && v.value !== null) merged[k] = v.value;
      }
      Object.assign(merged, props);
      await req("PATCH", `/contacts/${encodeURIComponent(email)}`, { properties: merged });
    }

    const wanted = [["General", false]];
    if (plugin) wanted.push(["Plugins", false], [`plugin-${plugin}`, true]);
    const filed = [];
    for (const [name, optional] of wanted) {
      const id = await ensureSegment(name, optional);
      if (!id) continue;
      filed.push(name);
      try {
        await req("POST", `/contacts/${encodeURIComponent(email)}/segments/${id}`);
      } catch (e) {
        // already a member reads back as a 4xx — not a failure for us
        if (e.status >= 500) throw e;
      }
    }
    return { created, segments: filed, properties: props };
  };

  return { req, subscribe, getContact, ensureSegment, ensureProperty };
}
