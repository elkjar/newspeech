import { modulated } from './lfo';
import { useSequencerStore } from '../state/store';
import {
  voiceTune,
  voiceFinetune,
  voiceGainOverride,
  voiceTrim,
  voiceFilter,
  voiceFilterLfo,
  voiceSaturation,
  voiceBitDepth,
  voiceMods,
  voiceGranular,
  type ModSpec,
} from '../instruments/voiceEditsStore';

export type SampleId = string;

// A multisampled voice declares one bank per captured root note. A drum-style
// flat voice declares a single `files` array with no root (pitch-shift skipped).
export interface SampleVoiceDef {
  files?: string[];
  roots?: Array<{ midi: number; files: string[] }>;
  gain?: number;
}

export interface SampleManifest {
  name: string;
  voices: Record<SampleId, SampleVoiceDef>;
  chokeGroups?: Record<SampleId, string>;
}

interface SampleBank {
  root: number | null;
  // Absolute filesystem paths the native cpal engine loads directly
  // (hound::WavReader::open on first trigger / preload).
  paths: string[];
}

interface VoiceData {
  banks: SampleBank[];
  rrIndex: Map<number, number>;
  gain: number;
}

// The voice registry for the native cpal engine. Interns sample paths +
// voice metadata from kit manifests; every trigger goes through
// `pickNativeSample` → `triggerSample` (nativeEngine.ts) → Rust.
class SamplePlayer {
  private voices = new Map<SampleId, VoiceData>();
  private chokeGroups = new Map<SampleId, string>();

  // Interns path strings + voice metadata for a kit manifest. No fetch, no
  // decode — the cpal engine reads each file directly when the voice is
  // first triggered (or eagerly via preloadNativeForVoice).
  async loadManifest(baseUrl: string, manifest: SampleManifest) {
    if (manifest.chokeGroups) {
      for (const [id, group] of Object.entries(manifest.chokeGroups)) {
        this.chokeGroups.set(id, group);
      }
    }
    for (const [id, def] of Object.entries(manifest.voices)) {
      const banks: SampleBank[] = [];
      if (def.files && def.files.length > 0) {
        banks.push({
          root: null,
          paths: def.files.map((file) => `${baseUrl}/${file}`),
        });
      }
      if (def.roots) {
        for (const r of def.roots) {
          if (!r.files || r.files.length === 0) continue;
          banks.push({
            root: r.midi,
            paths: r.files.map((file) => `${baseUrl}/${file}`),
          });
        }
      }
      if (banks.length === 0) continue;
      // sort banks by root for deterministic nearest-root lookup; null roots first
      banks.sort((a, b) => {
        if (a.root === null) return -1;
        if (b.root === null) return 1;
        return a.root - b.root;
      });
      this.voices.set(id, {
        banks,
        rrIndex: new Map(),
        gain: def.gain ?? 1,
      });
    }
  }

  // Nearest-root bank selection + per-bank round-robin, returning
  // { path, pitch, ... } for the native trigger instead of touching
  // audio nodes.
  pickNativeSample(
    voice: SampleId,
    midiNote?: number,
    trackId?: string
  ): {
    path: string;
    pitch: number;
    voiceGain: number;
    // Manifest choke-group name (hats etc.), forwarded to the native
    // trigger so the cpal engine can choke matching voices across tracks.
    chokeGroup: string | null;
    start: number;
    end: number;
    loop: number;
    filterType: number;
    cutoff: number;
    resonance: number;
    satDrive: number;
    bitDepth: number;
    lfoShape: number;
    lfoRateHz: number;
    lfoDepth: number;
    mods: ModSpec[];
    granular: {
      on: boolean;
      grainMs: number;
      position: number;
      shape: number;
      direction: number;
      spray: number;
    };
  } | null {
    const data = this.voices.get(voice);
    if (!data || data.banks.length === 0) return null;
    let bankIdx = 0;
    if (midiNote !== undefined) {
      let bestDiff = Infinity;
      for (let i = 0; i < data.banks.length; i++) {
        const root = data.banks[i].root;
        if (root === null) continue;
        const diff = Math.abs(midiNote - root);
        if (diff < bestDiff) {
          bestDiff = diff;
          bankIdx = i;
        }
      }
    }
    const bank = data.banks[bankIdx];
    if (!bank || bank.paths.length === 0) return null;
    const idx = data.rrIndex.get(bankIdx) ?? 0;
    const path = bank.paths[idx % bank.paths.length];
    data.rrIndex.set(bankIdx, (idx + 1) % bank.paths.length);
    let pitch = 1.0;
    if (midiNote !== undefined && bank.root !== null) {
      pitch = Math.pow(2, (midiNote - bank.root) / 12);
    }
    // Per-voice instrument edits (global, app-only) fold in here — the single
    // chokepoint every native trigger flows through (playback dispatch in
    // App.tsx + preview in monitor.ts). tune shifts pitch uniformly (works for
    // melodic + drums); gain override multiplies the manifest gain.
    // tune = coarse semitones, finetune = cents (sub-semitone pitch trim); both
    // fold into one uniform pitch multiply (works for melodic + drums).
    const semis = voiceTune(voice) + voiceFinetune(voice) / 100;
    if (semis !== 0) pitch *= Math.pow(2, semis / 12);
    // Sample window + loop (A3). start/end as 0..1 fractions, loop as the
    // native loop_mode code; defaults (0/1/off) leave playback unchanged.
    const trim = voiceTrim(voice);
    // Per-instrument filter (B1). type 0 = off (engine bypasses).
    const filter = voiceFilter(voice);
    // Cutoff LFO (B2). depth 0 = off.
    const lfo = voiceFilterLfo(voice);
    // Granular (Phase C). on=false (default) leaves normal sample playback.
    const granular = voiceGranular(voice);
    // App-LFO drift of grain position + length (per-note): when granular is on
    // and a routing track is known, sample the global LFO at trigger time so the
    // grain start/size drift across notes. modulated() is a no-op fast path when
    // nothing is routed (free otherwise). Grain length rides in 0..1 over the
    // [1,1000]ms range for the LFO, then maps back. Held notes don't sweep
    // mid-note — that's the continuous-engine follow-up.
    if (granular.on && trackId) {
      const lfos = useSequencerStore.getState().lfos;
      granular.position = modulated(granular.position, lfos, trackId, 'grainPosition');
      const lenNorm = (granular.grainMs - 1) / 999;
      granular.grainMs = 1 + modulated(lenNorm, lfos, trackId, 'grainLength') * 999;
    }
    return {
      path,
      pitch,
      voiceGain: data.gain * voiceGainOverride(voice),
      chokeGroup: this.chokeGroups.get(voice) ?? null,
      start: trim.start,
      end: trim.end,
      loop: trim.loop,
      filterType: filter.type,
      cutoff: filter.cutoff,
      resonance: filter.resonance,
      satDrive: voiceSaturation(voice),
      bitDepth: voiceBitDepth(voice),
      lfoShape: lfo.shape,
      lfoRateHz: lfo.rateHz,
      lfoDepth: lfo.depth,
      mods: voiceMods(voice),
      granular,
    };
  }

  // Eagerly loads every sample in every bank of a voice into the native
  // engine's registry. Idempotent (the Rust side caches by path). Used by
  // App.tsx whenever a track's voice changes — without preload, first
  // trigger has invoke + decode latency that produces a perceptible click
  // delay.
  async preloadNativeForVoice(
    voice: SampleId
  ): Promise<{ loaded: number; failed: number }> {
    const data = this.voices.get(voice);
    if (!data) return { loaded: 0, failed: 0 };
    const { loadSample, loadSampleFromBytes, loadBundledSample } = await import(
      './nativeEngine'
    );
    const allPaths = new Set<string>();
    for (const bank of data.banks) {
      for (const p of bank.paths) allPaths.add(p);
    }
    // Three path shapes hit different loaders:
    //   • `/samples/...` (bundled kit URL) → `loadBundledSample` resolves
    //     it Rust-side to a real fs path and `hound` opens it directly.
    //     No fetch, no IPC bytes — the fast cold-boot path.
    //   • `/Users/.../foo.wav` (user-samples dir) → `loadSample` opens
    //     the absolute fs path directly (also fast).
    //   • Anything else → fall back to `fetch` + `loadSampleFromBytes`.
    //     This is the slow JSON-array-IPC path, retained as a universal
    //     fallback for paths that don't resolve to a real file location.
    //
    // Paths run SEQUENTIALLY with a setTimeout(0) yield between each so
    // React, animations, and user input keep getting event-loop slices
    // during a multi-second preload of user kits.
    const loadOne = async (path: string) => {
      if (path.startsWith('/samples/')) {
        try {
          await loadBundledSample(path);
          return;
        } catch {
          // resource_dir resolution miss (e.g. dev path tree changed) —
          // fall through to fetch path so the load doesn't fail entirely.
        }
      }
      try {
        await loadSample(path);
      } catch {
        const res = await fetch(path);
        if (!res.ok) throw new Error(`fetch ${path}: ${res.status}`);
        const buf = await res.arrayBuffer();
        await loadSampleFromBytes(path, new Uint8Array(buf));
      }
    };
    const yieldTick = () => new Promise<void>((r) => setTimeout(r, 0));
    let loaded = 0;
    let failed = 0;
    for (const path of allPaths) {
      try {
        await loadOne(path);
        loaded++;
      } catch {
        failed++;
      }
      await yieldTick();
    }
    return { loaded, failed };
  }
}

export const samplePlayer = new SamplePlayer();
