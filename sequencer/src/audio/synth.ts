import { getAudioContext } from './audioContext';

let noiseBuffer: AudioBuffer | null = null;

function getNoiseBuffer(): AudioBuffer {
  if (noiseBuffer) return noiseBuffer;
  const ctx = getAudioContext();
  const len = ctx.sampleRate * 0.5;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buf;
  return buf;
}

export function synthKick(when: number, velocity: number, out: AudioNode) {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.frequency.setValueAtTime(150, when);
  osc.frequency.exponentialRampToValueAtTime(40, when + 0.18);
  gain.gain.setValueAtTime(velocity, when);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.25);
  osc.connect(gain).connect(out);
  osc.start(when);
  osc.stop(when + 0.3);
}

export function synthSnare(when: number, velocity: number, out: AudioNode) {
  const ctx = getAudioContext();

  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer();
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'highpass';
  noiseFilter.frequency.value = 1500;
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(velocity * 0.7, when);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, when + 0.18);
  noise.connect(noiseFilter).connect(noiseGain).connect(out);
  noise.start(when);
  noise.stop(when + 0.2);

  const tone = ctx.createOscillator();
  tone.type = 'triangle';
  tone.frequency.setValueAtTime(220, when);
  tone.frequency.exponentialRampToValueAtTime(140, when + 0.06);
  const toneGain = ctx.createGain();
  toneGain.gain.setValueAtTime(velocity * 0.4, when);
  toneGain.gain.exponentialRampToValueAtTime(0.001, when + 0.1);
  tone.connect(toneGain).connect(out);
  tone.start(when);
  tone.stop(when + 0.12);
}

export function synthHatC(when: number, velocity: number, out: AudioNode) {
  const ctx = getAudioContext();
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer();
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 7000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(velocity * 0.5, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + 0.04);
  noise.connect(filter).connect(gain).connect(out);
  noise.start(when);
  noise.stop(when + 0.06);
}

export function synthHatO(when: number, velocity: number, out: AudioNode) {
  const ctx = getAudioContext();
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer();
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 6000;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(velocity * 0.45, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + 0.3);
  noise.connect(filter).connect(gain).connect(out);
  noise.start(when);
  noise.stop(when + 0.32);
}

export function synthMelodic(when: number, midi: number, velocity: number, out: AudioNode) {
  const ctx = getAudioContext();
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, when);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(velocity * 0.3, when);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.4);
  osc.connect(gain).connect(out);
  osc.start(when);
  osc.stop(when + 0.45);
}
