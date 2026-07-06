import { engineNow } from './engineClock';

// All scheduler timestamps (`when`, `nextStepTime`, getAudibleStep*)
// are ENGINE-CLOCK seconds — the JS mirror of the Rust cpal sample
// counter (engineClock.ts) — not AudioContext.currentTime. Consumers
// convert `when` to an absolute target frame for trigger IPC
// (frameAtTime) or to wall-clock ms for MIDI-out (engineTimeToPerfMs).
export type StepCallback = (stepIndex: number, when: number, stepDuration: number) => void;

const LOOKAHEAD_MS = 25;
// Scheduling horizon. 250ms is safe now that trigger deadlines are
// absolute engine frames — under the old relative-delay scheme a longer
// horizon accumulated Web-vs-cpal clock drift across the window, so it
// was pinned at 100ms. The wider horizon buys main-thread stall headroom
// (a busy UI frame no longer risks starving the trigger queue).
const SCHEDULE_AHEAD_S = 0.25;
const HISTORY_S = 1;
// If nextStepTime lands this far past the horizon, the engine clock
// jumped backward under us (stream reopen reset the frame counter) —
// re-anchor instead of stalling until the old timeline catches up.
const CLOCK_RESET_SLACK_S = 5;

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
  // Map keyed by registration name so the second registration under the
  // same name evicts the first. Subscribers in useEffects can pass a stable
  // name and survive HMR cleanly even if React's cleanup is skipped — the
  // re-mount's re-registration replaces the stale callback by key.
  // Anonymous callers get an auto-generated name (still unique, just not
  // HMR-safe).
  private callbacks = new Map<string, StepCallback>();
  private anonCounter = 0;
  private playing = false;
  private scheduled: ScheduledStep[] = [];

  setBpm(bpm: number) {
    this.bpm = bpm;
  }

  onStep(cb: StepCallback): () => void;
  onStep(name: string, cb: StepCallback): () => void;
  onStep(a: string | StepCallback, b?: StepCallback): () => void {
    const name = typeof a === 'string' ? a : `anon:${this.anonCounter++}`;
    const cb = typeof a === 'string' ? b! : a;
    this.callbacks.set(name, cb);
    return () => {
      // Only delete if this exact callback is still registered — avoids
      // a stale cleanup from clobbering a fresher registration under the
      // same name.
      if (this.callbacks.get(name) === cb) {
        this.callbacks.delete(name);
      }
    };
  }

  isPlaying() {
    return this.playing;
  }

  getAudibleStep(): number | null {
    const now = engineNow();
    let audible: number | null = null;
    for (const s of this.scheduled) {
      if (s.when <= now) audible = s.index;
      else break;
    }
    return audible;
  }

  // Like getAudibleStep, but also returns the audible step's exact
  // audioContext start time and the current global-step duration. The recorder
  // uses these to measure how far a live note-on landed off the row grid (to
  // capture "lazy"/pushed feel as per-step microTiming). HISTORY_S of past
  // steps are retained, so the audible step's `when` is still in `scheduled`.
  getAudibleStepTiming(): { index: number; when: number; stepDuration: number } | null {
    const now = engineNow();
    let found: ScheduledStep | null = null;
    for (const s of this.scheduled) {
      if (s.when <= now) found = s;
      else break;
    }
    return found ? { index: found.index, when: found.when, stepDuration: this.stepDuration() } : null;
  }

  // firstStepTime: optional explicit engine-clock time for tick 0. Used by the
  // count-in path to push the first pattern step out one bar after the click
  // cues. Defaults to engineNow() + 50ms (the regular play lookahead).
  start(firstStepTime?: number) {
    if (this.playing) return;
    this.playing = true;
    this.currentStep = 0;
    this.nextStepTime = firstStepTime ?? engineNow() + 0.05;
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
    const now = engineNow();
    // Engine-clock reset recovery (device close/reopen mid-play): the
    // frame counter restarted at 0, so nextStepTime — anchored on the
    // old timeline — sits impossibly far ahead. Re-anchor just past
    // "now" and keep the step index; playback continues on the new
    // stream instead of stalling silently.
    if (this.nextStepTime > now + SCHEDULE_AHEAD_S + CLOCK_RESET_SLACK_S) {
      this.nextStepTime = now + 0.05;
      this.scheduled = [];
    }
    while (this.nextStepTime < now + SCHEDULE_AHEAD_S) {
      const dur = this.stepDuration();
      for (const cb of this.callbacks.values()) cb(this.currentStep, this.nextStepTime, dur);
      this.scheduled.push({ index: this.currentStep, when: this.nextStepTime });
      this.nextStepTime += dur;
      this.currentStep += 1;
    }
    const cutoff = now - HISTORY_S;
    while (this.scheduled.length && this.scheduled[0].when < cutoff) {
      this.scheduled.shift();
    }
    this.timerId = window.setTimeout(this.tick, LOOKAHEAD_MS);
  };
}

export const scheduler = new Scheduler();

// Dev: the scheduler singleton is captured by App.tsx's boot effect and the
// step subscribers at mount — HMR can't hot-swap it in the running loop (the
// old instance's setTimeout chain keeps ticking). Force a full reload on
// change, matching engine/tick.ts and voices.ts. No-op in production.
if (import.meta.hot) import.meta.hot.accept(() => window.location.reload());
