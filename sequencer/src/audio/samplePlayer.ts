import { getAudioContext } from './audioContext';
import { synthHatC, synthHatO, synthKick, synthMelodic, synthSnare } from './synth';

export type SampleId = string;

export interface SampleManifest {
  name: string;
  files: Record<SampleId, string>;
  chokeGroups?: Record<SampleId, string>;
}

class SamplePlayer {
  private buffers = new Map<SampleId, AudioBuffer>();
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
      Object.entries(manifest.files).map(async ([id, file]) => {
        const res = await fetch(`${baseUrl}/${file}`);
        const arr = await res.arrayBuffer();
        const buf = await ctx.decodeAudioData(arr);
        this.buffers.set(id, buf);
      })
    );
  }

  trigger(voice: SampleId, when: number, velocity = 1, midiNote?: number, gate = 1) {
    const ctx = getAudioContext();
    const out = ctx.destination;

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

    const buf = this.buffers.get(voice);
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = velocity;
      if (midiNote !== undefined) {
        src.playbackRate.value = Math.pow(2, (midiNote - 60) / 12);
      }
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
      default:
        if (midiNote !== undefined) synthMelodic(when, midiNote, velocity, out, gate);
    }
  }
}

export const samplePlayer = new SamplePlayer();
