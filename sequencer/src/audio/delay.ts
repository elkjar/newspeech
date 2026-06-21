// Delay params + tempo-sync helpers. The delay ENGINE is native-only (Rust
// `DelayBus` — a ping-pong delay fed by the per-instrument delay send, sibling
// to the reverb aux). There's no web DSP, so this module is just the param
// type, defaults, and the note-division → seconds conversion the App RAF uses
// to push a tempo-synced time to the engine.

// Synced note divisions for the delay Time. Capped at 1/2 so the longest time
// (1/2 @ low BPM) stays inside the engine's 4s buffer. `T` = triplet,
// `.` = dotted.
export type DelayDivision = '1/16' | '1/8T' | '1/8' | '1/8.' | '1/4' | '1/4.' | '1/2';

export const DELAY_DIVISIONS: DelayDivision[] = [
  '1/16',
  '1/8T',
  '1/8',
  '1/8.',
  '1/4',
  '1/4.',
  '1/2',
];

const DIVISION_BEATS: Record<DelayDivision, number> = {
  '1/16': 0.25,
  '1/8T': 1 / 3,
  '1/8': 0.5,
  '1/8.': 0.75,
  '1/4': 1,
  '1/4.': 1.5,
  '1/2': 2,
};

export interface DelayParams {
  timeDivision: DelayDivision;
  // 0..1 in store space; mapped to the engine's 0..1.1 at push time so the top
  // of the knob runs past unity (builds / self-oscillates, per broken-ranges).
  feedback: number;
  // 0..1 feedback routing: 0 = straight stereo (each channel feeds itself),
  // 1 = full cross-feed (repeats bounce L→R→L).
  pingpong: number;
  // 0..1 feedback degradation (sample-rate reduction + bitcrush) — compounds
  // per repeat, so the tail decays into grit.
  lofi: number;
}

export const DEFAULT_DELAY_PARAMS: DelayParams = {
  timeDivision: '1/8',
  feedback: 0.4,
  pingpong: 1,
  lofi: 0,
};

// Store feedback (0..1) → engine feedback (0..1.1).
export const FEEDBACK_TO_ENGINE = 1.1;

// Synced delay time in seconds for the engine: beats-per-division × beat length.
export function delayDivisionToSeconds(division: DelayDivision, bpm: number): number {
  const beats = DIVISION_BEATS[division] ?? 0.5;
  const safeBpm = bpm > 0 ? bpm : 120;
  return beats * (60 / safeBpm);
}
