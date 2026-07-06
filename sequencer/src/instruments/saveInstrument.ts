// Save the in-app instrument editor's edits into the global sample library.
//
// The library is the source of truth: a voice's saved params live in its user
// kit's on-disk manifest.json (`ManifestVoiceMeta.edits`), and the editor's
// `voiceEditsStore` is just the UNSAVED working layer overlaid on top (see
// resolvedVoiceEdit). Nothing is written into `.seq` files — edits are global.
//
//  - Save (inline): flush the resolved params into the voice's manifest entry,
//    then clear the working override → the instrument is permanently updated
//    everywhere it's used.
//  - Save As: add a NEW voice to the kit's manifest (new id + name, same sample
//    files, params baked) → a variation off the same multisample; the original
//    is untouched.
//
// Tauri-only (user kits live on a writable filesystem dir). The Rust scanner
// reads manifest.json verbatim when present (samples.rs), so the `edits` field
// round-trips; we re-scan at save time to get the authoritative BARE-id
// manifest (registry ids are namespaced `<prefix>-<bareId>`).

import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  namespacePrefix,
  getRegisteredKits,
  type ExtendedSampleManifest,
} from './manifestRegistry';
import { resolvedVoiceEdit, useVoiceEditsStore } from './voiceEditsStore';
import { rescanAllKits, resolveUserSamplesDir } from './userSamplesDir';

interface RustSampleKitEntry {
  kit_path: string;
  category: 'drum' | 'melodic';
  manifest_json: string;
  absolute_dir: string;
}

interface VoiceLocation {
  kitPath: string; // bare kit path, e.g. "instruments/foo"
  absoluteDir: string;
  bareId: string; // voice key as it lives in the on-disk manifest
  manifest: ExtendedSampleManifest;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 48);
}

// Can this voice be saved? True for any voice that belongs to a sample kit
// (kits live on the writable samples dir; synth/MIDI voices have no manifest).
// Synchronous — reads the in-memory registry, enough to gate the editor's
// Save buttons.
export function voiceIsSaveable(voiceId: string): boolean {
  if (!isTauri()) return false;
  return getRegisteredKits().some((k) => k.manifest.voices[voiceId] !== undefined);
}

// Re-scan the raw kits and find which user kit + bare voice id a (namespaced)
// registry voiceId maps to. Rust is the authority for the bare-id manifest.
async function locateVoice(voiceId: string): Promise<VoiceLocation | null> {
  if (!isTauri()) return null;
  const dir = await resolveUserSamplesDir();
  if (!dir) return null;
  const kits = await invoke<RustSampleKitEntry[]>('list_sample_kits', { dir });
  for (const kit of kits) {
    let manifest: ExtendedSampleManifest;
    try {
      manifest = JSON.parse(kit.manifest_json) as ExtendedSampleManifest;
    } catch {
      continue;
    }
    const prefix = namespacePrefix(`user/${kit.kit_path}`);
    for (const bareId of Object.keys(manifest.voices ?? {})) {
      if (`${prefix}-${bareId}` === voiceId) {
        return { kitPath: kit.kit_path, absoluteDir: kit.absolute_dir, bareId, manifest };
      }
    }
  }
  return null;
}

async function writeKitManifest(
  absoluteDir: string,
  manifest: ExtendedSampleManifest,
): Promise<void> {
  await invoke('save_text_file', {
    path: `${absoluteDir}/manifest.json`,
    contents: JSON.stringify(manifest, null, 2),
  });
}

export interface SaveResult {
  ok: boolean;
  error?: string;
  newVoiceId?: string; // Save As only — the namespaced id of the new fork
}

// Save (inline): bake the resolved params into the voice's manifest entry,
// persist, rescan, and clear the working override. The instrument is now
// permanently the edited version everywhere it's referenced.
export async function saveVoiceInline(voiceId: string): Promise<SaveResult> {
  try {
    const loc = await locateVoice(voiceId);
    if (!loc) return { ok: false, error: 'voice is not in an editable (user) kit' };
    const params = resolvedVoiceEdit(voiceId) ?? {};
    const voice = loc.manifest.voices[loc.bareId];
    loc.manifest.voices[loc.bareId] = { ...voice, edits: params };
    await writeKitManifest(loc.absoluteDir, loc.manifest);
    await rescanAllKits();
    useVoiceEditsStore.getState().resetVoiceEdit(voiceId);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface SaveAllResult {
  saved: number;
  // Voices with working edits that live in no editable kit (synth/MIDI voices,
  // stale ids from renamed kits). Left in the working layer untouched — a
  // reset would silently discard the only copy of those edits.
  skipped: string[];
  errors: string[];
}

// Bulk companion to saveVoiceInline — bake EVERY unsaved instrument edit into
// its kit manifest in one pass. Used by the "unsaved instruments" gate on song
// save and the header badge. Kits are scanned once and each dirty manifest is
// written once (a kit with several dirty voices gets one write), with a single
// registry rescan at the end — not N× the inline flow.
export async function saveAllVoiceEdits(): Promise<SaveAllResult> {
  const out: SaveAllResult = { saved: 0, skipped: [], errors: [] };
  if (!isTauri()) return out;
  const ids = Object.keys(useVoiceEditsStore.getState().voiceEdits);
  if (ids.length === 0) return out;
  try {
    const dir = await resolveUserSamplesDir();
    if (!dir) {
      out.skipped = ids;
      return out;
    }
    const kits = await invoke<RustSampleKitEntry[]>('list_sample_kits', { dir });
    interface KitGroup {
      absoluteDir: string;
      manifest: ExtendedSampleManifest;
      entries: Array<{ voiceId: string; bareId: string }>;
    }
    const parsed: Array<{ kitPath: string; absoluteDir: string; manifest: ExtendedSampleManifest }> = [];
    for (const kit of kits) {
      try {
        parsed.push({
          kitPath: kit.kit_path,
          absoluteDir: kit.absolute_dir,
          manifest: JSON.parse(kit.manifest_json) as ExtendedSampleManifest,
        });
      } catch {
        /* unparseable manifest — its voices land in `skipped` below */
      }
    }
    const byKit = new Map<string, KitGroup>();
    for (const voiceId of ids) {
      let found = false;
      for (const kit of parsed) {
        const prefix = namespacePrefix(`user/${kit.kitPath}`);
        for (const bareId of Object.keys(kit.manifest.voices ?? {})) {
          if (`${prefix}-${bareId}` === voiceId) {
            let group = byKit.get(kit.kitPath);
            if (!group) {
              group = { absoluteDir: kit.absoluteDir, manifest: kit.manifest, entries: [] };
              byKit.set(kit.kitPath, group);
            }
            group.entries.push({ voiceId, bareId });
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found) out.skipped.push(voiceId);
    }
    for (const group of byKit.values()) {
      // Bake BEFORE reset — resolvedVoiceEdit merges the working layer over
      // the saved base, same semantics as the inline save.
      for (const e of group.entries) {
        const voice = group.manifest.voices[e.bareId];
        group.manifest.voices[e.bareId] = { ...voice, edits: resolvedVoiceEdit(e.voiceId) ?? {} };
      }
      try {
        await writeKitManifest(group.absoluteDir, group.manifest);
        for (const e of group.entries) {
          useVoiceEditsStore.getState().resetVoiceEdit(e.voiceId);
          out.saved += 1;
        }
      } catch (err) {
        out.errors.push(
          `${group.absoluteDir}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    if (out.saved > 0) await rescanAllKits();
  } catch (err) {
    out.errors.push(err instanceof Error ? err.message : String(err));
  }
  return out;
}

// Save As: fork a NEW voice in the same kit (new id + name, same sample files,
// current params baked in) — a variation off the same multisample. The original
// keeps its saved state untouched; the working override is cleared off the
// original (the dialed-in params now live on the fork). Returns the fork's
// namespaced registry id so the caller can repoint the focused track to it.
export async function saveVoiceAs(voiceId: string, name: string): Promise<SaveResult> {
  try {
    const loc = await locateVoice(voiceId);
    if (!loc) return { ok: false, error: 'voice is not in an editable (user) kit' };
    const label = name.trim() || 'variation';
    const base = slugify(label) || 'variation';
    let newBareId = base;
    let n = 2;
    while (loc.manifest.voices[newBareId]) newBareId = `${base}-${n++}`;
    const src = loc.manifest.voices[loc.bareId];
    // Clone the source voice (same files/roots/gain/etc.), give it the new name
    // + the dialed-in params. JSON clone keeps it free of shared references.
    const fork = JSON.parse(JSON.stringify(src)) as typeof src;
    fork.label = label;
    fork.edits = resolvedVoiceEdit(voiceId) ?? {};
    loc.manifest.voices[newBareId] = fork;
    await writeKitManifest(loc.absoluteDir, loc.manifest);
    await rescanAllKits();
    useVoiceEditsStore.getState().resetVoiceEdit(voiceId);
    const prefix = namespacePrefix(`user/${loc.kitPath}`);
    return { ok: true, newVoiceId: `${prefix}-${newBareId}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
