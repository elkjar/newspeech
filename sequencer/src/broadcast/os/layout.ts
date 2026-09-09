// Desktop layout — one rect per window, z-order, open flag. Persisted so the
// runner boots into the same arrangement every time; a saved layout is the
// broadcast layout.
//
// THE STAGE. The face is one fixed picture and the window shows it scaled
// uniformly to fit: a laptop shrinks it, the Studio Display grows it, type
// and grain scale with the windows (Chris 2026-09-08: position-only scaling
// left type small on a 5K; the laptop squashed the arrangement against the
// edges). Every rect here is in STAGE px; `useStage` is the fit (scale +
// letterbox offset) the desktop applies with one CSS transform and the
// drag/resize math divides by.
//
// TWO PICTURES (Chris 2026-09-09: "the CRT thing would just be swapping from
// 16:9 to 4:3"). The format follows the window's aspect, which the Rust side
// makes follow the display the window is on (main.rs): a 16:9 or 3:2 screen
// gets the 1512×850 desktop; a 4:3 screen — the CRT in the analog chain
// (BROADCAST → CRT → camcorder → capture) — gets an 800×600 picture with a
// 10% overscan safe area the windows stay inside, larger type (zoom, tunable
// while arranging) and no menubar on air. Each format keeps its own saved
// arrangement and backdrop flag.
import { create } from 'zustand';

export type Format = '16:9' | '4:3';

// The output look (Chris 2026-09-09) — for the ENTIRE operating-system
// picture, not the visual window: `signal` = the transmission overlay
// (scanlines, static, sync loss, grain); `clean` = nothing over the picture,
// no grain — for the CRT chain, where a real tube does all of this and grain
// would not survive the trip anyway. Saved per format: 16:9 defaults to
// signal, 4:3 to clean. (A WebGL "tube" pass on the visual window alone was
// built and pulled the same day — the looks are about the whole OS; the
// signal overlay renders better.)
export type Look = 'clean' | 'signal';
export const LOOKS: Look[] = ['clean', 'signal'];

export const MENUBAR_H = 28;

export interface Safe {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface FormatSpec {
  w: number;
  h: number;
  // Where windows may sit. 16:9: the whole picture under the menubar. 4:3:
  // the SD title-safe area — 10% in from every edge — because a CRT's
  // overscan and a camcorder's framing both eat the border.
  safe: Safe;
  // Content zoom for windows (CSS `zoom`): 4:3 defaults to 1.5 so 9–10 px
  // type is ~2.4% of picture height — about 11–12 lines on 480i (2 read
  // bigger but crushed the 300-px-wide windows' rows). Tunable while
  // arranging, saved per format.
  zoom: number;
  // Wordmark + clock bar on air. Off for the CRT (it would be 9% of the
  // height at zoom 2); it still shows while arranging for the windows menu.
  menubarOnAir: boolean;
  backdrop: boolean;
  look: Look;
  lsKey: string;
}

export const FORMATS: Record<Format, FormatSpec> = {
  '16:9': {
    w: 1512,
    h: 850,
    safe: { x: 0, y: MENUBAR_H, w: 1512, h: 850 - MENUBAR_H },
    zoom: 1,
    menubarOnAir: true,
    backdrop: false,
    look: 'signal',
    // v1 was window px (whatever screen it was saved on); v2 is stage px.
    lsKey: 'broadcast.layout.v2',
  },
  '4:3': {
    w: 800,
    h: 600,
    safe: { x: 80, y: 60, w: 640, h: 480 },
    zoom: 1.5,
    menubarOnAir: false,
    backdrop: true,
    look: 'clean',
    lsKey: 'broadcast.layout.43.v1',
  },
};

// Below this the display is called 4:3 (1.33, or 5:4 at 1.25). A MacBook is
// 3:2 (1.54) and stays 16:9-format; 16:10 is 1.6.
export const CRT_ASPECT_MAX = 1.45;
export function formatFor(W: number, H: number): Format {
  return W / Math.max(1, H) < CRT_ASPECT_MAX ? '4:3' : '16:9';
}

export interface StageFit {
  format: Format;
  w: number;
  h: number;
  scale: number;
  ox: number;
  oy: number;
}
export function fitStage(W = window.innerWidth, H = window.innerHeight): StageFit {
  const format = formatFor(W, H);
  const { w, h } = FORMATS[format];
  const scale = Math.min(W / w, H / h);
  return { format, w, h, scale, ox: Math.round((W - w * scale) / 2), oy: Math.round((H - h * scale) / 2) };
}
export const useStage = create<StageFit>(() => fitStage());

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
const DEFAULT_169: Record<WindowId, WinRect> = {
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

// The CRT picture: fewer windows, each big. The visual is the backdrop;
// ghost (the primary) fills the left of the safe area; now playing, banks
// and the ident stack on the right. Set, shape and sys are closed — the
// menubar's windows menu brings any back while arranging.
const DEFAULT_43: Record<WindowId, WinRect> = {
  ghost: { x: 80, y: 60, w: 300, h: 480, open: true, z: 1 },
  visual: { x: 396, y: 60, w: 324, h: 170, open: true, z: 2 },
  now: { x: 396, y: 60, w: 324, h: 180, open: true, z: 3 },
  banks: { x: 396, y: 252, w: 324, h: 136, open: true, z: 4 },
  set: { x: 396, y: 252, w: 324, h: 136, open: false, z: 5 },
  shape: { x: 396, y: 252, w: 324, h: 136, open: false, z: 6 },
  sys: { x: 396, y: 400, w: 324, h: 60, open: false, z: 7 },
  card: { x: 396, y: 400, w: 324, h: 140, open: true, z: 8 },
};

const DEFAULTS: Record<Format, Record<WindowId, WinRect>> = { '16:9': DEFAULT_169, '4:3': DEFAULT_43 };

const LS_KEY_V1 = 'broadcast.layout.v1';
const LS_SIGNAL = 'broadcast.layout.v2.signal';

function defaults(format: Format): Record<WindowId, WinRect> {
  const out = {} as Record<WindowId, WinRect>;
  const d = DEFAULTS[format];
  for (const id of Object.keys(d) as WindowId[]) out[id] = { ...d[id] };
  return out;
}

// Keep every window inside the format's safe area (a layout saved elsewhere
// would otherwise hide windows off the picture; on a CRT the border is lost
// to overscan).
export function clampToStage(windows: Record<WindowId, WinRect>, format: Format): Record<WindowId, WinRect> {
  const { safe } = FORMATS[format];
  const out = { ...windows };
  for (const id of Object.keys(out) as WindowId[]) {
    const r = { ...out[id] };
    r.w = Math.min(r.w, safe.w);
    r.h = Math.min(r.h, safe.h);
    r.x = Math.max(safe.x, Math.min(r.x, safe.x + safe.w - r.w));
    r.y = Math.max(safe.y, Math.min(r.y, safe.y + safe.h - r.h));
    out[id] = r;
  }
  return out;
}

function parseSaved(raw: string, k: number, format: Format): Record<WindowId, WinRect> {
  const parsed = JSON.parse(raw) as Partial<Record<WindowId, WinRect>>;
  const out = defaults(format);
  const d = DEFAULTS[format];
  for (const id of Object.keys(d) as WindowId[]) {
    const r = parsed[id];
    if (r && typeof r.x === 'number' && typeof r.w === 'number') {
      out[id] = { ...d[id], ...r, x: Math.round(r.x / k), y: Math.round(r.y / k), w: Math.round(r.w / k), h: Math.round(r.h / k) };
    }
  }
  return out;
}

// Mirror the layout to the console (→ Rust log via js_log) so the arrangement
// Chris makes by hand can be read back and baked in as the default.
let logTimer: number | null = null;
function logLayout(format: Format, windows: Record<WindowId, WinRect>, backdrop: boolean, zoom: number) {
  if (logTimer !== null) window.clearTimeout(logTimer);
  logTimer = window.setTimeout(() => {
    logTimer = null;
    const f = FORMATS[format];
    console.info(
      `[layout] ${format} stage ${f.w}x${f.h} in ${window.innerWidth}x${window.innerHeight} backdrop=${backdrop} zoom=${zoom} look=${useLayout.getState().look} ${JSON.stringify(windows)}`,
    );
  }, 800);
}

function load(format: Format): Record<WindowId, WinRect> {
  const { lsKey } = FORMATS[format];
  try {
    const raw = localStorage.getItem(lsKey);
    if (raw) return clampToStage(parseSaved(raw, 1, format), format);
    // Migrate a v1 (16:9) layout: it was saved in window px, most likely on
    // the window we are opening in now, so the stage fit of this window is
    // the best guess at the factor. Close enough to rearrange from.
    if (format === '16:9') {
      const v1 = localStorage.getItem(LS_KEY_V1);
      if (v1) {
        const out = clampToStage(parseSaved(v1, fitStage().scale, format), format);
        localStorage.setItem(lsKey, JSON.stringify(out));
        return out;
      }
    }
    return clampToStage(defaults(format), format);
  } catch {
    return clampToStage(defaults(format), format);
  }
}

function loadBackdrop(format: Format): boolean {
  const f = FORMATS[format];
  try {
    const v = localStorage.getItem(f.lsKey + '.backdrop');
    return v === null ? f.backdrop : v === '1';
  } catch {
    return f.backdrop;
  }
}

export const ZOOM_MIN = 1;
export const ZOOM_MAX = 3;
export const ZOOM_STEP = 0.25;
function loadZoom(format: Format): number {
  const f = FORMATS[format];
  try {
    const v = Number(localStorage.getItem(f.lsKey + '.zoom'));
    return v >= ZOOM_MIN && v <= ZOOM_MAX ? v : f.zoom;
  } catch {
    return f.zoom;
  }
}

function loadLook(format: Format): Look {
  const f = FORMATS[format];
  try {
    const v = localStorage.getItem(f.lsKey + '.look');
    if (v === 'clean' || v === 'signal') return v;
    if (v === 'tube') return 'signal'; // 0.1.8–0.1.12
    // The 09-08 signal on/off switch (16:9 only): off → clean.
    if (format === '16:9' && localStorage.getItem(LS_SIGNAL) === '0') return 'clean';
    return f.look;
  } catch {
    return f.look;
  }
}

interface LayoutState {
  format: Format;
  windows: Record<WindowId, WinRect>;
  // Visual behind everything, full-bleed, instead of in its window.
  backdrop: boolean;
  // Window content zoom (see FormatSpec.zoom).
  zoom: number;
  // What sits over the picture: see Look.
  look: Look;
  // Standby's "arrange windows": the desktop shows with every window up so
  // the layout can be set before going on air. Not persisted.
  arranging: boolean;
  move: (id: WindowId, x: number, y: number) => void;
  resize: (id: WindowId, w: number, h: number) => void;
  raise: (id: WindowId) => void;
  toggle: (id: WindowId) => void;
  setBackdrop: (v: boolean) => void;
  setZoom: (v: number) => void;
  setLook: (v: Look) => void;
  setArranging: (v: boolean) => void;
  // The window's aspect changed class (Rust refit the window to a new
  // display, or a browser resize): swap to that format's saved arrangement.
  setFormat: (f: Format) => void;
  reset: () => void;
  clamp: () => void;
}

function persist(format: Format, windows: Record<WindowId, WinRect>, backdrop: boolean, zoom: number) {
  logLayout(format, windows, backdrop, zoom);
  const { lsKey } = FORMATS[format];
  try {
    localStorage.setItem(lsKey, JSON.stringify(windows));
    localStorage.setItem(lsKey + '.backdrop', backdrop ? '1' : '0');
    localStorage.setItem(lsKey + '.zoom', String(zoom));
  } catch {
    // ignore
  }
}

const initialFormat = useStage.getState().format;

export const useLayout = create<LayoutState>((set, get) => ({
  format: initialFormat,
  windows: load(initialFormat),
  backdrop: loadBackdrop(initialFormat),
  zoom: loadZoom(initialFormat),
  look: loadLook(initialFormat),
  arranging: false,
  move: (id, x, y) =>
    set((s) => {
      const windows = { ...s.windows, [id]: { ...s.windows[id], x, y } };
      persist(s.format, windows, s.backdrop, s.zoom);
      return { windows };
    }),
  resize: (id, w, h) =>
    set((s) => {
      const windows = { ...s.windows, [id]: { ...s.windows[id], w: Math.max(120, w), h: Math.max(60, h) } };
      persist(s.format, windows, s.backdrop, s.zoom);
      return { windows };
    }),
  raise: (id) =>
    set((s) => {
      const top = Math.max(...Object.values(s.windows).map((r) => r.z)) + 1;
      if (s.windows[id].z === top - 1) return {};
      const windows = { ...s.windows, [id]: { ...s.windows[id], z: top } };
      persist(s.format, windows, s.backdrop, s.zoom);
      return { windows };
    }),
  toggle: (id) =>
    set((s) => {
      const top = Math.max(...Object.values(s.windows).map((r) => r.z)) + 1;
      const cur = s.windows[id];
      const windows = { ...s.windows, [id]: { ...cur, open: !cur.open, z: cur.open ? cur.z : top } };
      persist(s.format, windows, s.backdrop, s.zoom);
      return { windows };
    }),
  setBackdrop: (backdrop) => {
    const s = get();
    persist(s.format, s.windows, backdrop, s.zoom);
    set({ backdrop });
  },
  setZoom: (v) => {
    const zoom = Math.round(Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, v)) / ZOOM_STEP) * ZOOM_STEP;
    const s = get();
    persist(s.format, s.windows, s.backdrop, zoom);
    set({ zoom });
  },
  setLook: (look) => {
    const s = get();
    try {
      localStorage.setItem(FORMATS[s.format].lsKey + '.look', look);
    } catch {
      // ignore
    }
    console.info(`[layout] ${s.format} look=${look}`);
    set({ look });
  },
  setArranging: (arranging) => set({ arranging }),
  setFormat: (format) => {
    if (get().format === format) return;
    console.info(`[layout] format ${format} (window ${window.innerWidth}x${window.innerHeight})`);
    set({ format, windows: load(format), backdrop: loadBackdrop(format), zoom: loadZoom(format), look: loadLook(format) });
  },
  reset: () => {
    const s = get();
    const f = FORMATS[s.format];
    const windows = clampToStage(defaults(s.format), s.format);
    persist(s.format, windows, f.backdrop, f.zoom);
    set({ windows, backdrop: f.backdrop, zoom: f.zoom });
  },
  clamp: () => set((s) => ({ windows: clampToStage(s.windows, s.format) })),
}));

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    const fit = fitStage();
    useStage.setState(fit);
    useLayout.getState().setFormat(fit.format);
  });
  // Log the layout we booted with, once, so the current arrangement is
  // readable from the process log without touching anything.
  window.setTimeout(() => {
    const s = useLayout.getState();
    const f = FORMATS[s.format];
    console.info(
      `[layout] boot ${s.format} stage ${f.w}x${f.h} in ${window.innerWidth}x${window.innerHeight} backdrop=${s.backdrop} zoom=${s.zoom} look=${s.look} ${JSON.stringify(s.windows)}`,
    );
  }, 1500);
}
