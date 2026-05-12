// Per-track Moog-style ladder filter — channel effect across every track.
// Slice 1: cutoff + resonance only. Drive / envelope / filter-type variants
// are explicit follow-up slices. See plans/alright-building-from-the-jolly-
// hummingbird.md and project_sequencer.md for context.
//
// Topology (per track, lazy-created on first trigger from that track):
//
//   filterIn (GainNode 1.0)
//     → ladder worklet (cutoff, resonance AudioParams)
//     → filterOut (GainNode 1.0)
//        ├── wet (GainNode, fxSend)   → voicesBus
//        └── dry (GainNode, 1-fxSend) → mixBus
//
// Wet/dry split MOVED from per-trigger (samplePlayer.trigger) into the
// persistent graph. fxSend is now LFO-modulatable continuously (was: per-
// trigger snapshot). This was the load-bearing reason wet/dry had to move —
// keeping them per-trigger but feeding from a persistent filterOut would
// leak GainNodes (filterOut keeps every per-trigger wet/dry reachable from
// the destination forever).
//
// All tracks get a filter graph. Defaults (cutoff=1.0 → ~18kHz, resonance=0,
// fxSend=0) make the filter effectively transparent so existing patterns
// don't change tone on update.
import { getAudioContext, getVoicesBus, getMixBus } from './audioContext';

export interface TrackFilterParams {
  cutoff: number;     // 0..1, log-mapped to CUTOFF_MIN_HZ..CUTOFF_MAX_HZ
  resonance: number;  // 0..1
  fxSend: number;     // 0..1, wet/dry split
}

// Tight log range so even small reductions from the top are audible (per
// `feedback_visible_defaults` — defaults transparent, knob twists obvious).
// 50 Hz → very dark, 18 kHz → fully open.
const CUTOFF_MIN_HZ = 50;
const CUTOFF_MAX_HZ = 18000;
const CUTOFF_RATIO = CUTOFF_MAX_HZ / CUTOFF_MIN_HZ;

const PARAM_RAMP = 0.02;

interface TrackFilterGraph {
  filterIn: GainNode;
  worklet: AudioWorkletNode;
  wet: GainNode;
  dry: GainNode;
}

let initialized = false;
let initializing: Promise<void> | null = null;
let workletLoaded = false;
const graphs: Map<string, TrackFilterGraph> = new Map();

export function cutoffStoreToHz(store01: number): number {
  // log map: 50 * (360)^store01. clamp into [CUTOFF_MIN_HZ, CUTOFF_MAX_HZ].
  const c = Math.max(0, Math.min(1, store01));
  return CUTOFF_MIN_HZ * Math.pow(CUTOFF_RATIO, c);
}

export async function initTrackFilter(): Promise<void> {
  if (initialized) return;
  if (initializing) return initializing;

  initializing = (async () => {
    const ctx = getAudioContext();
    if (!workletLoaded) {
      const url = `${import.meta.env.BASE_URL}worklets/track-ladder.js`;
      await ctx.audioWorklet.addModule(url);
      workletLoaded = true;
    }
    initialized = true;
  })();

  return initializing;
}

// Returns the per-track filter INPUT node. Every trigger from this track's
// samplePlayer call connects to it. Lazy-creates the full filter graph on
// first call.
//
// If initTrackFilter() hasn't completed yet (first triggers in the boot
// window before the worklet module finishes loading), we still create the
// gain nodes and route them through the wet/dry split DIRECTLY (no filter).
// The worklet hookup happens once initialized, but to keep this simple we
// require initTrackFilter() complete before the first trigger. togglePlayback
// awaits init before scheduling — so by the time any audio fires, we're set.
export function getTrackFilter(trackId: string): GainNode {
  const existing = graphs.get(trackId);
  if (existing) return existing.filterIn;
  const ctx = getAudioContext();
  if (!workletLoaded) {
    // Defensive fallback — straight passthrough into mixBus until the worklet
    // is available. Shouldn't be reached in normal flow because togglePlayback
    // awaits initTrackFilter() before the scheduler starts.
    const filterIn = ctx.createGain();
    filterIn.gain.value = 1;
    filterIn.connect(getMixBus());
    return filterIn;
  }

  const filterIn = ctx.createGain();
  filterIn.gain.value = 1;

  const worklet = new AudioWorkletNode(ctx, 'track-ladder', {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    channelCount: 2,
    channelCountMode: 'explicit',
  });

  const wet = ctx.createGain();
  wet.gain.value = 0;
  const dry = ctx.createGain();
  dry.gain.value = 1;

  filterIn.connect(worklet);
  worklet.connect(wet);
  worklet.connect(dry);
  wet.connect(getVoicesBus());
  dry.connect(getMixBus());

  graphs.set(trackId, { filterIn, worklet, wet, dry });
  return filterIn;
}

export function applyTrackFilterParams(trackId: string, params: TrackFilterParams): void {
  const g = graphs.get(trackId);
  if (!g) return;
  const ctx = getAudioContext();
  const t = ctx.currentTime;
  const cutoffP = g.worklet.parameters.get('cutoff');
  const resP = g.worklet.parameters.get('resonance');
  if (cutoffP) cutoffP.setTargetAtTime(cutoffStoreToHz(params.cutoff), t, PARAM_RAMP);
  if (resP) resP.setTargetAtTime(Math.max(0, Math.min(1, params.resonance)), t, PARAM_RAMP);
  const fx = Math.max(0, Math.min(1, params.fxSend));
  g.wet.gain.setTargetAtTime(fx, t, PARAM_RAMP);
  g.dry.gain.setTargetAtTime(1 - fx, t, PARAM_RAMP);
}

// Pattern swap / project import: disconnect and clear so stale filter state
// from the previous pattern doesn't keep ringing into the new one. Same
// reasoning as resetChordContext / resetPadDrift in store.ts.
export function resetTrackFilters(): void {
  for (const g of graphs.values()) {
    try {
      g.filterIn.disconnect();
      g.worklet.disconnect();
      g.wet.disconnect();
      g.dry.disconnect();
    } catch {
      /* already disconnected */
    }
  }
  graphs.clear();
}
