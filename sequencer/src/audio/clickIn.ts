// Count-in clicks scheduled ahead of the first scheduler tick. One bar of
// quarter-note pulses at the current bpm; beat 1 accented (higher pitch,
// louder) so the user can hear the "1-2-3-4" anchor. Clicks route through
// mixBus → master → destination so they land in the recorded WAV alongside
// the pattern — the count-in is the DAW alignment cue.
//
// Synth (not sampled) for two reasons: zero load-order dependency, and the
// square-wave transient stays easy to spot in a WAV even after the master
// chain colors it.

import { getAudioContext, getClickBus } from './audioContext';

const CLICK_DURATION_S = 0.05;
const ACCENT_FREQ_HZ = 1500;
const BEAT_FREQ_HZ = 1000;
const ACCENT_GAIN = 0.6;
const BEAT_GAIN = 0.4;
const FLOOR = 0.0001;

function scheduleOneClick(when: number, accent: boolean): void {
  const ctx = getAudioContext();
  const gain = ctx.createGain();
  const peak = accent ? ACCENT_GAIN : BEAT_GAIN;
  gain.gain.setValueAtTime(FLOOR, when);
  gain.gain.exponentialRampToValueAtTime(peak, when + 0.001);
  gain.gain.exponentialRampToValueAtTime(FLOOR, when + CLICK_DURATION_S);

  const osc = ctx.createOscillator();
  osc.type = 'square';
  osc.frequency.value = accent ? ACCENT_FREQ_HZ : BEAT_FREQ_HZ;
  osc.connect(gain);
  gain.connect(getClickBus());

  osc.start(when);
  osc.stop(when + CLICK_DURATION_S + 0.01);
}

// Schedules one bar of count-in clicks starting at `startTime`. Returns the
// AudioContext time at which the pattern should begin (= startTime + 1 bar
// at the given bpm). Caller passes that to `scheduler.start(firstStepTime)`.
export function scheduleClickIn(startTime: number, bpm: number): number {
  const beatDur = 60 / bpm;
  const beatsPerBar = 4;
  for (let i = 0; i < beatsPerBar; i++) {
    scheduleOneClick(startTime + i * beatDur, i === 0);
  }
  return startTime + beatsPerBar * beatDur;
}

// Single metronome click for the web path (same synth voice as the count-in).
// The scheduler calls this on each beat while the metronome is on; `accent`
// marks the bar downbeat. Native path uses `triggerSample` instead (see App).
export function scheduleWebClick(when: number, accent: boolean): void {
  scheduleOneClick(when, accent);
}
