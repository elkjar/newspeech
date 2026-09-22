// The pool clip changes on bank commits (Pool.tsx). Two cases leave it
// sitting on one 8-second loop for too long:
//   - a record: transport stopped, Ghost idle, nothing commits a bank — ten
//     minutes on a drone (Chris, 2026-09-21);
//   - a song whose bank timings are very long (Chris, 2026-09-22: "it feels
//     like it gets stuck on a single loop visual").
// This clock is the maximum hold. It re-arms from every actual clip change
// (the pool's `visual` stream event), so it only fires when nothing else
// has turned the picture over. With the transport running the advance
// waits for the next bar so it lands like a bank commit would.
import { useBroadcast } from './setlist';
import { useSequencerStore } from '../state/store';
import { subscribeStreamEvents } from '../stream/streamEvents';
import { advancePool } from '../stream/poolControl';

// Seconds a clip may hold, [min, max] with jitter. One range for songs and
// records since 2026-09-22 (Chris: "20 - 30 seconds max"); the record
// clock's old 18–40 s would have outlasted the song maximum.
export const MAX_CLIP_SECS: [number, number] = [20, 30];
export const RECORD_CLIP_SECS: [number, number] = MAX_CLIP_SECS;
// Longest wait for a bar boundary before advancing anyway.
const BAR_WAIT_CAP_MS = 8000;
const STEPS_PER_BAR = 32;

let timer: number | null = null;
let barWait: (() => void) | null = null;
let installed: (() => void) | null = null;

function range(): [number, number] {
  return useBroadcast.getState().record ? RECORD_CLIP_SECS : MAX_CLIP_SECS;
}

function fire(heldSecs: number): void {
  const go = (why: string) => {
    barWait?.();
    barWait = null;
    advancePool();
    console.info(`[pool] clip clock → next clip (held ${heldSecs.toFixed(0)} s, ${why})`);
    // The pool's `visual` event re-arms; if the pool is empty nothing
    // arrives, so arm here as well (arm() is idempotent).
    arm();
  };
  if (!useSequencerStore.getState().playing) {
    go('transport stopped');
    return;
  }
  const unsub = useSequencerStore.subscribe((s, prev) => {
    if (s.globalStep !== prev.globalStep && s.globalStep % STEPS_PER_BAR === 0) go('on the bar');
  });
  const cap = window.setTimeout(() => go('bar wait capped'), BAR_WAIT_CAP_MS);
  barWait = () => {
    unsub();
    window.clearTimeout(cap);
  };
}

function disarm(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
  barWait?.();
  barWait = null;
}

function arm(): void {
  disarm();
  const [lo, hi] = range();
  const secs = lo + Math.random() * (hi - lo);
  timer = window.setTimeout(() => {
    timer = null;
    fire(secs);
  }, secs * 1000);
}

export function installClipClock(): () => void {
  if (installed) return installed;
  arm();
  // A record starting or ending changes the range: re-arm.
  const unsubRecord = useBroadcast.subscribe((b, prev) => {
    if (!!b.record !== !!prev.record) arm();
  });
  // Any clip change (bank commit, hotkey, this clock) restarts the hold.
  let unsubEvents: (() => void) | null = null;
  let cancelled = false;
  void subscribeStreamEvents((batch) => {
    if (cancelled) return;
    if (batch.some((e) => e.kind === 'visual')) arm();
  }).then((u) => {
    if (cancelled) u();
    else unsubEvents = u;
  });
  installed = () => {
    cancelled = true;
    unsubRecord();
    unsubEvents?.();
    disarm();
    installed = null;
  };
  return installed;
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    installed?.();
  });
}
