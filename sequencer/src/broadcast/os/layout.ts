// Desktop layout — one rect per window, z-order, open flag. Persisted so the
// runner boots into the same arrangement every time; a saved layout is the
// broadcast layout. Positions are in px on the window's own coordinate space.
import { create } from 'zustand';

export type WindowId = 'set' | 'ghost' | 'banks' | 'shape' | 'now' | 'visual' | 'sys';

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
};

export const WINDOW_ORDER: WindowId[] = ['ghost', 'visual', 'set', 'now', 'banks', 'shape', 'sys'];

// Designed on 1920×1080 under a 28px menubar.
const DEFAULT: Record<WindowId, WinRect> = {
  ghost: { x: 24, y: 52, w: 560, h: 964, open: true, z: 7 },
  visual: { x: 610, y: 52, w: 900, h: 506, open: true, z: 1 },
  set: { x: 1536, y: 52, w: 360, h: 506, open: true, z: 2 },
  now: { x: 610, y: 584, w: 440, h: 250, open: true, z: 3 },
  banks: { x: 1076, y: 584, w: 434, h: 250, open: true, z: 4 },
  shape: { x: 1536, y: 584, w: 360, h: 250, open: true, z: 5 },
  sys: { x: 610, y: 860, w: 1286, h: 156, open: true, z: 6 },
};

const LS_KEY = 'broadcast.layout.v1';

// Default layout scaled from the 1920×1080 design to this screen.
function scaledDefault(): Record<WindowId, WinRect> {
  const k = Math.min(1, window.innerWidth / 1920, window.innerHeight / 1080);
  const out = {} as Record<WindowId, WinRect>;
  for (const id of Object.keys(DEFAULT) as WindowId[]) {
    const r = DEFAULT[id];
    out[id] = { ...r, x: Math.round(r.x * k), y: 28 + Math.round((r.y - 28) * k), w: Math.round(r.w * k), h: Math.round(r.h * k) };
  }
  return out;
}

// Keep every window inside the viewport (a layout saved on a bigger screen,
// or the design defaults on a laptop, would otherwise hide windows offscreen).
export function clampToViewport(windows: Record<WindowId, WinRect>): Record<WindowId, WinRect> {
  const W = window.innerWidth;
  const H = window.innerHeight;
  const out = { ...windows };
  for (const id of Object.keys(out) as WindowId[]) {
    const r = { ...out[id] };
    r.w = Math.min(r.w, W - 8);
    r.h = Math.min(r.h, H - 36);
    r.x = Math.max(0, Math.min(r.x, W - r.w));
    r.y = Math.max(28, Math.min(r.y, H - r.h));
    out[id] = r;
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
    console.info(`[layout] ${window.innerWidth}x${window.innerHeight} backdrop=${backdrop} ${JSON.stringify(windows)}`);
  }, 800);
}

function load(): Record<WindowId, WinRect> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return clampToViewport(scaledDefault());
    const parsed = JSON.parse(raw) as Partial<Record<WindowId, WinRect>>;
    const out = { ...DEFAULT };
    for (const id of Object.keys(DEFAULT) as WindowId[]) {
      const r = parsed[id];
      if (r && typeof r.x === 'number' && typeof r.w === 'number') out[id] = { ...DEFAULT[id], ...r };
    }
    return clampToViewport(out);
  } catch {
    return clampToViewport(scaledDefault());
  }
}

interface LayoutState {
  windows: Record<WindowId, WinRect>;
  // Visual behind everything, full-bleed, instead of in its window.
  backdrop: boolean;
  move: (id: WindowId, x: number, y: number) => void;
  resize: (id: WindowId, w: number, h: number) => void;
  raise: (id: WindowId) => void;
  toggle: (id: WindowId) => void;
  setBackdrop: (v: boolean) => void;
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

export const useLayout = create<LayoutState>((set, get) => ({
  windows: load(),
  backdrop: loadBackdrop(),
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
  reset: () => {
    const windows = clampToViewport(scaledDefault());
    persist(windows, false);
    set({ windows, backdrop: false });
  },
  clamp: () => set((s) => ({ windows: clampToViewport(s.windows) })),
}));

// Log the layout we booted with, once, so the current arrangement is readable
// from the process log without touching anything.
if (typeof window !== 'undefined') {
  window.setTimeout(() => {
    const s = useLayout.getState();
    console.info(`[layout] boot ${window.innerWidth}x${window.innerHeight} backdrop=${s.backdrop} ${JSON.stringify(s.windows)}`);
  }, 1500);
}
