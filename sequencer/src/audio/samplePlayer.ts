import { getAudioContext } from './audioContext';

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

  trigger(id: SampleId, when: number, velocity = 1) {
    const ctx = getAudioContext();

    const group = this.chokeGroups.get(id);
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

    const buf = this.buffers.get(id);
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const gain = ctx.createGain();
      gain.gain.value = velocity;
      src.connect(gain).connect(ctx.destination);
      src.start(when);
      this.activeVoices.set(id, src);
      src.onended = () => {
        if (this.activeVoices.get(id) === src) this.activeVoices.delete(id);
      };
    } else {
      this.synthKick(when, velocity);
    }
  }

  private synthKick(when: number, velocity: number) {
    const ctx = getAudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.frequency.setValueAtTime(150, when);
    osc.frequency.exponentialRampToValueAtTime(40, when + 0.18);
    gain.gain.setValueAtTime(velocity, when);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.25);
    osc.connect(gain).connect(ctx.destination);
    osc.start(when);
    osc.stop(when + 0.3);
  }
}

export const samplePlayer = new SamplePlayer();
