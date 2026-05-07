import { getAudioContext } from './audioContext';

let noiseBuffer: AudioBuffer | null = null;

function getNoiseBuffer(): AudioBuffer {
  if (noiseBuffer) return noiseBuffer;
  const ctx = getAudioContext();
  const len = ctx.sampleRate * 1.0;
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buf;
  return buf;
}

export function synthKick(when: number, velocity: number, out: AudioNode, gate = 1) {
  const ctx = getAudioContext();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const decay = 0.25 * gate;
  osc.frequency.setValueAtTime(150, when);
  osc.frequency.exponentialRampToValueAtTime(40, when + 0.18 * gate);
  gain.gain.setValueAtTime(velocity, when);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + decay);
  osc.connect(gain).connect(out);
  osc.start(when);
  osc.stop(when + decay + 0.05);
}

export function synthSnare(when: number, velocity: number, out: AudioNode, gate = 1) {
  const ctx = getAudioContext();

  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer();
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'highpass';
  noiseFilter.frequency.value = 1500;
  const noiseGain = ctx.createGain();
  const noiseDecay = 0.18 * gate;
  noiseGain.gain.setValueAtTime(velocity * 0.7, when);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, when + noiseDecay);
  noise.connect(noiseFilter).connect(noiseGain).connect(out);
  noise.start(when);
  noise.stop(when + noiseDecay + 0.02);

  const tone = ctx.createOscillator();
  tone.type = 'triangle';
  tone.frequency.setValueAtTime(220, when);
  tone.frequency.exponentialRampToValueAtTime(140, when + 0.06 * gate);
  const toneGain = ctx.createGain();
  const toneDecay = 0.1 * gate;
  toneGain.gain.setValueAtTime(velocity * 0.4, when);
  toneGain.gain.exponentialRampToValueAtTime(0.001, when + toneDecay);
  tone.connect(toneGain).connect(out);
  tone.start(when);
  tone.stop(when + toneDecay + 0.02);
}

export function synthHatC(when: number, velocity: number, out: AudioNode, gate = 1) {
  const ctx = getAudioContext();
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer();
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 7000;
  const gain = ctx.createGain();
  const decay = 0.04 * gate;
  gain.gain.setValueAtTime(velocity * 0.5, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + decay);
  noise.connect(filter).connect(gain).connect(out);
  noise.start(when);
  noise.stop(when + decay + 0.02);
}

export function synthHatO(when: number, velocity: number, out: AudioNode, gate = 1) {
  const ctx = getAudioContext();
  const noise = ctx.createBufferSource();
  noise.buffer = getNoiseBuffer();
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 5500;
  const gain = ctx.createGain();
  const decay = 0.6 * gate;
  gain.gain.setValueAtTime(velocity * 0.6, when);
  gain.gain.exponentialRampToValueAtTime(0.001, when + decay);
  noise.connect(filter).connect(gain).connect(out);
  noise.start(when);
  noise.stop(when + decay + 0.05);
}

export function synthMelodic(
  when: number,
  midi: number,
  velocity: number,
  out: AudioNode,
  gate = 1
) {
  const ctx = getAudioContext();
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  const osc = ctx.createOscillator();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, when);
  const gain = ctx.createGain();
  const decay = 0.4 * gate;
  gain.gain.setValueAtTime(velocity * 0.3, when);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + decay);
  osc.connect(gain).connect(out);
  osc.start(when);
  osc.stop(when + decay + 0.05);
}
