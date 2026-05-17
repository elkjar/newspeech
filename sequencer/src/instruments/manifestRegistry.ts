// manifestRegistry — single source of truth for "which sample voices exist."
//
// Sample manifests under public/samples/ (and, in Tauri, an arbitrary user
// samples directory) declare voices with all the metadata that used to live
// as hardcoded VoiceDef entries: label, envelope, mutation profile, pad
// markers, per-voice gain and octave offset, track-level mix defaults. This
// module loads those manifests at runtime and derives a VoiceDef[] from them,
// replacing the three previously hardcoded lists (App.tsx kit paths +
// voices.ts VOICES entries for sample voices + hydrate.ts INTERNAL_VOICE_IDS).
//
// Static (non-sample) voices — currently just `bass`, which routes to the
// internal synthBass fallback in samplePlayer — stay declared in voices.ts
// and merge into the final VOICES export.

import type { SampleVoiceDef, SampleManifest } from '../audio/samplePlayer';
import type {
  VoiceCategory,
  VoiceDef,
  VoiceEnvelope,
  VoiceLoop,
  VoiceTrackDefaults,
  VoiceType,
  PadConfig,
  MutationProfile,
} from '../audio/voices';
import {
  DEFAULT_MUTATION,
  DRUM_MUTATION,
  KICK_MUTATION,
  HAT_O_MUTATION,
  PAD_MUTATION,
  DEFAULT_PAD_CONFIG,
} from '../audio/voices';

// Named mutation profiles selectable from manifest JSON. Wrapped in a
// function rather than a top-level object to avoid TDZ errors under the
// voices.ts ⇄ manifestRegistry circular import — the constants here would
// otherwise be read at module-init time, before voices.ts has finished
// evaluating its own exports.
function resolveMutationProfile(name: string | undefined): MutationProfile | undefined {
  switch (name) {
    case 'default': return DEFAULT_MUTATION;
    case 'drum':    return DRUM_MUTATION;
    case 'kick':    return KICK_MUTATION;
    case 'hat-o':   return HAT_O_MUTATION;
    case 'pad':     return PAD_MUTATION;
    default:        return undefined;
  }
}

// Per-voice metadata layered on top of SampleVoiceDef. The audio graph
// (samplePlayer) only consumes `files`/`roots`/`gain` from SampleVoiceDef;
// everything below is registry-only metadata. Storing both shapes in one
// JSON object means a single manifest parse satisfies both consumers — the
// samplePlayer reads the bank fields it cares about and ignores the rest.
export interface ManifestVoiceMeta {
  label?: string;
  category?: VoiceCategory;        // optional override; default = inferred from parent folder
  envelope?: VoiceEnvelope;
  loop?: VoiceLoop;
  octaveOffset?: number;
  // Names a mutation profile (see resolveMutationProfile). Absent = default.
  mutationProfile?: string;
  type?: VoiceType;                // 'pad' opts into pad dispatch
  padConfig?: PadConfig;           // optional override; type='pad' without this falls back to DEFAULT_PAD_CONFIG
  trackDefaults?: VoiceTrackDefaults;
  // Picker categories the voice should appear in (`instruments` / `pads`
  // / `bass` / `textures`). Absent = single category inferred from the
  // parent folder + the flat-voice rule. Set this to surface a voice in
  // more than one category — e.g. a mono synth that's usable as both a
  // melodic lead and a bass voice.
  pickerCategories?: string[];
}

export type ManifestVoice = SampleVoiceDef & ManifestVoiceMeta;

export interface ExtendedSampleManifest extends SampleManifest {
  voices: Record<string, ManifestVoice>;
}

// What samples/index.json (web build) and Tauri runtime scans return.
export interface SampleKitEntry {
  kitPath: string;                 // relative path under sample root, e.g. "instruments/mini-moog"
  category: VoiceCategory;         // inferred from kit path's parent folder
}

export interface RegisteredKit {
  kitPath: string;
  baseUrl: string;                 // resolved URL the samplePlayer used to load files
  category: VoiceCategory;
  manifest: ExtendedSampleManifest;
  // Where the kit came from. Bundled kits live under public/samples/ and
  // ship with the app; user kits come from the user samples directory and
  // are registered with kit paths prefixed `user/` (see userSamplesDir.ts).
  source: 'bundled' | 'user';
}

const kits = new Map<string, RegisteredKit>();
const listeners = new Set<() => void>();
// Cached snapshot array. `useSyncExternalStore` requires getSnapshot() to
// return a stable reference between calls when data hasn't changed — without
// caching, `Array.from(kits.values())` would tear off a new array on every
// render and infinite-loop the consumer hook. Invalidated whenever
// registerKit / clearKits mutates the underlying Map.
let kitsSnapshot: readonly RegisteredKit[] | null = null;

function notifyListeners(): void {
  kitsSnapshot = null;
  for (const listener of listeners) listener();
}

function inferCategoryFromKitPath(kitPath: string): VoiceCategory {
  // Kit paths: "drums/<name>" (bundled) or "user/drums/<name>" (user dir).
  // Strip the optional `user/` prefix, then check the leading segment.
  // Drums are drums; everything else (instruments, pads, future categories)
  // is melodic. Pad-specific dispatch is keyed off VoiceDef.type === 'pad',
  // not category.
  const trimmed = kitPath.startsWith('user/') ? kitPath.slice('user/'.length) : kitPath;
  return trimmed.startsWith('drums/') ? 'drum' : 'melodic';
}

export function registerKit(
  kitPath: string,
  baseUrl: string,
  manifest: ExtendedSampleManifest,
): void {
  const category = inferCategoryFromKitPath(kitPath);
  const source: 'bundled' | 'user' = kitPath.startsWith('user/') ? 'user' : 'bundled';
  kits.set(kitPath, { kitPath, baseUrl, category, manifest, source });
  notifyListeners();
}

export function clearKits(): void {
  kits.clear();
  notifyListeners();
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getRegisteredKits(): readonly RegisteredKit[] {
  if (kitsSnapshot === null) {
    kitsSnapshot = Array.from(kits.values());
  }
  return kitsSnapshot;
}

// Builds VoiceDef[] from all registered manifests. Called by voices.ts so the
// VOICES export reflects whatever's currently loaded. Re-runs on every read
// (cheap — total voices ~40), so adding a kit at runtime is immediately
// visible without explicit invalidation.
export function deriveSampleVoices(): VoiceDef[] {
  const out: VoiceDef[] = [];
  for (const kit of kits.values()) {
    for (const [voiceId, voice] of Object.entries(kit.manifest.voices)) {
      const meta = voice as ManifestVoice;
      const category: VoiceCategory = meta.category ?? kit.category;
      const def: VoiceDef = {
        id: voiceId,
        label: meta.label ?? voiceId,
        category,
      };
      if (meta.type) def.type = meta.type;
      const mp = resolveMutationProfile(meta.mutationProfile);
      if (mp) {
        def.mutationProfile = mp;
      } else if (meta.type === 'pad') {
        def.mutationProfile = PAD_MUTATION;
      }
      if (meta.envelope) def.envelope = meta.envelope;
      if (meta.loop) def.loop = meta.loop;
      if (meta.octaveOffset !== undefined) def.octaveOffset = meta.octaveOffset;
      if (meta.trackDefaults) def.trackDefaults = meta.trackDefaults;
      if (meta.type === 'pad') {
        def.padConfig = meta.padConfig ?? DEFAULT_PAD_CONFIG;
      }
      out.push(def);
    }
  }
  return out;
}

// Voice IDs known to the registry. Used by hydrate.ts to validate `.seq`
// references — replaces the previously hardcoded INTERNAL_VOICE_IDS set
// (which fell out of sync; the ns1-* drums were never added to it).
export function registeredVoiceIds(): Set<string> {
  const out = new Set<string>();
  for (const kit of kits.values()) {
    for (const voiceId of Object.keys(kit.manifest.voices)) {
      out.add(voiceId);
    }
  }
  return out;
}
