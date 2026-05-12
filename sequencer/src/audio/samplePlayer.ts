import { getAudioContext, getVoicesBus, getMixBus } from './audioContext';
import { synthBass, synthHatC, synthHatO, synthKick, synthMelodic, synthSnare } from './synth';
import { voiceEnvelope, voiceGain, voiceLoop } from './voices';

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
}

interface VoiceData {
  banks: SampleBank[];
  rrIndex: Map<number, number>;
  gain: number;
}

interface ActiveChordEntry {
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

  async loadManifest(baseUrl: string, manifest: SampleManifest) {
    const ctx = getAudioContext();
    if (manifest.chokeGroups) {
      for (const [id, group] of Object.entries(manifest.chokeGroups)) {
        this.chokeGroups.set(id, group);
      }
    }
    await Promise.all(
      Object.entries(manifest.voices).map(async ([id, def]) => {
        const banks: SampleBank[] = [];
        if (def.files && def.files.length > 0) {
          const bufs = await Promise.all(
            def.files.map((file) => fetchAndDecode(ctx, `${baseUrl}/${file}`))
          );
          banks.push({ root: null, bufs });
        }
        if (def.roots) {
          for (const r of def.roots) {
            if (!r.files || r.files.length === 0) continue;
            const bufs = await Promise.all(
              r.files.map((file) => fetchAndDecode(ctx, `${baseUrl}/${file}`))
            );
            banks.push({ root: r.midi, bufs });
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
    fxSend = 1,
    chordIntervals?: number[],
    pan = 0.5
  ) {
    const ctx = getAudioContext();
    // Per-trigger split — `out` is what the voice writes into; it fans into
    // a wet leg (→ FX bus, hits pre-sat / tape / glitch / reverb / master)
    // and a dry leg (→ mixBus, bypasses pre-sat / tape / glitch / reverb but
    // STILL hits master). Master is master-of-everything by design.
    // fxSend snapshots at trigger time; LFO modulation steps per trigger.
    // Shared across every chord tone in this trigger — they all see the
    // same send level by design.
    const out = ctx.createGain();
    out.gain.value = 1;
    // Per-track stereo placement. `pan` is 0..1 (0.5 = center) in state space
    // so it composes cleanly with the LFO pipeline; we map to [-1,+1] here.
    // Snapshots at trigger time, same convention as fxSend. Skipped at center
    // so the existing per-tone chord-spread panner is the only spatial node
    // when this row sits centered.
    const clampedPan = Math.max(0, Math.min(1, pan));
    let busHead: AudioNode = out;
    if (clampedPan !== 0.5) {
      const trackPanner = ctx.createStereoPanner();
      trackPanner.pan.value = (clampedPan - 0.5) * 2;
      out.connect(trackPanner);
      busHead = trackPanner;
    }
    const clampedSend = Math.max(0, Math.min(1, fxSend));
    if (clampedSend > 0) {
      const wet = ctx.createGain();
      wet.gain.value = clampedSend;
      busHead.connect(wet);
      wet.connect(getVoicesBus());
    }
    if (clampedSend < 1) {
      const dry = ctx.createGain();
      dry.gain.value = 1 - clampedSend;
      busHead.connect(dry);
      dry.connect(getMixBus());
    }

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

    const intervals = chordIntervals && chordIntervals.length > 0 ? chordIntervals : [0];
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
      const targetMidi = midiNote !== undefined ? midiNote + interval : undefined;
      const isLast = i === N - 1;

      // Index-based positional stereo spread. Bass tone (i=0) anchors one
      // side, top tone (i=N-1) the other, middle tones distribute between.
      // Symmetric around center; ±0.45 deterministic spread + ±0.05 random
      // jitter keeps it tasteful but obviously spread (no panned-hard-left).
      // Single-note triggers (N=1) bypass the panner entirely (mono-centered).
      const pan = useJitter
        ? (i / (N - 1) - 0.5) * 0.9 + (Math.random() - 0.5) * 0.1
        : null;
      const toneVelocity = velocity * chordGainComp * voiceGainTrim;

      if (hasSamples && data) {
        const src = this.spawnSampleInstance(
          voice,
          data,
          out,
          when,
          toneVelocity,
          targetMidi,
          gate,
          stepDuration,
          useJitter,
          pan
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
          panner.pan.value = pan;
          panner.connect(out);
          synthOut = panner;
        }
        switch (voice) {
          case 'kick':
            synthKick(when, toneVelocity, synthOut, gate);
            break;
          case 'snare':
            synthSnare(when, toneVelocity, synthOut, gate);
            break;
          case 'hat-c':
            synthHatC(when, toneVelocity, synthOut, gate);
            break;
          case 'hat-o':
            synthHatO(when, toneVelocity, synthOut, gate);
            break;
          case 'bass':
            if (targetMidi !== undefined)
              synthBass(when, targetMidi, toneVelocity, synthOut, gate, stepDuration);
            break;
          default:
            if (targetMidi !== undefined)
              synthMelodic(when, targetMidi, toneVelocity, synthOut, gate, stepDuration);
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
    pan: number | null
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
    let tail: AudioNode = gain;
    if (pan !== null) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, pan));
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
    const entry: ActiveChordEntry = { src, gain };
    this.activeChordVoices.add(entry);
    src.onended = () => {
      this.activeChordVoices.delete(entry);
      if (this.activeVoices.get(voice) === src) this.activeVoices.delete(voice);
    };

    return src;
  }

  // Oldest-first eviction with a soft release ramp. Raw stop() on a sustained
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

export const samplePlayer = new SamplePlayer();
