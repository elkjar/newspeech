import { useEffect, useState } from 'react';
import { subscribeStreamEvents, type StreamEvent } from './streamEvents';

// Subscribes to the 10Hz state snapshot and returns the transition count-in:
// 4·3·2·1 across the bar before an autonomous bank swap lands, or null when
// nothing's queued. Shared by the corner dots and the video-glitch layer so
// both read the same cue off one subscription.
export function useTransitionCountIn(): number | null {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;
    void subscribeStreamEvents((batch) => {
      if (cancelled) return;
      let latest: Extract<StreamEvent, { kind: 'state' }> | null = null;
      for (const e of batch) if (e.kind === 'state') latest = e;
      if (latest) setCount(latest.transitionCountIn);
    }).then((fn) => {
      if (cancelled) fn();
      else unsub = fn;
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  return count;
}
