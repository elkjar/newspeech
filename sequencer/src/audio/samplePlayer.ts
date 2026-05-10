import { getAudioContext, getVoicesBus } from './audioContext';
import { synthBass, synthHatC, synthHatO, synthKick, synthMelodic, synthPad, synthSnare } from './synth';

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

class SamplePlayer {
  private voices = new Map<SampleId, VoiceData>();
  private chokeGroups = new Map<SampleId, string>();
  private activeVoices = new Map<SampleId, AudioBufferSourceNode>();

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
    fxSend = 1
  ) {
    const ctx = getAudioContext();
    // Per-trigger split — `out` is what the voice writes into; it fans into
    // a wet leg (→ FX bus) and a dry leg (→ destination, bypassing FX).
    // fxSend snapshots at trigger time; LFO modulation steps per trigger.
    const out = ctx.createGain();
    out.gain.value = 1;
    const clampedSend = Math.max(0, Math.min(1, fxSend));
    if (clampedSend > 0) {
      const wet = ctx.createGain();
      wet.gain.value = clampedSend;
      out.connect(wet);
      wet.connect(getVoicesBus());
    }
    if (clampedSend < 1) {
      const dry = ctx.createGain();
      dry.gain.value = 1 - clampedSend;
      out.connect(dry);
      dry.connect(ctx.destination);
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

    const data = this.voices.get(voice);
    if (data && data.banks.length > 0) {
      // pick the bank: nearest-root if midiNote is defined and there's at least
      // one rooted bank, otherwise the first bank (covers flat/drum voices).
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
      const idx = data.rrIndex.get(bankIdx) ?? 0;
      const buf = bank.bufs[idx % bank.bufs.length];
      data.rrIndex.set(bankIdx, (idx + 1) % bank.bufs.length);

      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (midiNote !== undefined && bank.root !== null) {
        src.playbackRate.value = Math.pow(2, (midiNote - bank.root) / 12);
      }
      const gain = ctx.createGain();
      gain.gain.value = velocity * data.gain;
      src.connect(gain).connect(out);
      src.start(when);
      this.activeVoices.set(voice, src);
      src.onended = () => {
        if (this.activeVoices.get(voice) === src) this.activeVoices.delete(voice);
      };
      return;
    }

    switch (voice) {
      case 'kick':
        synthKick(when, velocity, out, gate);
        break;
      case 'snare':
        synthSnare(when, velocity, out, gate);
        break;
      case 'hat-c':
        synthHatC(when, velocity, out, gate);
        break;
      case 'hat-o':
        synthHatO(when, velocity, out, gate);
        break;
      case 'pad':
        if (midiNote !== undefined)
          synthPad(when, midiNote, velocity, out, gate, stepDuration);
        break;
      case 'bass':
        if (midiNote !== undefined)
          synthBass(when, midiNote, velocity, out, gate, stepDuration);
        break;
      default:
        if (midiNote !== undefined)
          synthMelodic(when, midiNote, velocity, out, gate, stepDuration);
    }
  }
}

async function fetchAndDecode(ctx: AudioContext, url: string): Promise<AudioBuffer> {
  const res = await fetch(url);
  const arr = await res.arrayBuffer();
  return ctx.decodeAudioData(arr);
}

export const samplePlayer = new SamplePlayer();
