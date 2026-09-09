// The transmission. BROADCAST's picture is a signal that degrades and comes
// back: one number, quality 0..1, that the overlay reads every frame. Three
// things move it:
//   - ambient drift — a slow random walk that never quite settles, with
//     Poisson-scheduled dropouts / tears / long fades whose rate climbs as
//     the base quality falls (weak reception gets worse);
//   - the set — the last bar of a song pulls the picture down, the swap
//     (= the incoming song's downbeat) fires a static burst and the signal
//     locks back in; a bank-swap count-in fizzes 4·3·2·1 and locks on the
//     landing; high entropy in the active bank leans the drift down;
//   - forced events (demo / screenshots) via `forceSignalEvent`.
// Slow machine (Chris 2026-09-08): this runs under 20–30 minute broadcasts,
// so nothing needs to be immediately visible — events are minutes apart and
// seconds long, the drift retargets about once a minute, the bar takes
// twenty-odd seconds to cross. Only the set hooks are on musical time.
// Nothing here moves the picture — Chris 2026-09-08: whole-frame motion
// (hold roll, skew, fold-to-line) "feels awkward", full-screen static
// "heavy handed". The static never covers more than STATIC_CEIL; the DOM is
// only ever tinted (brightness/contrast), never transformed.
// Pure model — no DOM. `sampleSignal(now)` returns the frame the overlay
// draws (SignalOverlay.tsx). Same envelope the later tiers will read.
import { useSequencerStore } from '../../state/store';
import { currentSongDwellBars } from '../../ghost/ghost';
import { useStreamState } from './streamState';
import { useGap } from '../gap';

export type SignalEventKind = 'dropout' | 'tear' | 'sync' | 'fade' | 'lock';

interface SignalEvent {
  kind: SignalEventKind;
  t0: number;
  dur: number;
  amp: number;
  seed: number;
}

export interface TearBand {
  y: number; // fraction of height
  h: number; // fraction of height
  dx: number; // fraction of width, signed
  a: number; // alpha
}

export interface SignalFrame {
  quality: number; // 0..1, 1 = clean
  noise: number; // static coverage 0..STATIC_CEIL
  flicker: number; // veil flicker depth 0..1
  bar: number; // rolling-bar strength 0..1
  brightness: number; // root filter multiplier
  contrast: number;
  tears: TearBand[];
  // For the sys window / debugging.
  base: number;
  ending: number; // 0..1 how far into the song's last bar
  countIn: number; // 0..1 count-in fizz
  events: SignalEventKind[];
}

const STEPS_PER_BAR = 32;
// The most static the picture ever carries — always readable underneath —
// except during an interstitial, when the OS is meant to be gone.
export const STATIC_CEIL = 0.55;
export const GAP_STATIC_CEIL = 0.86;
let gapNow = 0;
export function gapLevelNow(): number {
  return gapNow;
}

// Ambient event rates, per second, at full base quality. Scaled up as the
// base falls (see rateScale).
const RATES: Record<Exclude<SignalEventKind, 'lock'>, number> = {
  dropout: 1 / 150,
  tear: 1 / 90,
  fade: 1 / 420,
  sync: 1 / 1500,
};

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

let events: SignalEvent[] = [];
let base = 0.96;
let baseTarget = 0.96;
let nextRetarget = 0;
let lastNow = 0;
let entropyBias = 0;
let lastActiveSong: number | null = null;
let lastPendingBank: number | null = null;
let lastCountIn: number | null = null;
let ending = 0;
let countIn = 0;
let installed = false;
let enabled = true;
// Wobble phases for the base texture.
const ph = [Math.random() * 7, Math.random() * 7, Math.random() * 7];

export function setSignalEnabled(v: boolean): void {
  enabled = v;
}
export function signalEnabled(): boolean {
  return enabled;
}

function push(kind: SignalEventKind, now: number, amp = 1, dur?: number): void {
  const d =
    dur ??
    (kind === 'dropout'
      ? 400 + Math.random() * 1600
      : kind === 'tear'
        ? 600 + Math.random() * 1800
        : kind === 'sync'
          ? 500 + Math.random() * 400
          : kind === 'fade'
            ? 15000 + Math.random() * 45000
            : 260);
  events.push({ kind, t0: now, dur: d, amp, seed: Math.random() });
  if (events.length > 12) events.splice(0, events.length - 12);
}

// Force an event now — demo / screenshots / tests.
export function forceSignalEvent(kind: SignalEventKind, amp = 1): void {
  push(kind, performance.now(), amp);
}

// Structural hooks: watch the store and the stream snapshot. Installed once
// by the overlay; cheap (a zustand subscribe + reads on sample).
export function installSignalHooks(): () => void {
  if (installed) return () => {};
  installed = true;
  lastActiveSong = useSequencerStore.getState().performance.activeSong;
  const unsub = useSequencerStore.subscribe((s, prev) => {
    const cur = s.performance.activeSong;
    if (cur !== prev.performance.activeSong && cur !== null && lastActiveSong !== null) {
      // The swap landed = the new song's downbeat. Burst and lock.
      push('sync', performance.now(), 1, 380);
      push('lock', performance.now() + 380, 1, 320);
    }
    lastActiveSong = cur;
  });
  return () => {
    installed = false;
    unsub();
  };
}

function readSet(now: number): void {
  const store = useSequencerStore.getState();
  // Last bar of the song → ending 0..1 across that bar (0 elsewhere).
  const dwell = currentSongDwellBars(store);
  if (dwell !== null && store.playing) {
    const barsIn = (store.globalStep - store.ghostCompositionStartStep) / STEPS_PER_BAR;
    const left = dwell - barsIn;
    ending = left <= 1 && left >= -0.25 ? clamp01(1 - Math.max(0, left)) : 0;
  } else {
    ending = 0;
  }
  const snap = useStreamState.getState().snapshot;
  if (snap) {
    // Count-in 4..1 → fizz rising; lands when pendingBank clears.
    const c = snap.transitionCountIn;
    countIn = c === null ? 0 : (5 - Math.max(1, Math.min(4, c))) / 4;
    if (lastCountIn !== null && c === null && lastPendingBank !== null && snap.pendingBank === null) {
      push('lock', now, 0.45, 200);
    }
    lastCountIn = c;
    lastPendingBank = snap.pendingBank;
    // Active bank entropy leans the drift: calm banks clean, chaos fuzzy.
    const e = snap.activeBank !== null ? (snap.bankSummary[snap.activeBank]?.entropy ?? null) : null;
    const target = e === null ? 0 : (e - 0.45) * 1.2;
    entropyBias += (target - entropyBias) * 0.02;
  } else {
    countIn = 0;
  }
}

function retarget(now: number): void {
  // Mostly clean, sometimes dipping; entropy pushes the dip deeper.
  const dip = Math.random() ** 2 * 0.22 * (1 + Math.max(0, entropyBias));
  baseTarget = clamp01(1 - dip - Math.max(0, entropyBias) * 0.04);
  nextRetarget = now + 30000 + Math.random() * 60000;
}

// The frame the overlay drew last — the tube (TubeLayer) reads the same
// envelope without advancing it a second time.
let lastFrame: SignalFrame | null = null;
export function lastSignal(): SignalFrame | null {
  return lastFrame;
}

export function sampleSignal(now: number): SignalFrame {
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0.016;
  lastNow = now;
  readSet(now);

  if (now >= nextRetarget) retarget(now);
  base += (baseTarget - base) * Math.min(1, dt * 0.08);
  const t = now / 1000;
  const wobble = 0.012 * Math.sin(t * 0.08 + ph[0]) + 0.008 * Math.sin(t * 0.43 + ph[1]) + 0.005 * Math.sin(t * 1.1 + ph[2]);
  const baseNow = clamp01(base + wobble);

  // Ambient scheduling, Poisson per kind, rate rising with weak reception.
  const rateScale = 1 + 2 * (1 - baseNow) + 1.5 * countIn + 6 * gapNow;
  for (const k of Object.keys(RATES) as Array<keyof typeof RATES>) {
    if (Math.random() < RATES[k] * rateScale * dt) push(k, now, 0.5 + Math.random() * 0.5);
  }

  // Sum the live events.
  let drop = 0;
  let noise = 0;
  let lock = 0;
  const tears: TearBand[] = [];
  const live: SignalEventKind[] = [];
  events = events.filter((e) => now < e.t0 + e.dur);
  for (const e of events) {
    if (now < e.t0) continue; // scheduled ahead (lock after sync)
    const u = clamp01((now - e.t0) / e.dur);
    live.push(e.kind);
    switch (e.kind) {
      case 'dropout': {
        const env = u < 0.15 ? u / 0.15 : Math.pow(1 - (u - 0.15) / 0.85, 0.6);
        noise = Math.max(noise, e.amp * 0.6 * env);
        drop += e.amp * env * 0.5;
        break;
      }
      case 'tear': {
        // A few thin strips of static slipping sideways, fading as they go.
        const env = 1 - u;
        const n = 1 + Math.floor(e.seed * 3);
        for (let i = 0; i < n; i++) {
          const s = (e.seed * 977 + i * 331) % 1;
          tears.push({
            y: (s + u * 0.1 * (i % 2 ? 1 : -1)) % 1,
            h: 0.004 + ((s * 13) % 1) * 0.022,
            dx: (((s * 7) % 1) - 0.5) * 0.05 * e.amp * env,
            a: 0.45 * env,
          });
        }
        drop += e.amp * 0.1 * env;
        break;
      }
      case 'sync': {
        // The swap: static floods to the ceiling and drains.
        const n = u < 0.18 ? u / 0.18 : Math.pow(1 - (u - 0.18) / 0.82, 0.8);
        noise = Math.max(noise, e.amp * n * 0.75);
        drop += e.amp * n * 0.9;
        break;
      }
      case 'fade': {
        // Weak reception: long, shallow, never a wipe.
        const env = Math.sin(Math.PI * u);
        drop += e.amp * 0.32 * env;
        noise = Math.max(noise, e.amp * 0.22 * env);
        break;
      }
      case 'lock': {
        // Snap: a bright frame that settles. Brightness handled below.
        lock = Math.max(lock, e.amp * (1 - u));
        break;
      }
    }
  }

  // Song ending pulls the picture down across the last bar; the count-in
  // adds a fizz of static that rises 4·3·2·1.
  const endDrop = ending * ending * 0.6;
  const ciDrop = countIn * 0.15;

  // The interstitial: the OS collapses into noise (hold — level climbs over
  // the first quarter, then sits) and drains back as it reboots. Chris:
  // "have the OS fully collapse into noise … and then come back together."
  const g = useGap.getState();
  const gapLevel =
    g.phase === 'hold'
      ? clamp01(g.progress / 0.25)
      : g.phase === 'swap'
        ? clamp01(g.progress / 0.15) // the short gap: static up in about a second
      : g.phase === 'boot'
        ? 0.7
        : g.phase === 'off'
          ? 0.45 + 0.55 * clamp01(1 - g.progress) // signed off: heavy static settling to a resting hiss
          : g.phase === 'reboot'
            ? clamp01(1 - g.progress) ** 1.4
            : 0;
  gapNow = gapLevel;

  const quality = clamp01(baseNow - drop - endDrop - ciDrop - gapLevel * 0.85);
  const weak = 1 - quality;
  const ceil = STATIC_CEIL + gapLevel * (GAP_STATIC_CEIL - STATIC_CEIL);
  noise = Math.min(ceil, Math.max(noise, weak * weak * 0.9, ending * 0.4, countIn * 0.12, gapLevel * GAP_STATIC_CEIL));
  const flicker = 0.02 + weak * 0.22 + ending * 0.08 + gapLevel * 0.15;
  const bar = 0.06 + weak * 0.4;
  const brightness = 1 - weak * 0.12 + lock * 0.4;
  const contrast = 1 + weak * 0.15 + lock * 0.18;

  lastFrame = {
    quality,
    noise,
    flicker: clamp01(flicker),
    bar: clamp01(bar),
    brightness,
    contrast,
    tears,
    base: baseNow,
    ending,
    countIn,
    events: live,
  };
  return lastFrame;
}
