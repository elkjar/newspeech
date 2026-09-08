// One subscription to the stream event channel, fanned into a small store
// the OS windows read. Same webview as the emitter (BROADCAST announces
// presence to itself), so this is just the 10 Hz snapshot + a rolling log.
import { create } from 'zustand';
import { subscribeStreamEvents, type StreamEvent } from '../../stream/streamEvents';

export type Snapshot = Extract<StreamEvent, { kind: 'state' }>;

export interface FeedRow {
  id: number;
  t: number; // performance.now()
  kind: 'ghost' | 'param' | 'mutate' | 'lfo' | 'visual' | 'divider' | 'hit';
  label: string;
}

// A voice heard recently: what's sounding right now, for the ghost window.
export interface Hearing {
  voice: string;
  lastT: number;
  velocity: number;
  count: number;
}
// A voice that hasn't fired for this long counts as "new" when it returns.
const REAPPEAR_MS = 2500;
const HEARING_KEEP_MS = 4000;

interface StreamState {
  snapshot: Snapshot | null;
  rows: FeedRow[];
  hearing: Hearing[];
  // Bank walk: active-bank history (most recent last), for the banks window.
  walk: number[];
  push: (events: StreamEvent[]) => void;
  seed: (snapshot: Snapshot, rows: FeedRow[], walk: number[]) => void;
}

const MAX_ROWS = 120;
let nextId = 1;

export const useStreamState = create<StreamState>((set) => ({
  snapshot: null,
  rows: [],
  hearing: [],
  walk: [],
  // Same references back for anything untouched — a batch that is only the
  // 10 Hz snapshot must not re-render the ghost window's rows and hearing.
  push: (events) =>
    set((s) => {
      let snapshot = s.snapshot;
      let walk = s.walk;
      let rows = s.rows;
      let hearing = s.hearing;
      let rowsCopied = false;
      let hearingCopied = false;
      const copyRows = () => {
        if (!rowsCopied) {
          rows = rows.slice();
          rowsCopied = true;
        }
      };
      const copyHearing = () => {
        if (!hearingCopied) {
          hearing = hearing.map((h) => ({ ...h }));
          hearingCopied = true;
        }
      };
      const t = performance.now();
      for (const e of events) {
        if (e.kind === 'state') {
          if (e.activeBank !== null && e.activeBank !== walk[walk.length - 1]) {
            walk = [...walk, e.activeBank].slice(-24);
          }
          snapshot = e;
        } else if (e.kind === 'step') {
          copyHearing();
          const h = hearing.find((x) => x.voice === e.voice);
          if (h) {
            if (t - h.lastT > REAPPEAR_MS) {
              copyRows();
              rows.push({ id: nextId++, t, kind: 'hit', label: e.voice });
            }
            h.lastT = t;
            h.velocity = e.velocity;
            h.count += 1;
          } else {
            hearing.push({ voice: e.voice, lastT: t, velocity: e.velocity, count: 1 });
            copyRows();
            rows.push({ id: nextId++, t, kind: 'hit', label: e.voice });
          }
        } else {
          copyRows();
          rows.push({ id: nextId++, t, kind: e.kind, label: e.label });
        }
      }
      if (hearingCopied || hearing.some((h) => t - h.lastT >= HEARING_KEEP_MS)) {
        hearing = hearing.filter((h) => t - h.lastT < HEARING_KEEP_MS).sort((a, b) => b.lastT - a.lastT);
      }
      if (rowsCopied && rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
      return { snapshot, rows, walk, hearing };
    }),
  seed: (snapshot, rows, walk) => set({ snapshot, rows, walk }),
}));

let installed = false;
export function installStreamState(): () => void {
  if (installed) return () => {};
  installed = true;
  let unsub: (() => void) | null = null;
  let cancelled = false;
  void subscribeStreamEvents((batch) => {
    if (!cancelled) useStreamState.getState().push(batch);
  }).then((fn) => {
    if (cancelled) fn();
    else unsub = fn;
  });
  return () => {
    cancelled = true;
    installed = false;
    unsub?.();
  };
}
