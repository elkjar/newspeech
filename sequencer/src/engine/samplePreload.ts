// Extracted verbatim from App.tsx (Phase 0 of the broadcast runner,
// docs/broadcast-set.md). No behavior change: each install* function is the
// body of the former useEffect and returns the same cleanup.
import { useSequencerStore } from '../state/store';
import { samplePlayer } from '../audio/samplePlayer';

// Preload sample paths into the native cpal registry for every voice
// track in state. Idempotent (Rust caches by path). Without preload,
// the first trigger on a freshly-assigned voice incurs invoke + WAV-
// decode latency on the audio path and lands as an audible click
// delay. Tauri-only — the web build skips this entirely.
//
// Gated on `bootDone` because samplePlayer.voices is empty until kit
// manifests resolve. Once bootDone flips, the initial pass fires with
// voices populated; the subscription stays live for source swaps.
//
// The pass is staged carefully to avoid hanging the UI:
//   1. De-dupe by voice id (multiple tracks share voices — we don't
//      want to fire the same preload twice).
//   2. Defer the initial pass via setTimeout(0) so React gets to
//      paint the post-splash UI BEFORE we start the IPC pile-up.
//   3. Serialize voices through a small queue (one voice at a time);
//      each voice's preloadNativeForVoice still parallelizes its own
//      paths internally via Promise.allSettled. This caps the wave
//      of concurrent fetch+IPC calls hitting the audio thread.
export function installSamplePreload(): () => void {

  const queue: string[] = [];
  let draining = false;
  let cancelled = false;

  const drain = async () => {
    if (draining || cancelled) return;
    draining = true;
    while (queue.length > 0 && !cancelled) {
      const voiceId = queue.shift()!;
      try {
        await samplePlayer.preloadNativeForVoice(voiceId);
      } catch (err) {
        console.warn('[nativeAudio] preload failed for', voiceId, err);
      }
    }
    draining = false;
  };

  const enqueue = (voiceId: string) => {
    if (queue.includes(voiceId)) return;
    queue.push(voiceId);
    void drain();
  };

  // 100 ms gap (not just setTimeout(0)) so React's first paint of the
  // post-splash UI lands and the browser does its initial layout
  // before we start the preload pile-up. Without this gap the
  // synchronous bytes-encoding work for the first few files races
  // the first paint and the user sees the splash sit at 18/18.
  const initialHandle = setTimeout(() => {
    const unique = new Set<string>();
    for (const t of useSequencerStore.getState().tracks) {
      if (t.source.kind === 'voice') unique.add(t.source.id);
    }
    console.info(
      `[nativeAudio] preload start: ${unique.size} unique voice(s)`,
    );
    const startedAt = performance.now();
    const onComplete = () => {
      const ms = (performance.now() - startedAt).toFixed(0);
      console.info(`[nativeAudio] preload finished in ${ms} ms`);
    };
    // Wrap the queue's drain to report completion. drain() is the
    // shared loop; we patch the cancelled flag check so when the
    // queue empties we log once.
    for (const v of unique) enqueue(v);
    // Poll for completion (cheap — once per 250 ms while draining).
    const waitDone = setInterval(() => {
      if (cancelled) {
        clearInterval(waitDone);
        return;
      }
      if (queue.length === 0 && !draining) {
        clearInterval(waitDone);
        onComplete();
      }
    }, 250);
  }, 100);

  const unsubscribe = useSequencerStore.subscribe((state, prev) => {
    const prevById = new Map(prev.tracks.map((t) => [t.id, t] as const));
    for (const cur of state.tracks) {
      if (cur.source.kind !== 'voice') continue;
      const prv = prevById.get(cur.id);
      const sourceChanged =
        !prv ||
        prv.source.kind !== 'voice' ||
        prv.source.id !== cur.source.id;
      if (sourceChanged) enqueue(cur.source.id);
    }
  });

  return () => {
    cancelled = true;
    clearTimeout(initialHandle);
    unsubscribe();
  };
}
