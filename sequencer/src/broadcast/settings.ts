// Remembered launch — what a double-click has no other way to learn. The
// standby panel is the settings surface (Chris 2026-09-08: "the loading
// screen before GO could be a config to select folders for SEQ +
// interstitial + cards"); everything here persists in the app's own storage
// and a bare launch (no argv) resumes it. CLI flags override for one run and
// become the new remembered values.
import { create } from 'zustand';

export interface BroadcastSettings {
  setPaths: string[];
  // Explicit folders; null = look beside the set (BROADCAST/{SEQ, INTERSTITIALS, CARDS}).
  interstitialsDir: string | null;
  cardsDir: string | null;
  samplesDir: string | null;
  device: string | null;
  // Sign off after N songs; null = forever.
  songs: number | null;
  // Open with this song; null = random.
  first: string | null;
  autostart: boolean;
}

const LS_KEY = 'broadcast.settings.v1';

const DEFAULTS: BroadcastSettings = {
  setPaths: [],
  interstitialsDir: null,
  cardsDir: null,
  samplesDir: null,
  device: null,
  songs: null,
  first: null,
  autostart: false,
};

function load(): BroadcastSettings {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS };
    const o = JSON.parse(raw) as Partial<BroadcastSettings>;
    return {
      ...DEFAULTS,
      ...o,
      setPaths: Array.isArray(o.setPaths) ? o.setPaths.filter((p) => typeof p === 'string') : [],
      songs: typeof o.songs === 'number' && o.songs > 0 ? o.songs : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

interface SettingsState extends BroadcastSettings {
  update: (patch: Partial<BroadcastSettings>) => void;
}

export const useSettings = create<SettingsState>((set, get) => ({
  ...load(),
  update: (patch) => {
    set(patch);
    const s = get();
    const out: BroadcastSettings = {
      setPaths: s.setPaths,
      interstitialsDir: s.interstitialsDir,
      cardsDir: s.cardsDir,
      samplesDir: s.samplesDir,
      device: s.device,
      songs: s.songs,
      first: s.first,
      autostart: s.autostart,
    };
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(out));
    } catch {
      // ignore
    }
    console.info(`[settings] ${JSON.stringify(out)}`);
  },
}));

// Launch flags (parsed by BroadcastApp) laid over the remembered settings.
// Anything given on the command line wins and is remembered.
export function applyLaunchArgs(args: {
  set: string[];
  samples: string | null;
  device: string | null;
  songs: number | null;
  first: string | null;
  autostart: boolean;
}): BroadcastSettings {
  const patch: Partial<BroadcastSettings> = {};
  if (args.set.length) patch.setPaths = args.set;
  if (args.samples) patch.samplesDir = args.samples;
  if (args.device) patch.device = args.device;
  if (args.songs !== null) patch.songs = args.songs;
  if (args.first) patch.first = args.first;
  if (args.autostart) patch.autostart = true;
  if (Object.keys(patch).length) useSettings.getState().update(patch);
  const s = useSettings.getState();
  return {
    setPaths: s.setPaths,
    interstitialsDir: s.interstitialsDir,
    cardsDir: s.cardsDir,
    samplesDir: s.samplesDir,
    device: s.device,
    songs: s.songs,
    first: s.first,
    autostart: s.autostart,
  };
}

// Short display form of a path: last two segments.
export function shortPath(p: string | null, fallback = '—'): string {
  if (!p) return fallback;
  const parts = p.split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}
