import { getAudioContext } from './audioContext';

export type StepCallback = (stepIndex: number, when: number, stepDuration: number) => void;

const LOOKAHEAD_MS = 25;
const SCHEDULE_AHEAD_S = 0.1;
const HISTORY_S = 1;

interface ScheduledStep {
  index: number;
  when: number;
}

class Scheduler {
  private timerId: number | null = null;
  private nextStepTime = 0;
  private currentStep = 0;
  private bpm = 120;
  // 32nd-note resolution. Per-row rate selects how many ticks make up one row step
  // (see RATE_STRIDE in store.ts). 1/16 rows advance every other tick.
  private stepsPerBeat = 8;
  private callbacks: StepCallback[] = [];
  private playing = false;
  private scheduled: ScheduledStep[] = [];

  setBpm(bpm: number) {
    this.bpm = bpm;
  }

  onStep(cb: StepCallback) {
    this.callbacks.push(cb);
    return () => {
      this.callbacks = this.callbacks.filter((c) => c !== cb);
    };
  }

  isPlaying() {
    return this.playing;
  }

  getAudibleStep(): number | null {
    const now = getAudioContext().currentTime;
    let audible: number | null = null;
    for (const s of this.scheduled) {
      if (s.when <= now) audible = s.index;
      else break;
    }
    return audible;
  }

  start() {
    if (this.playing) return;
    const ctx = getAudioContext();
    this.playing = true;
    this.currentStep = 0;
    this.nextStepTime = ctx.currentTime + 0.05;
    this.scheduled = [];
    this.tick();
  }

  stop() {
    this.playing = false;
    if (this.timerId !== null) {
      clearTimeout(this.timerId);
      this.timerId = null;
    }
    this.currentStep = 0;
    this.scheduled = [];
  }

  private stepDuration(): number {
    return 60 / this.bpm / this.stepsPerBeat;
  }

  private tick = () => {
    if (!this.playing) return;
    const ctx = getAudioContext();
    while (this.nextStepTime < ctx.currentTime + SCHEDULE_AHEAD_S) {
      const dur = this.stepDuration();
      for (const cb of this.callbacks) cb(this.currentStep, this.nextStepTime, dur);
      this.scheduled.push({ index: this.currentStep, when: this.nextStepTime });
      this.nextStepTime += dur;
      this.currentStep += 1;
    }
    const cutoff = ctx.currentTime - HISTORY_S;
    while (this.scheduled.length && this.scheduled[0].when < cutoff) {
      this.scheduled.shift();
    }
    this.timerId = window.setTimeout(this.tick, LOOKAHEAD_MS);
  };
}

export const scheduler = new Scheduler();
