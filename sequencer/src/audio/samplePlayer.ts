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
  voiceWavetable,
  voiceSlices,
  type ModSpec,
} from '../instruments/voiceEditsStore';
import { scaleDegreeOf, snapToScale } from './scale';

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
    // Slice mode: the index of the slice this note selected (for the editor
    // waveform's live "which slice is firing" highlight). null when not slicing.
    sliceIndex: number | null;
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
    wavetable: {
      on: boolean;
      windowFrames: number;
      position: number;
      morph: boolean;
      smooth: boolean; // engine bakes + reads a smoothed table copy
      hz: number; // played note's fundamental (single-cycle osc pitch)
    };
  } | null {
    const data = this.voices.get(voice);
    if (!data || data.banks.length === 0) return null;
    // Slice mode (playmode 'slice' + authored slices): the played NOTE selects a
    // slice window of ONE sample rather than repitching. Both the nearest-root
    // bank selection and the note→pitch derivation are bypassed — every note
    // reads bank 0 at pitch 1 (tune/finetune still apply as static offsets), and
    // the trigger window is overridden with the mapped slice's span below.
    // (S1 limit: a multisample voice reads only bank 0 in slice mode; slice
    // targets are overwhelmingly single-sample breaks.)
    const slices = voiceSlices(voice);
    const sliceMode = slices.length > 0 && midiNote !== undefined;
    let bankIdx = 0;
    if (!sliceMode && midiNote !== undefined) {
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
    if (!sliceMode && midiNote !== undefined && bank.root !== null) {
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
    let start = trim.start;
    let end = trim.end;
    let loop = trim.loop;
    let sliceIndex: number | null = null;
    if (sliceMode) {
      // Map the note to a slice by its SCALE-DEGREE above the scene tonic (not
      // chromatic distance), so consecutive scale steps walk slices one-by-one
      // and EVERY slice is reachable from a scale-quantized pattern (Chris,
      // 2026-07-11). The tonic → slice 0; each degree up → the next slice,
      // wrapping mod numSlices. Off-scale notes snap to the nearest scale tone
      // first (chromatic scale → degree == semitone, so it degrades to the old
      // chromatic behavior for un-quantized voices). Slice i spans
      // [slices[i], slices[i+1] ?? trim.end); one-shot (loop off).
      const n = slices.length;
      const st = useSequencerStore.getState();
      const note = Math.round(midiNote!);
      const deg =
        scaleDegreeOf(note, st.rootNote, st.scale) ??
        scaleDegreeOf(snapToScale(note, st.rootNote, st.scale), st.rootNote, st.scale) ??
        0;
      const i = ((deg % n) + n) % n;
      sliceIndex = i;
      start = slices[i];
      end = i + 1 < n ? slices[i + 1] : trim.end;
      loop = 0;
    }
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
    // Wavetable (Phase D). on=false leaves normal sample playback. The played
    // note sets the oscillator pitch (single-cycle osc) — a fundamental in Hz,
    // window-size-independent. No note (drum-row trigger) → fall back to the
    // scene root so a wavetable voice still sounds on the rhythm side.
    const wt = voiceWavetable(voice);
    const wtNote = midiNote ?? useSequencerStore.getState().rootNote;
    // NOTE: the global app-LFO on wtPosition is applied CONTINUOUSLY in the
    // engine (TrackWtPosition dest → per-track wt_pos_mod, added to the voice's
    // scan every frame), NOT sampled per-note here — so it sweeps the window
    // through a held note like an oscillator. We send the static base position;
    // the engine folds in the LFO + the per-instrument wtPos automation.
    const wavetable = {
      on: wt.on,
      windowFrames: wt.windowSize,
      position: wt.position,
      morph: wt.morph,
      smooth: wt.smooth,
      hz: 440 * Math.pow(2, (wtNote - 69) / 12),
    };
    return {
      path,
      pitch,
      voiceGain: data.gain * voiceGainOverride(voice),
      chokeGroup: this.chokeGroups.get(voice) ?? null,
      start,
      end,
      loop,
      sliceIndex,
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
      wavetable,
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
