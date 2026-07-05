// User samples directory — the Tauri-only "drop a folder and rescan" path.
// Bundled samples (public/samples/) keep working the same on both web and
// app; this layer adds an extra discovery source on top, scoped to a
// user-chosen filesystem directory.
//
// Tauri-only: web builds never call into this module's scan path (the UI
// gate in SettingsDialog hides the user-samples row when isTauri() is false).
// The localStorage config keys still exist on web so a user moving from
// web to app gets continuity, but the scan command itself fails fast.

import { invoke, isTauri } from '@tauri-apps/api/core';
import { getAudioContext } from '../audio/audioContext';
import { samplePlayer } from '../audio/samplePlayer';
import {
  clearKits,
  registerKit,
  withNamespacedVoiceIds,
  type ExtendedSampleManifest,
} from './manifestRegistry';

const LS_USER_SAMPLES_DIR = 'newspeech.sequencer.userSamplesDir';

export function getConfiguredUserSamplesDir(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const v = localStorage.getItem(LS_USER_SAMPLES_DIR);
  return v && v.trim() ? v : null;
}

export function setConfiguredUserSamplesDir(dir: string | null): void {
  if (typeof localStorage === 'undefined') return;
  if (dir && dir.trim()) localStorage.setItem(LS_USER_SAMPLES_DIR, dir);
  else localStorage.removeItem(LS_USER_SAMPLES_DIR);
}

interface RustSampleKitEntry {
  kit_path: string;
  category: 'drum' | 'melodic';
  manifest_json: string;
  absolute_dir: string;
}

interface UserKitScanResult {
  loaded: number;
  skipped: number;
  failed: number;
  errors: string[];
}

// Resolves the active user samples directory: explicit localStorage value
// if set, else the default `~/Documents/Sequence/samples`. Returns null on
// non-Tauri runtimes.
export async function resolveUserSamplesDir(): Promise<string | null> {
  if (!isTauri()) return null;
  const configured = getConfiguredUserSamplesDir();
  if (configured) return configured;
  try {
    return await invoke<string>('get_user_samples_dir');
  } catch (err) {
    console.warn('[userSamplesDir] get_user_samples_dir failed:', err);
    return null;
  }
}

// Scans the active user samples dir and registers any found kits into the
// manifestRegistry + samplePlayer. Idempotent: re-registering an existing
// kit-path replaces the entry. Bundled kits are not touched.
//
// WAV files are loaded via the `read_audio_file` Rust command (bytes →
// decodeAudioData) rather than fetched as URLs — keeps the asset-protocol
// scope simple (none needed) and matches the consent model of the
// projectfs save/read commands (user picked the dir = user granted access).
export async function scanAndLoadUserSamples(): Promise<UserKitScanResult> {
  const result: UserKitScanResult = { loaded: 0, skipped: 0, failed: 0, errors: [] };
  if (!isTauri()) {
    result.skipped = 1;
    return result;
  }
  const dir = await resolveUserSamplesDir();
  if (!dir) {
    result.skipped = 1;
    return result;
  }
  let kits: RustSampleKitEntry[];
  try {
    kits = await invoke<RustSampleKitEntry[]>('list_sample_kits', { dir });
  } catch (err) {
    result.failed = 1;
    result.errors.push(`list_sample_kits: ${String(err)}`);
    return result;
  }
  for (const kit of kits) {
    let manifest: ExtendedSampleManifest;
    try {
      manifest = JSON.parse(kit.manifest_json) as ExtendedSampleManifest;
    } catch (err) {
      result.failed += 1;
      result.errors.push(`${kit.kit_path}: parse manifest: ${String(err)}`);
      continue;
    }
    const absDir = kit.absolute_dir;
    const fetcher = async (file: string): Promise<AudioBuffer> => {
      const bytes = await invoke<number[]>('read_audio_file', {
        path: `${absDir}/${file}`,
      });
      const buf = new Uint8Array(bytes).buffer;
      return getAudioContext().decodeAudioData(buf);
    };
    try {
      // baseUrl is purely cosmetic when the fetcher ignores it; pass the
      // absolute dir for log readability if anything goes wrong downstream.
      // Voice IDs get kit-scoped here so user-kit "kick" doesn't collide
      // with bundled blck_noir's "kick" (or any other user kit's "kick").
      // Same namespaced manifest goes to BOTH the registry and the player
      // — they must agree on the keys.
      const namespacedKitPath = `user/${kit.kit_path}`;
      const namespaced = withNamespacedVoiceIds(namespacedKitPath, manifest);
      registerKit(namespacedKitPath, absDir, namespaced);
      // In Tauri, native is the only audio path — skip the Web Audio
      // AudioBuffer decode pass. Path strings + voice metadata are
      // all the native engine needs; the fetcher relays bytes back
      // through invoke as a JSON number array, which is the
      // dominant cost of cold-boot user-samples loading. Native
      // preload reads files directly via hound::WavReader::open on
      // the absolute filesystem path (see [[reference_tauri_binary_ipc]]).
      const nativeMode = isTauri();
      await samplePlayer.loadManifest(absDir, namespaced, fetcher, {
        pathsOnly: nativeMode,
      });
      result.loaded += 1;
    } catch (err) {
      result.failed += 1;
      result.errors.push(`${kit.kit_path}: load: ${String(err)}`);
    }
  }
  return result;
}

// Full rescan — clears the registry and reloads every kit from the samples
// dir from scratch. The correct call when kits may have been removed:
// clear-and-reload is the only way the registry forgets a kit that's no
// longer present on disk. Used by the Settings rescan button and the
// SampleLibraryPane's rescan flow.
export async function rescanAllKits(): Promise<UserKitScanResult> {
  // The samples directory is the single source of truth — clear the registry
  // and reload every kit from disk. Clear-and-reload (rather than an additive
  // scan) is how the registry forgets a kit that's no longer present.
  clearKits();
  return scanAndLoadUserSamples();
}
