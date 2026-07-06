// Engine clock — the JS mirror of the Rust cpal sample counter.
//
// Rust owns the master timebase: `ENGINE_FRAMES` (audio.rs) counts frames
// rendered since the stream opened, advanced once per audio callback. This
// module tracks it with an extrapolator: each `audio:time` event (~30Hz)
// anchors (frames, performance.now()) and `now()` extrapolates between
// events at the device sample rate. Everything scheduled against the audio
// timeline — the lookahead scheduler, trigger target frames, glitch fires,
// MIDI-out send times, record quantization — reads THIS clock, so JS
// scheduling and Rust dispatch share one absolute reference and fire times
// don't smear with IPC/block-boundary latency.
//
// Correction policy (the subtle part): a late-delivered event measures the
// counter LOW relative to the extrapolation — chasing it would walk the
// clock backwards and a scheduler comparing `nextStepTime < now` could
// double-fire. So backward corrections are slewed hard (they're almost
// always delivery jitter, not real drift), forward corrections track
// quickly, and `framesNow()` additionally clamps monotonic. A large
// backward jump is different — that's the counter resetting on a stream
// (re)open — and re-seeds the anchor outright.

import { invoke, isTauri } from '@tauri-apps/api/core';

const DEFAULT_SR = 48_000;

let sr = DEFAULT_SR;
let anchorFrames = 0;
let anchorPerfMs = performance.now();
let seeded = false;
let lastReturnedFrames = 0;
let generation = 0;

// Fraction of the measured error applied per event. Forward (we're
// behind) corrections chase fast; backward corrections are treated as
// event-delivery jitter and bleed in slowly.
const CORRECT_FORWARD = 0.5;
const CORRECT_BACKWARD = 0.05;
// A backward jump bigger than this (seconds worth of frames) is a stream
// reopen, not jitter — re-seed instead of slewing.
const RESET_JUMP_S = 1.0;

function predictedFramesAt(perfMs: number): number {
  return anchorFrames + ((perfMs - anchorPerfMs) * sr) / 1000;
}

// Feed one (frames, sampleRate) measurement from Rust. Called by the
// audio:time listener and the boot-time poll.
export function feedEngineTime(frames: number, sampleRate: number): void {
  const nowMs = performance.now();
  if (sampleRate > 0) sr = sampleRate;
  if (!seeded) {
    anchorFrames = frames;
    anchorPerfMs = nowMs;
    seeded = true;
    lastReturnedFrames = frames;
    generation += 1;
    return;
  }
  const predicted = predictedFramesAt(nowMs);
  const err = frames - predicted;
  if (err < -RESET_JUMP_S * sr) {
    // Counter reset (device close/reopen). The old timeline is gone —
    // jump the clock explicitly and release the monotonic clamp.
    anchorFrames = frames;
    anchorPerfMs = nowMs;
    lastReturnedFrames = frames;
    generation += 1;
    return;
  }
  const alpha = err >= 0 ? CORRECT_FORWARD : CORRECT_BACKWARD;
  anchorFrames = predicted + err * alpha;
  anchorPerfMs = nowMs;
}

// Absolute engine frame "now" (extrapolated, monotonic within a stream
// generation). Before the first audio:time event this free-runs from 0 at
// the default sample rate — schedulable, just not device-aligned yet.
export function framesNow(): number {
  const f = predictedFramesAt(performance.now());
  if (f > lastReturnedFrames) lastReturnedFrames = f;
  return lastReturnedFrames;
}

// Engine time in seconds — the drop-in replacement for
// AudioContext.currentTime in everything that schedules audio.
export function engineNow(): number {
  return framesNow() / sr;
}

export function engineSampleRate(): number {
  return sr;
}

// Engine-seconds → absolute target frame for trigger/glitch IPC.
export function frameAtTime(engineSecs: number): number {
  return Math.max(0, Math.round(engineSecs * sr));
}

// Engine-seconds → performance.now() milliseconds, for consumers that
// schedule against the wall clock (MIDI-out setTimeout sends). Uses the
// extrapolator's own anchor so the conversion is exact w.r.t. engineNow().
export function engineTimeToPerfMs(engineSecs: number): number {
  return anchorPerfMs + ((engineSecs * sr - anchorFrames) / sr) * 1000;
}

// Bumps when the underlying stream (re)opens and the frame counter
// resets. Consumers holding absolute times across the reset can use this
// to invalidate them.
export function engineClockGeneration(): number {
  return generation;
}

let started = false;

// Subscribe to the ~30Hz audio:time events + take one immediate poll so
// the clock is device-aligned before the first scheduled note. Idempotent;
// call once at app boot (alongside initNativeAudio).
export async function initEngineClock(): Promise<void> {
  if (started || !isTauri()) return;
  started = true;
  try {
    const t = await invoke<{ frames: number; sampleRate: number }>('audio_engine_time');
    feedEngineTime(t.frames, t.sampleRate);
  } catch {
    // Device not open yet — the event stream seeds us once it is.
  }
  const { listen } = await import('@tauri-apps/api/event');
  await listen<{ frames: number; sampleRate: number }>('audio:time', (e) => {
    feedEngineTime(e.payload.frames, e.payload.sampleRate);
  });
}
