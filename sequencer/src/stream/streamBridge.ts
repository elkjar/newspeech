// Extracted verbatim from App.tsx (Phase 0 of the broadcast runner,
// docs/broadcast-set.md). No behavior change: each install* function is the
// body of the former useEffect and returns the same cleanup.
import { useSequencerStore } from '../state/store';
import { computeBankEntropy } from '../ghost/entropy';
import { phaseAt, targetEntropy as computeTargetEntropy } from '../ghost/shape';
import {
  emitStreamEvents,
  initStreamPresenceMain,
  isStreamListenerActive,
} from './streamEvents';

// Track whether the stream window is mounted. Gates emitStreamEvents
// and the 10Hz snapshot so the audio dispatcher isn't paying Tauri
// IPC serialization cost when nobody's listening.
export function installStreamPresence(): () => void {
  let cleanup: (() => void) | undefined;
  void initStreamPresenceMain().then((fn) => {
    cleanup = fn;
  });
  return () => {
    cleanup?.();
  };
}

// Periodic state snapshot for the stream window. 10Hz matches
// GhostDebug's DensityTrace sample rate so Datafeed reads identically
// across the two surfaces. Carries macros + ghost state — Datafeed
// renders the histogram + shape preview + phase/target from these
// fields; Visualizer drives its procedural params from macros.
// Skips entirely when no stream window is listening (computeBankEntropy
// walks every populated bank slot, not free).
export function installStreamSnapshot(): () => void {
  const STEPS_PER_BAR = 32;
  const id = window.setInterval(() => {
    if (!isStreamListenerActive()) return;
    const s = useSequencerStore.getState();
    // Per-slot entropy (live recompute matches GhostDebug behaviour).
    const results = s.banks.map((slot) =>
      slot ? computeBankEntropy(slot) : null,
    );
    const populated = results.filter((r): r is NonNullable<typeof r> => r !== null);
    const minE = populated.length > 0 ? Math.min(...populated.map((r) => r.total)) : 0;
    const maxE = populated.length > 0 ? Math.max(...populated.map((r) => r.total)) : 0;
    const active = s.activeBank !== null ? results[s.activeBank] : null;
    const bankSummary = s.banks.map((slot, i) =>
      slot
        ? {
            kind: slot.kind === 'transition' ? ('transition' as const) : ('normal' as const),
            entropy: results[i]?.total ?? 0,
          }
        : null,
    );
    const phase = phaseAt(
      s.globalStep,
      s.ghostCompositionStartStep,
      s.sceneGraph.phaseLength,
      s.sceneGraph.shape,
    );
    const target = computeTargetEntropy(s.sceneGraph.shape, phase, minE, maxE);
    const elapsedBars = Math.max(
      0,
      Math.floor((s.globalStep - s.ghostCompositionStartStep) / STEPS_PER_BAR),
    );
    // Drummer count-in. A queued bank swap (pendingBank) commits on the next
    // bar downbeat — the conductor sets it at the start of the bank's last
    // dwell bar — so while it's pending we're in exactly the bar before the
    // transition. Map the beat within that bar (8 steps/beat → 4 beats) to a
    // 4·3·2·1 count that lands on the downbeat the swap fires.
    const beatInBar = Math.floor((s.globalStep % STEPS_PER_BAR) / 8);
    const transitionCountIn =
      s.pendingBank !== null ? Math.max(1, Math.min(4, 4 - beatInBar)) : null;
    emitStreamEvents([
      {
        kind: 'state',
        density: s.density,
        chaos: s.chaos,
        motion: s.motion,
        drift: s.drift,
        tension: s.tension,
        activeBank: s.activeBank,
        pendingBank: s.pendingBank,
        transitionCountIn,
        shape: s.sceneGraph.shape,
        phaseLength: s.sceneGraph.phaseLength,
        phase,
        targetEntropy: target,
        ghostEnabled: s.sceneGraph.enabled,
        bankOrderMode: s.sceneGraph.bankOrderMode,
        elapsedBars,
        minE,
        maxE,
        bankSummary,
        activeBreakdown: active
          ? {
              total: active.total,
              channels: active.channels,
              voiceType: active.voiceType,
              stepDensity: active.stepDensity,
              mutation: active.mutation,
              polyphony: active.polyphony,
            }
          : null,
      },
    ]);
  }, 100);
  return () => window.clearInterval(id);
}

// Performer-interaction emission. Throttled per-key at ~3Hz with a 0.04
// value-delta floor so a knob sweep produces a handful of meaningful
// landings rather than a smear of micro-steps. Catches MIDI-CC moves
// and on-screen drag the same way — both go through the store setter.
// Covers the highest-impact performance surfaces: macros (global feel),
// per-track filter cutoff / Q (filter sweeps), per-track mutation rate,
// and LFO depth. LFO destination assignments emit directly from the
// store actions (discrete events, no throttle needed).
export function installStreamInteractionEmit(): () => void {
  const lastEmit: Record<string, number> = {};
  const lastVal: Record<string, number> = {};
  const MACRO_KEYS = ['density', 'chaos', 'motion', 'drift', 'tension'] as const;

  const check = (
    id: string,
    cur: number,
    prv: number,
    label: string,
    now: number,
    out: Array<{ kind: 'param'; label: string }>
  ) => {
    if (cur === prv) return;
    if (now - (lastEmit[id] ?? 0) < 300) return;
    if (Math.abs(cur - (lastVal[id] ?? -1)) < 0.04) return;
    out.push({ kind: 'param', label: `${label} ${cur.toFixed(2)}` });
    lastEmit[id] = now;
    lastVal[id] = cur;
  };

  return useSequencerStore.subscribe((state, prev) => {
    // Param-change events only feed the stream window — skip the full
    // diff walk when no listener is mounted.
    if (!isStreamListenerActive()) return;
    const now = performance.now();
    const out: Array<{ kind: 'param'; label: string }> = [];

    // Macros
    for (const k of MACRO_KEYS) {
      check(k, state[k], prev[k], k, now, out);
    }

    // Per-track: filter cutoff, filter resonance, mutation
    const tCount = Math.min(state.tracks.length, prev.tracks.length);
    for (let i = 0; i < tCount; i++) {
      const cur = state.tracks[i];
      const prv = prev.tracks[i];
      if (!cur || !prv || cur.id !== prv.id) continue;
      check(`${cur.id}:cutoff`, cur.filterCutoff, prv.filterCutoff, `${cur.id} · cutoff`, now, out);
      check(`${cur.id}:Q`, cur.filterResonance, prv.filterResonance, `${cur.id} · Q`, now, out);
      check(`${cur.id}:mutate`, cur.mutation, prv.mutation, `${cur.id} · mutate`, now, out);
    }

    // LFO depths
    const lCount = Math.min(state.lfos.length, prev.lfos.length);
    for (let i = 0; i < lCount; i++) {
      const cur = state.lfos[i];
      const prv = prev.lfos[i];
      if (!cur || !prv || cur.id !== prv.id) continue;
      check(`lfo:${cur.id}:depth`, cur.depth, prv.depth, `LFO${cur.id} · depth`, now, out);
    }

    if (out.length > 0) emitStreamEvents(out);
  });
}
