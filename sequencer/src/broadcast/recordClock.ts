// While a record plays the transport is stopped and Ghost is idle, so nothing
// commits a bank and the pool would hold one clip for the whole file — ten
// minutes on a drone (Chris, 2026-09-21). This clock turns the picture over
// on its own while a record is current: every RECORD_CLIP_SECS with jitter.
import { useBroadcast } from './setlist';
import { advancePool } from '../stream/poolControl';

// Seconds between clip changes under a record: a hold, not a cut-up — the
// reactive layer moves the clip in between.
export const RECORD_CLIP_SECS: [number, number] = [18, 40];

let timer: number | null = null;
let installed: (() => void) | null = null;

function arm(): void {
  const [lo, hi] = RECORD_CLIP_SECS;
  const secs = lo + Math.random() * (hi - lo);
  timer = window.setTimeout(() => {
    timer = null;
    if (!useBroadcast.getState().record) return;
    advancePool();
    console.info(`[pool] record clock → next clip (held ${secs.toFixed(0)} s)`);
    arm();
  }, secs * 1000);
}

function disarm(): void {
  if (timer !== null) window.clearTimeout(timer);
  timer = null;
}

export function installRecordClock(): () => void {
  if (installed) return installed;
  let was = !!useBroadcast.getState().record;
  if (was) arm();
  const unsub = useBroadcast.subscribe((b) => {
    const is = !!b.record;
    if (is === was) return;
    was = is;
    disarm();
    if (is) arm();
  });
  installed = () => {
    unsub();
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
