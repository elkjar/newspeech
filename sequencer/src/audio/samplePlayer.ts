import { getAudioContext, getMixBus, getSamplesBus, getRhythmBus, getMelodyBus, getTrackBus } from './audioContext';
import type { TrackSection } from '../state/store';
import { getTrackFilter } from './trackFilter';
import { dropChordToneWeighted } from './chords';
import { synthHatC, synthHatO, synthKick, synthMelodic, synthSnare } from './synth';
import {
  isPadVoice,
  voiceEnvelope,
  voiceGain,
  voiceLoop,
  voiceOctaveOffset,
  voicePadConfig,
} from './voices';
import type { PadConfig } from './voices';

// Slice-2 pad pan motion. Per-tone slow LFO sweeps the panner around its
// base (positional-spread) value over the full audible lifetime of the tone.
// Continuous-time phase math (`phase0 + 2π·rate·when`) makes consecutive
// triggers feel like the same free-running oscillator rather than re-seeding
// at every spawn — without it, motion locks to the trigger grid.
const PAD_PAN_SAMPLES_PER_CYCLE = 60;
function schedulePadPanCurve(
  panParam: AudioParam,
  basePan: number,
  rate: number,
  phase0: number,
  depth: number,
  when: number,
  duration: number
): void {
  if (duration <= 0 || rate <= 0) {
    panParam.value = Math.max(-1, Math.min(1, basePan));
    return;
  }
  const phaseAtWhen = phase0 + 2 * Math.PI * rate * when;
  const numSamples = Math.max(64, Math.ceil(duration * rate * PAD_PAN_SAMPLES_PER_CYCLE));
  const curve = new Float32Array(numSamples);
  for (let s = 0; s < numSamples; s++) {
    const tFromStart = (s / (numSamples - 1)) * duration;
    const phase = phaseAtWhen + 2 * Math.PI * rate * tFromStart;
    const target = basePan + depth * Math.sin(phase);
    curve[s] = Math.max(-1, Math.min(1, target));
  }
  panParam.setValueCurveAtTime(curve, when, duration);
}

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
  bufs: AudioBuffer[];
  // Absolute paths parallel to bufs (same length, same order). For user
  // kits these are real filesystem paths the native cpal engine can load
  // directly; for bundled kits they're URLs (storing them anyway keeps
  // bank shape uniform — the native engine simply fails on URL loads
  // until a bytes-decode path lands).
  paths: string[];
}

interface VoiceData {
  banks: SampleBank[];
  rrIndex: Map<number, number>;
  gain: number;
}

interface ActiveChordEntry {
  // Track that triggered this source. Used for monophonic-choke matching —
  // monophonic is a per-TRACK property (set on Track.monophonic) so the same
  // voice can play monophonically as bass and polyphonically as motif when
  // it's assigned to two tracks with different monophonic flags.
  trackId: string | undefined;
  src: AudioBufferSourceNode;
  gain: GainNode;
}

// Soft cap on simultaneous sample-based chord tones. Oldest gets a 20 ms
// release ramp and then stop() — never raw stop() on a sustained sample,
// which produces an audible click.
const MAX_POLYPHONY = 64;
const STEAL_RELEASE = 0.02;

class SamplePlayer {
  private voices = new Map<SampleId, VoiceData>();
  private chokeGroups = new Map<SampleId, string>();
  private activeVoices = new Map<SampleId, AudioBufferSourceNode>();
  private activeChordVoices = new Set<ActiveChordEntry>();

  // Loader for kit WAV files. Bundled samples pass URLs via the
  // url-fetcher (default); user-directory samples in the Tauri build use
  // an invoke-bytes fetcher that reads files via the read_audio_file Rust
  // command (sidesteps the asset-protocol scope dance — same consent model
  // as save_text_file: user picks dir via native dialog, app reads from it).
  async loadManifest(
    baseUrl: string,
    manifest: SampleManifest,
    fetcher: (file: string, baseUrl: string) => Promise<AudioBuffer> = defaultUrlFetcher,
    opts: { pathsOnly?: boolean } = {},
  ) {
    // pathsOnly skips the per-file fetcher entirely (no fetch / no
    // decodeAudioData), populating only paths[]. The Tauri build sets
    // this since every voice trigger goes through the native cpal
    // engine — Web Audio AudioBuffers are wasted work, AND the
    // user-samples fetcher route relays bytes back through invoke as
    // JSON-encoded number arrays (slow per [[reference_tauri_binary_ipc]]).
    // Web triggers will gracefully no-op when bank.bufs.length === 0,
    // so leaving bufs[] empty in this mode is safe.
    const pathsOnly = opts.pathsOnly === true;
    if (manifest.chokeGroups) {
      for (const [id, group] of Object.entries(manifest.chokeGroups)) {
        this.chokeGroups.set(id, group);
      }
    }
    await Promise.all(
      Object.entries(manifest.voices).map(async ([id, def]) => {
        const banks: SampleBank[] = [];
        if (def.files && def.files.length > 0) {
          const paths = def.files.map((file) => `${baseUrl}/${file}`);
          const bufs = pathsOnly
            ? []
            : await Promise.all(def.files.map((file) => fetcher(file, baseUrl)));
          banks.push({ root: null, bufs, paths });
        }
        if (def.roots) {
          for (const r of def.roots) {
            if (!r.files || r.files.length === 0) continue;
            const paths = r.files.map((file) => `${baseUrl}/${file}`);
            const bufs = pathsOnly
              ? []
              : await Promise.all(r.files.map((file) => fetcher(file, baseUrl)));
            banks.push({ root: r.midi, bufs, paths });
          }
        }
        if (banks.length === 0) return;
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
      })
    );
  }

  trigger(
    voice: SampleId,
    when: number,
    velocity = 1,
    midiNote?: number,
    gate = 1,
    stepDuration = 0.125,
    chordIntervals?: number[],
    pan = 0.5,
    trackId?: string,
    monophonic = false,
    section?: TrackSection
  ) {
    const ctx = getAudioContext();
    // Per-trigger `out` is the voice's write target. Routing downstream of
    // `out` lives in two places:
    //   • Per-trigger: optional per-track-pan StereoPanner (snapshot at trigger).
    //   • Per-track persistent (trackFilter.ts): ladder filter + wet/dry split.
    //
    // Wet/dry MOVED out of this function 2026-05-11 along with the ladder
    // filter — keeping them per-trigger but feeding from a persistent
    // filterOut would leak GainNodes (filterOut keeps every per-trigger
    // wet/dry reachable forever). fxSend is now continuously LFO-modulatable
    // via the per-track filter graph; previously snapshot per trigger. The
    // fxSend parameter was dropped from this signature entirely — the store
    // value is the canonical source, read by fxModulation.ts each RAF tick.
    const out = ctx.createGain();
    out.gain.value = 1;
    // Per-track stereo placement. `pan` is 0..1 (0.5 = center) in state space
    // so it composes cleanly with the LFO pipeline; we map to [-1,+1] here.
    // Snapshots at trigger time. Skipped at center so the existing per-tone
    // chord-spread panner is the only spatial node when this row sits centered.
    const clampedPan = Math.max(0, Math.min(1, pan));
    let busHead: AudioNode = out;
    if (clampedPan !== 0.5) {
      const trackPanner = ctx.createStereoPanner();
      trackPanner.pan.value = (clampedPan - 0.5) * 2;
      out.connect(trackPanner);
      busHead = trackPanner;
    }
    // Hand off to the per-track filter graph (created lazily on first call
    // per trackId). The graph owns the ladder worklet + wet/dry split +
    // connections to voicesBus / mixBus. The trigger's only job downstream
    // of busHead is to plug into the right per-track filterIn.
    // Fallback to direct-to-mixBus if no trackId provided (shouldn't happen
    // in normal flow — App.tsx passes track.id at every call site).
    if (trackId) {
      busHead.connect(getTrackFilter(trackId));
    } else {
      busHead.connect(getMixBus());
    }
    // Parallel raw-record tap, sectioned for splits output. busHead has
    // per-trigger gain + per-track pan baked in but no track filter, no FX,
    // no master — "voice as the user tuned it, minus production coloring."
    // rhythmBus / melodyBus feed samplesBus internally, so this single
    // connect populates both the per-section split path and the combined
    // raw-sum path. None of these buses connect to destination — they're
    // recording-only taps.
    if (section === 'drum') busHead.connect(getRhythmBus());
    else if (section === 'melodic') busHead.connect(getMelodyBus());
    else busHead.connect(getSamplesBus());
    // Per-track multitrack tap. Parallel to the section tap above — feeds a
    // per-trackId GainNode that the recorder optionally attaches a dedicated
    // worklet to. Lazy bus creation; idle (no consumer) unless a multitrack
    // take is active.
    if (trackId) busHead.connect(getTrackBus(trackId));

    const group = this.chokeGroups.get(voice);
    if (group) {
      for (const [vid, src] of this.activeVoices) {
        if (this.chokeGroups.get(vid) === group) {
          try {
            src.stop(when);
          } catch {
            /* already stopped */
          }
          this.activeVoices.delete(vid);
        }
      }
    }

    // Monophonic track — stop all previous active sources of THIS track
    // before triggering a new one. Per-track (not per-voice) so the same
    // voice can play monophonically as bass (Track.monophonic=true) and
    // polyphonically as motif/flavor (Track.monophonic=false) when assigned
    // to two different tracks. Soft release via STEAL_RELEASE avoids clicks.
    if (monophonic && trackId !== undefined) {
      const toStop: ActiveChordEntry[] = [];
      for (const entry of this.activeChordVoices) {
        if (entry.trackId === trackId) toStop.push(entry);
      }
      for (const entry of toStop) {
        try {
          const releaseEnd = when + STEAL_RELEASE;
          entry.gain.gain.cancelScheduledValues(when);
          entry.gain.gain.setValueAtTime(entry.gain.gain.value, when);
          entry.gain.gain.linearRampToValueAtTime(0, releaseEnd);
          entry.src.stop(releaseEnd + 0.005);
        } catch {
          /* already stopped */
        }
        this.activeChordVoices.delete(entry);
      }
    }

    // Per-voice natural-register shift. Applied to the caller's requested
    // midiNote before chord-tone expansion + bank lookup. Composes with
    // per-track `octave` (which the caller already folded into midiNote).
    const octaveShift = voiceOctaveOffset(voice) * 12;
    const baseMidi = midiNote !== undefined ? midiNote + octaveShift : undefined;

    let intervals = chordIntervals && chordIntervals.length > 0 ? chordIntervals : [0];
    // Pad-type voices always get a per-tone panner with an LFO sweep, even
    // for single-note triggers. The LFO config is read once per trigger and
    // distributed by tone index (rates + phaseOffsets arrays index mod len).
    const isPad = isPadVoice(voice);
    const padCfg: PadConfig | undefined = isPad ? voicePadConfig(voice) : undefined;
    // Pad-type per-trigger tone dropout. Runs AFTER chord context has been
    // published by App.tsx so followers still see the full chord — only the
    // pad's audible output thins. Weighted toward upper tones (preserves
    // bass anchor). N is recomputed AFTER the drop so chord-gain comp +
    // useJitter reflect the actually-played count.
    if (isPad && padCfg && intervals.length > 1 && Math.random() < padCfg.dropoutChance) {
      intervals = dropChordToneWeighted(intervals, padCfg.dropoutUpperBias);
    }
    const N = intervals.length;
    const useJitter = N > 1;
    // Per-voice gain trim (VoiceDef.gain). Applies to BOTH sample and synth
    // paths and stacks with the sample manifest's data.gain. Used to pull
    // hot voices down so they don't dominate the mix or push master into
    // limiting. Composes with chord-tone gain comp below.
    const voiceGainTrim = voiceGain(voice);
    // Equal-power chord-tone gain compensation. Without this, three sample
    // copies at velocity 1 hit ~3× full-scale and clip before the master bus
    // compressor sees them. 1/√N preserves perceived loudness under partial
    // decorrelation (which the detune + start-time jitter below give us) while
    // taming peaks. Dropped chords (Stage 7 dropChordTone) reduce N → remaining
    // tones get slightly louder per tone, which feels musically right.
    const chordGainComp = useJitter ? 1 / Math.sqrt(N) : 1;
    const data = this.voices.get(voice);
    const hasSamples = !!(data && data.banks.length > 0);

    for (let i = 0; i < N; i++) {
      const interval = intervals[i];
      const targetMidi = baseMidi !== undefined ? baseMidi + interval : undefined;
      const isLast = i === N - 1;

      // Index-based positional stereo spread. Bass tone (i=0) anchors one
      // side, top tone (i=N-1) the other, middle tones distribute between.
      // Symmetric around center; ±0.45 deterministic spread + ±0.05 random
      // jitter keeps it tasteful but obviously spread. Pad-type voices ALWAYS
      // get a panner (even single notes) so the LFO motion stays consistent
      // across mono/chord triggers — base pan defaults to 0 in the N=1 pad
      // case so the LFO sweep is symmetric around center.
      let pan: number | null;
      if (useJitter) {
        pan = (i / (N - 1) - 0.5) * 0.9 + (Math.random() - 0.5) * 0.1;
      } else if (isPad) {
        pan = 0;
      } else {
        pan = null;
      }
      // Per-tone LFO config — looked up by tone index mod array length so
      // pad voices with more than 6 chord tones still tile rates/phases.
      const padLfo = isPad && padCfg && pan !== null
        ? {
            rate: padCfg.panLfoRatesHz[i % padCfg.panLfoRatesHz.length],
            phase0: padCfg.panLfoPhaseOffsetsRad[i % padCfg.panLfoPhaseOffsetsRad.length],
            depth: padCfg.panLfoDepth,
          }
        : null;
      // Per-tone gate stagger — pad voices only. Each chord tone gets its
      // own random gate multiplier in [min, max] so the chord blooms /
      // wilts rather than triggering as a perfect block. Skewed slightly
      // toward >1 by default (0.85..1.15) so the bloom feels like the
      // chord settling in rather than truncating.
      const toneGate = isPad && padCfg
        ? gate * (padCfg.gateStagger.min + Math.random() * (padCfg.gateStagger.max - padCfg.gateStagger.min))
        : gate;
      const toneVelocity = velocity * chordGainComp * voiceGainTrim;

      if (hasSamples && data) {
        const src = this.spawnSampleInstance(
          voice,
          data,
          out,
          when,
          toneVelocity,
          targetMidi,
          toneGate,
          stepDuration,
          useJitter,
          pan,
          padLfo,
          trackId
        );
        if (src && isLast) {
          // last-write-wins choke tracking; kept for parity with prior behavior.
          this.activeVoices.set(voice, src);
        }
      } else {
        // Synth fallback — one call per chord tone. Wrap in a per-tone panner
        // when this is part of a multi-note chord so the synth fallback gets
        // the same stereo spread as the sample path. No per-instance detune
        // jitter because the synth functions are inherently distinct
        // oscillator graphs, not shared looped buffers.
        let synthOut: AudioNode = out;
        if (pan !== null) {
          const panner = ctx.createStereoPanner();
          if (padLfo) {
            // Synth voices don't expose their release tail, so cover a
            // generous window past the gate. Curve outliving the source is
            // harmless — panner gets garbage collected with the source.
            const env = voiceEnvelope(voice);
            const releaseTail = env ? env.release : 1.0;
            const lfoDuration = toneGate * stepDuration + releaseTail + 0.1;
            schedulePadPanCurve(
              panner.pan,
              pan,
              padLfo.rate,
              padLfo.phase0,
              padLfo.depth,
              when,
              lfoDuration
            );
          } else {
            panner.pan.value = pan;
          }
          panner.connect(out);
          synthOut = panner;
        }
        switch (voice) {
          case 'kick':
            synthKick(when, toneVelocity, synthOut, toneGate);
            break;
          case 'snare':
            synthSnare(when, toneVelocity, synthOut, toneGate);
            break;
          case 'hat-c':
            synthHatC(when, toneVelocity, synthOut, toneGate);
            break;
          case 'hat-o':
            synthHatO(when, toneVelocity, synthOut, toneGate);
            break;
          default:
            if (targetMidi !== undefined)
              synthMelodic(when, targetMidi, toneVelocity, synthOut, toneGate, stepDuration);
        }
      }
    }
  }

  private spawnSampleInstance(
    voice: SampleId,
    data: VoiceData,
    out: GainNode,
    when: number,
    velocity: number,
    midiNote: number | undefined,
    gate: number,
    stepDuration: number,
    useJitter: boolean,
    pan: number | null,
    padLfo: { rate: number; phase0: number; depth: number } | null = null,
    trackId: string | undefined = undefined
  ): AudioBufferSourceNode | null {
    const ctx = getAudioContext();

    // Pick bank: nearest-root if midiNote is defined and there's at least one
    // rooted bank, otherwise the first bank (covers flat/drum voices).
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
    if (!bank || bank.bufs.length === 0) return null;
    const idx = data.rrIndex.get(bankIdx) ?? 0;
    const buf = bank.bufs[idx % bank.bufs.length];
    data.rrIndex.set(bankIdx, (idx + 1) % bank.bufs.length);

    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (midiNote !== undefined && bank.root !== null) {
      src.playbackRate.value = Math.pow(2, (midiNote - bank.root) / 12);
    }
    // Per-instance detune jitter — composes with playbackRate via AudioParam.
    // Cents are additive on top of the zone pitch-shift.
    if (useJitter) {
      src.detune.value = (Math.random() * 6) - 3;
    }

    const loop = voiceLoop(voice);
    if (loop) {
      src.loop = true;
      src.loopStart = loop.start;
      src.loopEnd = loop.end;
    }

    const gain = ctx.createGain();
    const peak = velocity * data.gain;
    const env = voiceEnvelope(voice);

    let endTime: number | null = null;
    if (env) {
      // exponentialRamp can't start or land at 0, so floor everything at 1e-4
      const FLOOR = 0.0001;
      const attack = Math.max(0.001, env.attack);
      const decay = env.decay ?? 0;
      const sustain = env.sustain ?? 1;
      const release = Math.max(0.001, env.release);
      const holdDuration = Math.max(0.001, gate * stepDuration);
      const sustainLevel = Math.max(FLOOR, peak * sustain);
      const releaseStart = when + holdDuration;
      const releaseEnd = releaseStart + release;

      gain.gain.setValueAtTime(FLOOR, when);
      if (holdDuration <= attack) {
        // Gate ends mid-attack — ramp partway, then release from there.
        const partial = Math.max(FLOOR, peak * (holdDuration / attack));
        gain.gain.exponentialRampToValueAtTime(partial, releaseStart);
      } else {
        gain.gain.exponentialRampToValueAtTime(Math.max(FLOOR, peak), when + attack);
        const decayEnd = when + attack + decay;
        if (decay > 0 && decayEnd < releaseStart) {
          gain.gain.exponentialRampToValueAtTime(sustainLevel, decayEnd);
          gain.gain.setValueAtTime(sustainLevel, releaseStart);
        } else if (decay > 0) {
          // Gate ends mid-decay — partial ramp toward sustain at releaseStart.
          const decayFrac = Math.min(1, (releaseStart - (when + attack)) / decay);
          const partial = Math.max(FLOOR, peak - (peak - sustainLevel) * decayFrac);
          gain.gain.exponentialRampToValueAtTime(partial, releaseStart);
        } else {
          // No decay phase — flat hold at peak through to releaseStart.
          gain.gain.setValueAtTime(Math.max(FLOOR, peak), releaseStart);
        }
      }
      gain.gain.exponentialRampToValueAtTime(FLOOR, releaseEnd);
      endTime = releaseEnd + 0.05;
    } else {
      gain.gain.value = peak;
    }

    // Per-instance stereo placement. Caller computes `pan` as an index-based
    // positional spread (bass anchors one side, top tone the other) with a
    // small random jitter folded in. Single-note triggers pass `pan = null`
    // and skip the panner entirely (mono-centered, same as pre-spread).
    // Pad voices pass a non-null `pan` AND a `padLfo` config — panner gets a
    // sine-curve sweep around the base scheduled for the full audible window.
    let tail: AudioNode = gain;
    if (pan !== null) {
      const panner = ctx.createStereoPanner();
      if (padLfo) {
        const lfoDuration = endTime !== null
          ? endTime - when
          : gate * stepDuration + 4.0;
        schedulePadPanCurve(
          panner.pan,
          pan,
          padLfo.rate,
          padLfo.phase0,
          padLfo.depth,
          when,
          lfoDuration
        );
      } else {
        panner.pan.value = Math.max(-1, Math.min(1, pan));
      }
      gain.connect(panner);
      tail = panner;
    }

    src.connect(gain);
    tail.connect(out);

    // Per-instance sample-start jitter — decorrelates internal LFOs / chorus
    // across chord-tone instances so loop-points aren't phase-locked.
    const startJitter = useJitter ? (0.005 + Math.random() * 0.01) : 0;
    src.start(when + startJitter);
    if (endTime !== null) {
      src.stop(endTime);
    }

    this.maybeStealOldest(when);
    const entry: ActiveChordEntry = { trackId, src, gain };
    this.activeChordVoices.add(entry);
    src.onended = () => {
      this.activeChordVoices.delete(entry);
      if (this.activeVoices.get(voice) === src) this.activeVoices.delete(voice);
      // Explicit disconnect — WKWebView is less aggressive than V8 about
      // tearing down ended sources, and accumulated source+gain nodes
      // visibly degrade audio quality over long sessions (chunking on the
      // low end, comb-filter phasing from delayed-GC siblings still
      // resident in the graph).
      try { src.disconnect(); } catch { /* already disconnected */ }
      try { gain.disconnect(); } catch { /* already disconnected */ }
    };

    return src;
  }

  // Oldest-first eviction with a soft release ramp. Raw stop() on a sustained
  // Native-engine helpers (Phase 1b) ----------------------------------------
  //
  // pickNativeSample reproduces the bank-selection + round-robin logic from
  // spawnSampleInstance but returns { path, pitch } instead of touching
  // audio nodes. The rrIndex Map is SHARED with the web path so flipping
  // engine mid-pattern doesn't double-advance the counter.
  pickNativeSample(
    voice: SampleId,
    midiNote?: number
  ): { path: string; pitch: number; voiceGain: number } | null {
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
    return { path, pitch, voiceGain: data.gain };
  }

  // Eagerly loads every sample in every bank of a voice into the native
  // engine's registry. Idempotent (the Rust side caches by path). Used by
  // App.tsx whenever a track flips to native or its voice changes while
  // native — without preload, first trigger has invoke + decode latency
  // that produces a perceptible click delay.
  async preloadNativeForVoice(
    voice: SampleId
  ): Promise<{ loaded: number; failed: number }> {
    const data = this.voices.get(voice);
    if (!data) return { loaded: 0, failed: 0 };
    const { isNativeAudioAvailable, loadSample, loadSampleFromBytes } =
      await import('./nativeEngine');
    if (!isNativeAudioAvailable()) return { loaded: 0, failed: 0 };
    const allPaths = new Set<string>();
    for (const bank of data.banks) {
      for (const p of bank.paths) allPaths.add(p);
    }
    // User-sample kits store absolute filesystem paths (`/Users/.../foo.wav`)
    // that hound can open directly. Bundled kits store Vite-served URLs
    // (`/samples/drums/606/foo.wav`) that hound can't reach — fetch the
    // bytes JS-side and hand them to the bytes-load path.
    //
    // Paths run SEQUENTIALLY (not Promise.allSettled). The bytes-load
    // path encodes a Uint8Array as a JSON number array on the IPC wire
    // (see [[reference_tauri_binary_ipc]]) — running many in parallel
    // piles up that synchronous encoding on the main thread and hangs
    // the UI at cold boot. Between each path we yield via setTimeout(0)
    // so React, animations, and user input get a slice of the event
    // loop during what can be a multi-second preload.
    const loadOne = async (path: string) => {
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

  // looped pad sample clicks; the 20 ms linearRamp to zero is below the
  // threshold of perception but kills the click. Insertion order on Set is
  // preserved by spec, so .values().next() is the oldest entry.
  private maybeStealOldest(when: number) {
    while (this.activeChordVoices.size >= MAX_POLYPHONY) {
      const oldest = this.activeChordVoices.values().next().value;
      if (!oldest) break;
      this.activeChordVoices.delete(oldest);
      try {
        const releaseEnd = when + STEAL_RELEASE;
        oldest.gain.gain.cancelScheduledValues(when);
        oldest.gain.gain.setValueAtTime(oldest.gain.gain.value, when);
        oldest.gain.gain.linearRampToValueAtTime(0, releaseEnd);
        oldest.src.stop(releaseEnd + 0.005);
      } catch {
        /* source already stopped */
      }
    }
  }
}

async function fetchAndDecode(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  const arr = await res.arrayBuffer();
  return ctx.decodeAudioData(arr);
}

async function defaultUrlFetcher(file: string, baseUrl: string): Promise<AudioBuffer> {
  return fetchAndDecode(getAudioContext(), `${baseUrl}/${file}`);
}

export const samplePlayer = new SamplePlayer();
