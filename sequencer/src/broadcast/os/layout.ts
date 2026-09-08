// Desktop layout — one rect per window, z-order, open flag. Persisted so the
// runner boots into the same arrangement every time; a saved layout is the
// broadcast layout.
//
// THE STAGE. The face is one fixed picture — Chris's 1512×850 design screen
// (16:9) — and the window shows it scaled uniformly to fit: a laptop shrinks
// it, the Studio Display grows it, type and grain scale with the windows
// (Chris 2026-09-08: position-only scaling left type small on a 5K; the
// laptop squashed the arrangement against the edges). Every rect here is in
// STAGE px; `useStage` is the fit (scale + letterbox offset) the desktop
// applies with one CSS transform and the drag/resize math divides by.
import { create } from 'zustand';

export const STAGE_W = 1512;
export const STAGE_H = 850;
export const MENUBAR_H = 28;

export interface StageFit {
  scale: number;
  ox: number;
  oy: number;
}
export function fitStage(W = window.innerWidth, H = window.innerHeight): StageFit {
  const scale = Math.min(W / STAGE_W, H / STAGE_H);
  return { scale, ox: Math.round((W - STAGE_W * scale) / 2), oy: Math.round((H - STAGE_H * scale) / 2) };
}
export const useStage = create<StageFit>(() => fitStage());
if (typeof window !== 'undefined') window.addEventListener('resize', () => useStage.setState(fitStage()));

export type WindowId = 'set' | 'ghost' | 'banks' | 'shape' | 'now' | 'visual' | 'sys' | 'card';

export interface WinRect {
  x: number;
  y: number;
  w: number;
  h: number;
  open: boolean;
  z: number;
}

export const WINDOW_TITLES: Record<WindowId, string> = {
  set: 'set',
  ghost: 'ghost',
  banks: 'banks',
  shape: 'shape',
  now: 'now playing',
  visual: 'visual',
  sys: 'sys',
  card: 'ident',
};

export const WINDOW_ORDER: WindowId[] = ['ghost', 'visual', 'set', 'now', 'banks', 'shape', 'sys', 'card'];

// Chris's arrangement, laid out by hand on the 1512×850 stage (2026-09-08)
// under the 28px menubar.
const DEFAULT: Record<WindowId, WinRect> = {
  ghost: { x: 53, y: 218, w: 411, h: 592, open: true, z: 1 },
  visual: { x: 547, y: 72, w: 900, h: 520, open: true, z: 2 },
  now: { x: 1298, y: 56, w: 200, h: 284, open: true, z: 3 },
  set: { x: 447, y: 516, w: 298, h: 172, open: true, z: 4 },
  sys: { x: 391, y: 681, w: 483, h: 105, open: true, z: 5 },
  banks: { x: 1131, y: 654, w: 332, h: 137, open: true, z: 6 },
  shape: { x: 1286, y: 643, w: 200, h: 124, open: true, z: 7 },
  // The ident: shows only while a card is up (cards.ts), lower-left of the
  // visual like a lower-third. `open` false = idents off.
  card: { x: 566, y: 430, w: 400, h: 146, open: true, z: 8 },
};

// v1 was window px (whatever screen it was saved on); v2 is stage px.
const LS_KEY = 'broadcast.layout.v2';
const LS_KEY_V1 = 'broadcast.layout.v1';

function defaults(): Record<WindowId, WinRect> {
  const out = {} as Record<WindowId, WinRect>;
  for (const id of Object.keys(DEFAULT) as WindowId[]) out[id] = { ...DEFAULT[id] };
  return out;
}

// Keep every window on the stage (a layout saved elsewhere would otherwise
// hide windows off the picture).
export function clampToStage(windows: Record<WindowId, WinRect>): Record<WindowId, WinRect> {
  const out = { ...windows };
  for (const id of Object.keys(out) as WindowId[]) {
    const r = { ...out[id] };
    r.w = Math.min(r.w, STAGE_W - 8);
    r.h = Math.min(r.h, STAGE_H - MENUBAR_H - 8);
    r.x = Math.max(0, Math.min(r.x, STAGE_W - r.w));
    r.y = Math.max(MENUBAR_H, Math.min(r.y, STAGE_H - r.h));
    out[id] = r;
  }
  return out;
}

function parseSaved(raw: string, k: number): Record<WindowId, WinRect> {
  const parsed = JSON.parse(raw) as Partial<Record<WindowId, WinRect>>;
  const out = defaults();
  for (const id of Object.keys(DEFAULT) as WindowId[]) {
    const r = parsed[id];
    if (r && typeof r.x === 'number' && typeof r.w === 'number') {
      out[id] = { ...DEFAULT[id], ...r, x: Math.round(r.x / k), y: Math.round(r.y / k), w: Math.round(r.w / k), h: Math.round(r.h / k) };
    }
  }
  return out;
}

// Mirror the layout to the console (→ Rust log via js_log) so the arrangement
// Chris makes by hand can be read back and baked in as the default.
let logTimer: number | null = null;
function logLayout(windows: Record<WindowId, WinRect>, backdrop: boolean) {
  if (logTimer !== null) window.clearTimeout(logTimer);
  logTimer = window.setTimeout(() => {
    logTimer = null;
    console.info(`[layout] stage ${STAGE_W}x${STAGE_H} in ${window.innerWidth}x${window.innerHeight} backdrop=${backdrop} ${JSON.stringify(windows)}`);
  }, 800);
}

function load(): Record<WindowId, WinRect> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return clampToStage(parseSaved(raw, 1));
    // Migrate a v1 layout: it was saved in window px, most likely on the
    // window we are opening in now, so the stage fit of this window is the
    // best guess at the factor. Close enough to rearrange from.
    const v1 = localStorage.getItem(LS_KEY_V1);
    if (v1) {
      const out = clampToStage(parseSaved(v1, fitStage().scale));
      localStorage.setItem(LS_KEY, JSON.stringify(out));
      return out;
    }
    return clampToStage(defaults());
  } catch {
    return clampToStage(defaults());
  }
}

interface LayoutState {
  windows: Record<WindowId, WinRect>;
  // Visual behind everything, full-bleed, instead of in its window.
  backdrop: boolean;
  // The transmission layer (SignalOverlay): scanlines, static, sync loss.
  signal: boolean;
  // Standby's "arrange windows": the desktop shows with every window up so
  // the layout can be set before going on air. Not persisted.
  arranging: boolean;
  move: (id: WindowId, x: number, y: number) => void;
  resize: (id: WindowId, w: number, h: number) => void;
  raise: (id: WindowId) => void;
  toggle: (id: WindowId) => void;
  setBackdrop: (v: boolean) => void;
  setSignal: (v: boolean) => void;
  setArranging: (v: boolean) => void;
  reset: () => void;
  clamp: () => void;
}

function persist(windows: Record<WindowId, WinRect>, backdrop: boolean) {
  logLayout(windows, backdrop);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(windows));
    localStorage.setItem(LS_KEY + '.backdrop', backdrop ? '1' : '0');
  } catch {
    // ignore
  }
}

function loadBackdrop(): boolean {
  try {
    return localStorage.getItem(LS_KEY + '.backdrop') === '1';
  } catch {
    return false;
  }
}

// Signal defaults ON — the transmission is part of the face.
function loadSignal(): boolean {
  try {
    return localStorage.getItem(LS_KEY + '.signal') !== '0';
  } catch {
    return true;
  }
}

export const useLayout = create<LayoutState>((set, get) => ({
  windows: load(),
  backdrop: loadBackdrop(),
  signal: loadSignal(),
  arranging: false,
  move: (id, x, y) =>
    set((s) => {
      const windows = { ...s.windows, [id]: { ...s.windows[id], x, y } };
      persist(windows, s.backdrop);
      return { windows };
    }),
  resize: (id, w, h) =>
    set((s) => {
      const windows = { ...s.windows, [id]: { ...s.windows[id], w: Math.max(200, w), h: Math.max(90, h) } };
      persist(windows, s.backdrop);
      return { windows };
    }),
  raise: (id) =>
    set((s) => {
      const top = Math.max(...Object.values(s.windows).map((r) => r.z)) + 1;
      if (s.windows[id].z === top - 1) return {};
      const windows = { ...s.windows, [id]: { ...s.windows[id], z: top } };
      persist(windows, s.backdrop);
      return { windows };
    }),
  toggle: (id) =>
    set((s) => {
      const top = Math.max(...Object.values(s.windows).map((r) => r.z)) + 1;
      const cur = s.windows[id];
      const windows = { ...s.windows, [id]: { ...cur, open: !cur.open, z: cur.open ? cur.z : top } };
      persist(windows, s.backdrop);
      return { windows };
    }),
  setBackdrop: (backdrop) => {
    persist(get().windows, backdrop);
    set({ backdrop });
  },
  setSignal: (signal) => {
    try {
      localStorage.setItem(LS_KEY + '.signal', signal ? '1' : '0');
    } catch {
      // ignore
    }
    console.info(`[layout] signal=${signal}`);
    set({ signal });
  },
  setArranging: (arranging) => set({ arranging }),
  reset: () => {
    const windows = clampToStage(defaults());
    persist(windows, false);
    set({ windows, backdrop: false });
  },
  clamp: () => set((s) => ({ windows: clampToStage(s.windows) })),
}));

// Log the layout we booted with, once, so the current arrangement is readable
// from the process log without touching anything.
if (typeof window !== 'undefined') {
  window.setTimeout(() => {
    const s = useLayout.getState();
    console.info(`[layout] boot stage ${STAGE_W}x${STAGE_H} in ${window.innerWidth}x${window.innerHeight} backdrop=${s.backdrop} ${JSON.stringify(s.windows)}`);
  }, 1500);
}
