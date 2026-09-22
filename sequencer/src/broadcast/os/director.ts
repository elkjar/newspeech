// The director — Ghost for the picture. Ghost picks banks and fills for the
// sound; this picks SHOTS: which windows are up, how big, whether the visual
// runs full-bleed, whether the picture is a single line of type on black.
// It cuts on what the set already reports (song landing, a bank swap landing,
// a record starting, an ident, the gap) and on its own Poisson clock in
// between, holds bar-quantised so cuts land on downbeats, and stands down
// entirely while the gap owns the picture. Design: docs/broadcast-director.md
// (Chris 2026-09-22: "the novelty is in the length … something you'd watch
// for 30–50 minutes"; "changing the whole layout and focusing in on specific
// windows or features").
//
// It never writes the saved layout. `home` IS the saved arrangement; every
// other shot is a transient frame the desktop renders over it, so with the
// director off the picture is exactly the one Chris arranged.
import { create } from 'zustand';
import { useSequencerStore } from '../../state/store';
import { useStreamState } from './streamState';
import { useBroadcast } from '../setlist';
import { useGap } from '../gap';
import { useCards } from '../cards';
import { useStationBoot } from '../boot';
import { forceSignalEvent } from './signal';
import { useLayout, FORMATS, type Format, type WindowId, type WinRect } from './layout';

// Every multi-up has the visual in it (Chris 2026-09-22: "the 2 up should
// always have one side be the visual … 3 and 4 up with the same rule").
// `split`: 3-up = visual big on `big` side + two stacked; 4-up = quadrants
// (`big` null, visual in quadrant `slot`) or visual big + three stacked;
// 5-up = visual big + four in a 2×2 grid.
export type Shot =
  | { kind: 'home' }
  | { kind: 'close'; win: WindowId }
  | { kind: 'pair'; a: WindowId; b: WindowId }
  | { kind: 'split'; others: WindowId[]; big: 'left' | 'right' | null; slot: number }
  | { kind: 'bleed' }
  | { kind: 'inset' }
  | { kind: 'title'; text: string; sub: string | null }
  | { kind: 'black' };

export type ShotKind = Shot['kind'];

export function shotLabel(s: Shot): string {
  switch (s.kind) {
    case 'close':
      return `close ${s.win}`;
    case 'pair':
      return `pair ${s.a}+${s.b}`;
    case 'split':
      return `${s.others.length + 1}-up ${s.big === null ? 'quad' : s.big === 'left' ? 'big-left' : 'big-right'} visual+${s.others.join('+')}`;
    case 'title':
      return `title "${s.text}"`;
    default:
      return s.kind;
  }
}

// The frame the desktop renders for a shot. `rects` null = the window is not
// in this shot. Type size never changes per shot (Chris 2026-09-22: "fonts
// changing size is going to be awkward") — the layout's one content zoom
// applies everywhere; a close shot is more of the same-size content.
export interface Frame {
  rects: Record<WindowId, WinRect | null>;
  // The visual runs full-bleed behind everything (the window itself is
  // not rendered — one Visualizer mounted at a time).
  bleed: boolean;
  // The whole desktop scaled down over the bleed: scale + stage offset.
  inset: { scale: number; x: number; y: number } | null;
  menubar: boolean;
  title: { text: string; sub: string | null } | null;
  black: boolean;
}

const CLOSE_MARGIN: Record<Format, number> = { '16:9': 24, '4:3': 0 };
const INSET_SCALE = 0.38;

// Only the visual goes full-frame (Chris 2026-09-22). Its partners in a
// pair / 3-up are the windows that move on their own — ghost, sys, audio
// ("the rest … are nice as a group but don't give much independently").
// The 4-up and 5-up also draw shape and banks, at lower weight ("adding in
// the other dialog windows for shape and banks could also work on the 4
// up, or a 5 up"). Weights: ambient vs under a record (Ghost idle, the
// scope is the movement).
const PARTNERS_PRIMARY: WindowId[] = ['ghost', 'sys', 'audio'];
const PARTNERS_WIDE: WindowId[] = ['ghost', 'sys', 'audio', 'shape', 'banks'];
const PARTNER_WEIGHT: Record<'ambient' | 'record', Record<WindowId, number>> = {
  ambient: { ghost: 0.5, sys: 0.2, audio: 0.3, shape: 0.12, banks: 0.12, visual: 0, now: 0, set: 0, card: 0 },
  record: { ghost: 0.15, sys: 0.35, audio: 0.5, shape: 0.08, banks: 0.06, visual: 0, now: 0, set: 0, card: 0 },
};
const GUTTER = 12;

export function frameFor(shot: Shot, windows: Record<WindowId, WinRect>, format: Format): Frame {
  const { safe } = FORMATS[format];
  const none = (): Record<WindowId, WinRect | null> => {
    const out = {} as Record<WindowId, WinRect | null>;
    for (const id of Object.keys(windows) as WindowId[]) out[id] = null;
    // The ident is a lower-third in every shot that has a desktop; the
    // desktop hides it anyway while no card is up.
    out.card = windows.card;
    return out;
  };
  const m = CLOSE_MARGIN[format];
  const full: WinRect = { x: safe.x + m, y: safe.y + m, w: safe.w - 2 * m, h: safe.h - 2 * m, open: true, z: 1 };
  switch (shot.kind) {
    case 'home':
      return { rects: { ...windows }, bleed: false, inset: null, menubar: true, title: null, black: false };
    case 'close': {
      const rects = none();
      rects[shot.win] = full;
      return { rects, bleed: false, inset: null, menubar: true, title: null, black: false };
    }
    case 'pair': {
      const rects = none();
      const w = Math.floor((full.w - GUTTER) / 2);
      rects[shot.a] = { ...full, w, z: 1 };
      rects[shot.b] = { ...full, x: full.x + w + GUTTER, w: full.w - w - GUTTER, z: 2 };
      return { rects, bleed: false, inset: null, menubar: true, title: null, black: false };
    }
    case 'split': {
      const rects = none();
      const halfW = Math.floor((full.w - GUTTER) / 2);
      const left: WinRect = { ...full, w: halfW };
      const right: WinRect = { ...full, x: full.x + halfW + GUTTER, w: full.w - halfW - GUTTER };
      // n windows stacked in a column.
      const stack = (col: WinRect, n: number): WinRect[] => {
        const h = Math.floor((col.h - GUTTER * (n - 1)) / n);
        return Array.from({ length: n }, (_, i) => ({ ...col, y: col.y + i * (h + GUTTER), h: i === n - 1 ? col.h - i * (h + GUTTER) : h }));
      };
      // 2×2 grid of a column, row-major: TL TR BL BR.
      const grid = (col: WinRect): WinRect[] => {
        const w = Math.floor((col.w - GUTTER) / 2);
        const l = stack({ ...col, w }, 2);
        const r = stack({ ...col, x: col.x + w + GUTTER, w: col.w - w - GUTTER }, 2);
        return [l[0], r[0], l[1], r[1]];
      };
      let z = 1;
      if (shot.big === null) {
        // Quadrants: visual in `slot`, others fill the rest in order.
        const order = grid(full);
        const slot = Math.max(0, Math.min(3, shot.slot));
        rects.visual = { ...order[slot], z: z++ };
        let k = 0;
        for (let i = 0; i < 4; i++) {
          if (i === slot) continue;
          const id = shot.others[k++];
          if (id) rects[id] = { ...order[i], z: z++ };
        }
      } else {
        const bigCol = shot.big === 'left' ? left : right;
        const smallCol = shot.big === 'left' ? right : left;
        rects.visual = { ...bigCol, z: z++ };
        // Two or three partners stack; four make a 2×2 grid (the 5-up).
        const cells = shot.others.length >= 4 ? grid(smallCol) : stack(smallCol, shot.others.length);
        shot.others.forEach((id, i) => {
          rects[id] = { ...cells[i], z: z++ };
        });
      }
      return { rects, bleed: false, inset: null, menubar: true, title: null, black: false };
    }
    case 'bleed':
      return { rects: none(), bleed: true, inset: null, menubar: false, title: null, black: false };
    case 'inset': {
      // The desktop, small, bottom-left of the safe area over the bleed.
      // Its own visual window would be a second Visualizer — not in this shot.
      const rects = { ...windows, visual: null } as Record<WindowId, WinRect | null>;
      const f = FORMATS[format];
      const s = INSET_SCALE;
      const x = safe.x + m;
      const y = safe.y + safe.h - m - f.h * s;
      return { rects, bleed: true, inset: { scale: s, x, y }, menubar: false, title: null, black: false };
    }
    case 'title': {
      const rects = none();
      rects.card = null;
      return { rects, bleed: false, inset: null, menubar: false, title: { text: shot.text, sub: shot.sub }, black: true };
    }
    case 'black': {
      const rects = none();
      rects.card = null;
      return { rects, bleed: false, inset: null, menubar: false, title: null, black: true };
    }
  }
}

// ---- store -----------------------------------------------------------------

const LS_ON = 'broadcast.director.on';
function loadOn(): boolean {
  try {
    const v = localStorage.getItem(LS_ON);
    return v === null ? true : v === '1';
  } catch {
    return true;
  }
}

interface DirectorState {
  // Director on: shots run from the schedule. Off: the picture is `home`.
  on: boolean;
  // Auto: the schedule cuts. `a` pauses / resumes it. A forced shot (key /
  // menu) does NOT pause — it takes the picture for its normal hold and the
  // schedule continues from it (Chris 2026-09-22: no automated cuts seen
  // after stepping through the keys — every key had paused auto).
  auto: boolean;
  shot: Shot;
  since: number; // performance.now()
  // Why the current shot was chosen — for the sys window / console.
  reason: string;
  setOn: (v: boolean) => void;
  setAuto: (v: boolean) => void;
}

export const useDirector = create<DirectorState>((set) => ({
  on: loadOn(),
  auto: true,
  shot: { kind: 'home' },
  since: 0,
  reason: 'boot',
  setOn: (v) => {
    try {
      localStorage.setItem(LS_ON, v ? '1' : '0');
    } catch {
      // ignore
    }
    set({ on: v });
  },
  setAuto: (v) => set({ auto: v }),
}));

// The shot the desktop renders: `home` whenever the director is off, the gap
// owns the picture, or the layout is being arranged.
export function effectiveShot(): Shot {
  const d = useDirector.getState();
  if (!d.on) return HOME;
  if (useGap.getState().phase !== 'none') return HOME;
  if (useLayout.getState().arranging && useStationBoot.getState().phase === 'standby') return HOME;
  return d.shot;
}

const HOME: Shot = { kind: 'home' };

// ---- scheduling ---------------------------------------------------------------

// Hold ranges, seconds. Density scales them (dense → shorter); a running
// tempo quantises the cut to the next downbeat.
const HOLD: Record<ShotKind, [number, number]> = {
  home: [30, 120],
  close: [8, 40],
  pair: [20, 60],
  split: [20, 60],
  bleed: [15, 90],
  inset: [20, 60],
  title: [2.5, 5],
  black: [1.2, 2],
};
const STEPS_PER_BAR = 32;

let dueAt = Infinity; // performance.now() when the current hold ends
let armed = false; // hold ended — cut on the next downbeat
let followUp: Shot | null = null; // what a title/black resolves into
let lastRecord: string | null = null;
let lastPendingBank: number | null = null;
let lastActiveSong: number | null = null;
let lastCardUp = false;
let lastGapPhase = useGap.getState().phase;

function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function snapshot() {
  return useStreamState.getState().snapshot;
}

function density(): number {
  return snapshot()?.density ?? 0.5;
}

function activeEntropy(): number {
  const s = snapshot();
  if (!s || s.activeBank === null) return 0.5;
  return s.bankSummary[s.activeBank]?.entropy ?? 0.5;
}

function pick<T>(items: Array<[T, number]>): T {
  let total = 0;
  for (const [, w] of items) total += w;
  let r = Math.random() * total;
  for (const [v, w] of items) {
    r -= w;
    if (r <= 0) return v;
  }
  return items[items.length - 1][0];
}

function openWindows(): Set<WindowId> {
  const w = useLayout.getState().windows;
  const out = new Set<WindowId>();
  for (const id of Object.keys(w) as WindowId[]) if (w[id].open && id !== 'card') out.add(id);
  return out;
}

function pickClose(): Shot {
  return openWindows().has('visual') ? { kind: 'close', win: 'visual' } : HOME;
}

// `n` distinct partners for the visual, weighted, from the open ones.
// `wide` admits shape and banks (4-up and up).
function pickPartners(n: number, mode: 'ambient' | 'record', wide = false): WindowId[] {
  const open = openWindows();
  let pool = (wide ? PARTNERS_WIDE : PARTNERS_PRIMARY).filter((id) => open.has(id)).map((id) => [id, PARTNER_WEIGHT[mode][id]] as [WindowId, number]);
  const out: WindowId[] = [];
  while (out.length < n && pool.length > 0) {
    const id = pick(pool);
    out.push(id);
    pool = pool.filter(([p]) => p !== id);
  }
  return out;
}

// Visual on a random side with one partner.
function pickPair(mode: 'ambient' | 'record'): Shot {
  if (!openWindows().has('visual')) return HOME;
  const [p] = pickPartners(1, mode);
  if (!p) return pickClose();
  return Math.random() < 0.5 ? { kind: 'pair', a: 'visual', b: p } : { kind: 'pair', a: p, b: 'visual' };
}

// 3-up (2+1 / 1+2), 4-up (quadrants / 3+1 / 1+3) or 5-up (1+4 grid), the
// visual always in. Falls back to fewer windows when not enough partners
// are open.
function pickSplit(n: 3 | 4 | 5, mode: 'ambient' | 'record'): Shot {
  if (!openWindows().has('visual')) return HOME;
  const others = pickPartners(n - 1, mode, n >= 4);
  if (others.length < 2) return pickPair(mode);
  const side = (): 'left' | 'right' => (Math.random() < 0.5 ? 'left' : 'right');
  if (others.length === 2) return { kind: 'split', others, big: side(), slot: 0 };
  if (others.length >= 4) return { kind: 'split', others: others.slice(0, 4), big: side(), slot: 0 };
  if (Math.random() < 0.5) return { kind: 'split', others, big: null, slot: Math.floor(Math.random() * 4) };
  return { kind: 'split', others, big: side(), slot: 0 };
}

// The next shot from the ambient schedule. Entropy leans the choice: calm
// banks wide (more windows), chaos close (fewer). Under a record the
// visual is the subject and the scope (the only other thing moving) is
// its usual partner. Split screens weigh heavily since 2026-09-22 (Chris:
// "the split screen with a dialog + visualizer is strong").
function pickNext(from: Shot): Shot {
  const rec = useBroadcast.getState().record;
  const mode = rec ? 'record' : 'ambient';
  type K = 'home' | 'close' | 'pair' | 'split3' | 'split4' | 'split5' | 'bleed' | 'inset';
  let k: K;
  if (rec) {
    k = pick<K>([
      ['bleed', 0.25],
      ['pair', 0.23],
      ['split3', 0.12],
      ['split4', 0.07],
      ['split5', 0.04],
      ['inset', 0.09],
      ['close', 0.1],
      ['home', 0.1],
    ]);
  } else {
    const e = activeEntropy();
    const lean = (e - 0.5) * 0.5; // -0.25 .. +0.25
    k = pick<K>([
      ['home', 0.18 - lean * 0.6],
      ['close', 0.12 + lean * 0.6],
      ['pair', 0.24 + lean * 0.4],
      ['split3', 0.14 - lean * 0.2],
      ['split4', 0.09 - lean * 0.2],
      ['split5', 0.05 - lean * 0.1],
      ['bleed', 0.13],
      ['inset', 0.05],
    ]);
  }
  let next: Shot;
  switch (k) {
    case 'home':
      next = HOME;
      break;
    case 'close':
      next = pickClose();
      break;
    case 'pair':
      next = pickPair(mode);
      break;
    case 'split3':
      next = pickSplit(3, mode);
      break;
    case 'split4':
      next = pickSplit(4, mode);
      break;
    case 'split5':
      next = pickSplit(5, mode);
      break;
    case 'bleed':
      next = { kind: 'bleed' };
      break;
    case 'inset':
      next = { kind: 'inset' };
      break;
  }
  // Never the same shot twice in a row.
  if (shotLabel(next) === shotLabel(from)) return from.kind === 'home' ? pickClose() : HOME;
  return next;
}

function holdFor(shot: Shot): number {
  const [a, b] = HOLD[shot.kind];
  const d = density();
  // dense → 0.6×, sparse → 1.4× (titles and black keep their length)
  const k = shot.kind === 'title' || shot.kind === 'black' ? 1 : 1.4 - 0.8 * d;
  return rnd(a, b) * k * 1000;
}

function cut(shot: Shot, reason: string, opts: { tear?: boolean; then?: Shot | null } = {}): void {
  const now = performance.now();
  useDirector.setState({ shot, since: now, reason });
  dueAt = now + holdFor(shot);
  armed = false;
  followUp = opts.then ?? null;
  if (opts.tear && Math.random() < 0.5) forceSignalEvent('tear', 0.6);
  console.info(`[director] ${shotLabel(shot)} — ${reason}`);
}

// A cut asked for by a key or the menu: takes the picture now, holds its
// normal length, then the schedule carries on (when auto is on).
export function forceShot(shot: Shot): void {
  cut(shot, 'forced');
}

export function resumeAuto(): void {
  useDirector.getState().setAuto(true);
  cut(HOME, 'auto resumed');
}

function songTitleNow(): string {
  const b = useBroadcast.getState();
  const rec = b.record;
  if (rec) return rec.name;
  const t = useSequencerStore.getState().songTitle;
  if (t) return t;
  const cur = b.current !== null ? b.entries[b.current] : null;
  return cur ? cur.name : 'untitled';
}

function bankSub(): string | null {
  const s = snapshot();
  if (!s || s.activeBank === null) return null;
  const e = s.bankSummary[s.activeBank]?.entropy;
  return `bank ${s.activeBank + 1}${e !== undefined ? ` · entropy ${e.toFixed(2)}` : ''}`;
}

export function titleShot(text = songTitleNow(), sub: string | null = bankSub()): Shot {
  return { kind: 'title', text, sub };
}

// Advance on the schedule. Called at ~10 Hz and on every bar boundary.
function tick(now: number, onBar: boolean): void {
  const d = useDirector.getState();
  if (!d.on || !d.auto) return;
  if (useGap.getState().phase !== 'none') return;
  if (useCards.getState().active) {
    // An ident pins the picture; the hold resumes when it hides.
    dueAt = Math.max(dueAt, now + 1000);
    return;
  }
  if (now < dueAt) return;
  const store = useSequencerStore.getState();
  const running = store.playing && store.bpm > 0 && !useBroadcast.getState().record;
  // Titles and black resolve immediately (they are their own beat); other
  // shots wait for the downbeat when a tempo is running.
  const immediate = d.shot.kind === 'title' || d.shot.kind === 'black';
  if (running && !immediate && !onBar) {
    armed = true;
    return;
  }
  if (followUp) {
    const next = followUp;
    followUp = null;
    cut(next, `after ${d.shot.kind}`);
    return;
  }
  cut(pickNext(d.shot), armed ? 'hold ended · downbeat' : 'hold ended', { tear: true });
}

// Event-driven cuts.
function onSnapshot(): void {
  const s = snapshot();
  if (!s) return;
  const d = useDirector.getState();
  // A bank swap landed (pendingBank cleared after a count-in): cut.
  if (lastPendingBank !== null && s.pendingBank === null && d.on && d.auto && useGap.getState().phase === 'none' && !useCards.getState().active) {
    if (d.shot.kind !== 'title' && d.shot.kind !== 'black') cut(pickNext(d.shot), 'bank swap landed', { tear: true });
  }
  lastPendingBank = s.pendingBank;
}

function onSongLanded(): void {
  const d = useDirector.getState();
  if (!d.on || !d.auto || useGap.getState().phase !== 'none') return;
  // Read the title on the next tick — applySong sets it after the swap.
  window.setTimeout(() => cut(titleShot(), 'song landed', { then: HOME }), 0);
}

function onRecord(rec: { name: string } | null): void {
  const d = useDirector.getState();
  const name = rec ? rec.name : null;
  if (name === lastRecord) return;
  lastRecord = name;
  if (!rec || !d.on || !d.auto || useGap.getState().phase !== 'none') return;
  cut(titleShot(rec.name, 'record'), 'record started', { then: { kind: 'bleed' } });
}

function onCard(up: boolean): void {
  if (up === lastCardUp) return;
  lastCardUp = up;
  const d = useDirector.getState();
  if (!up || !d.on || !d.auto) return;
  // The ident is a lower-third: it needs a desktop or the bleed under it.
  if (d.shot.kind !== 'home' && d.shot.kind !== 'bleed') cut(d.shot.kind === 'inset' ? { kind: 'bleed' } : HOME, 'ident up');
}

function onGap(phase: string): void {
  if (phase === lastGapPhase) return;
  const was = lastGapPhase;
  lastGapPhase = phase as typeof lastGapPhase;
  const d = useDirector.getState();
  if (!d.on || !d.auto) return;
  // Coming back from a gap or the boot: home first, then the schedule.
  if (phase === 'none' && was !== 'none') cut(HOME, `after ${was}`);
}

let installed: (() => void) | null = null;
export function installDirector(): () => void {
  if (installed) return installed;
  const unsubs: Array<() => void> = [];
  lastActiveSong = useSequencerStore.getState().performance.activeSong;
  lastPendingBank = snapshot()?.pendingBank ?? null;
  lastRecord = useBroadcast.getState().record?.name ?? null;
  lastCardUp = useCards.getState().active !== null;
  lastGapPhase = useGap.getState().phase;
  cut(HOME, 'installed');

  // Song landing (same edge the signal layer bursts on).
  unsubs.push(
    useSequencerStore.subscribe((s, prev) => {
      const cur = s.performance.activeSong;
      if (cur !== prev.performance.activeSong && cur !== null && lastActiveSong !== null) onSongLanded();
      lastActiveSong = cur;
      // Downbeat: the step that opens a bar.
      if (s.globalStep !== prev.globalStep && s.globalStep % STEPS_PER_BAR === 0 && armed) tick(performance.now(), true);
    }),
  );
  unsubs.push(useStreamState.subscribe((s, prev) => s.snapshot !== prev.snapshot && onSnapshot()));
  unsubs.push(useBroadcast.subscribe((s, prev) => s.record !== prev.record && onRecord(s.record)));
  unsubs.push(useCards.subscribe((s) => onCard(s.active !== null)));
  unsubs.push(useGap.subscribe((g) => onGap(g.phase)));
  const timer = window.setInterval(() => tick(performance.now(), false), 100);
  unsubs.push(() => window.clearInterval(timer));

  installed = () => {
    for (const u of unsubs) u();
    installed = null;
  };
  return installed;
}

// Keys: digits force a shot, `a` pauses / resumes auto. Returns true when
// the key was taken.
export const KEY_SHOTS: Array<[string, () => Shot, string]> = [
  ['1', () => HOME, 'home'],
  ['2', () => ({ kind: 'close', win: 'visual' }), 'close visual'],
  ['3', () => pickPair('ambient'), 'pair'],
  ['4', () => pickSplit(3, 'ambient'), '3-up'],
  ['5', () => pickSplit(4, 'ambient'), '4-up'],
  ['6', () => pickSplit(5, 'ambient'), '5-up'],
  ['7', () => ({ kind: 'bleed' }), 'bleed'],
  ['8', () => ({ kind: 'inset' }), 'inset'],
  ['9', () => titleShot(), 'title'],
  ['0', () => ({ kind: 'black' }), 'black'],
];
export function directorKey(key: string): boolean {
  if (!useDirector.getState().on) return false;
  if (key === 'a') {
    if (useDirector.getState().auto) {
      useDirector.getState().setAuto(false);
      console.info('[director] auto paused');
    } else resumeAuto();
    return true;
  }
  const k = KEY_SHOTS.find(([kk]) => kk === key);
  if (!k) return false;
  forceShot(k[1]());
  return true;
}

// Demo: window.__nsShot('close', 'ghost') / ('title', 'text') / ('home')
export function demoShot(kind: ShotKind, arg?: string): void {
  switch (kind) {
    case 'close':
      forceShot({ kind, win: (arg as WindowId) ?? 'visual' });
      break;
    case 'pair':
      forceShot({ kind, a: 'visual', b: (arg as WindowId) ?? 'ghost' });
      break;
    case 'split':
      forceShot(pickSplit(arg === '3' ? 3 : arg === '5' ? 5 : 4, 'ambient'));
      break;
    case 'title':
      forceShot(titleShot(arg));
      break;
    default:
      forceShot({ kind } as Shot);
  }
}
