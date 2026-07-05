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
