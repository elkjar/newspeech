import {
  useSequencerStore,
  BANK_SLOT_COUNT,
  COMPOSITION_SLOT_COUNT,
  PERFORMANCE_SLOT_COUNT,
  DEFAULT_SCENE_GRAPH,
  type Track,
  type TrackSection,
  type BankSlot,
  type SceneGraphConfig,
  type Composition,
  type Scene,
  type Song,
  type Performance,
} from './store';
import {
  ensureBothSections,
  hydrateTrack,
  hydrateLFOs,
  hydrateBanks,
  applyPositionalRoleDefaults,
} from './hydrate';
import { type LFO } from '../audio/lfo';
import type { Scale } from '../audio/scale';
import { DEFAULT_TAPE_PARAMS, type TapeParams } from '../audio/tape';
import { DEFAULT_GLITCH_PARAMS, type GlitchParams } from '../audio/glitch';
import { DEFAULT_REVERB_PARAMS, type ReverbParams } from '../audio/reverb';
import { DEFAULT_SATURATION_PARAMS, type SaturationParams } from '../audio/saturation';
import { DEFAULT_MASTER_PARAMS, type MasterParams } from '../audio/master';
import { resetChordContext } from '../audio/chordContext';
import { resetPadDrift } from '../audio/padState';
// resetTrackFilters lives in the WebAudio chain (`./audio/trackFilter`).
// Loaded via dynamic import below so the Tauri build (where per-track
// filters are in Rust) doesn't statically bundle it.

interface PersistedState {
  version: number;
  bpm: number;
  rootNote: number;
  scale: Scale;
  tracks: Track[];
  lfos?: LFO[];
  midiOutDeviceId?: string | null;
  viewSection?: TrackSection;
  density?: number;
  chaos?: number;
  motion?: number;
  drift?: number;
  tension?: number;
  tape?: TapeParams;
  glitch?: GlitchParams;
  reverb?: ReverbParams;
  saturation?: SaturationParams;
  master?: MasterParams;
  banks?: (BankSlot | null)[];
  activeBank?: number | null;
  sceneGraph?: SceneGraphConfig;
  // Composition layer added 2026-05-20. Optional so older `.seq` files
  // load unchanged with an empty composition.
  composition?: Composition;
}

function clamp01(v: unknown, fallback = 0.5): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.max(0, Math.min(1, v))
    : fallback;
}

// v3 (2026-05-11): ChordVoicing schema swapped to scale-degree-driven model
// `{degree, extension, inversion, spread}` — the old `{type, inversion, spread}`
// shape is rejected by `parseChordVoicing` so v2 plocks load as undefined and
// the position-based defaulting fills in `{degree: 1, triad}` for the first
// melodic row and `{degree: 0}` (single note) for everything else. Users with
// v2 chord plocks lose them at load time — migration is destructive by design,
// since chord type alone doesn't carry the scale degree info needed to
// reconstruct the user's intent for the new scale-relative model.
const CURRENT_VERSION = 3;

export function exportProject(): string {
  const s = useSequencerStore.getState();
  const data: PersistedState = {
    version: CURRENT_VERSION,
    bpm: s.bpm,
    rootNote: s.rootNote,
    scale: s.scale,
    tracks: s.tracks,
    lfos: s.lfos,
    midiOutDeviceId: s.midiOutDeviceId,
    viewSection: s.viewSection,
    density: s.density,
    chaos: s.chaos,
    motion: s.motion,
    drift: s.drift,
    tension: s.tension,
    tape: s.tape,
    glitch: s.glitch,
    reverb: s.reverb,
    saturation: s.saturation,
    master: s.master,
    banks: s.banks,
    activeBank: s.activeBank,
    sceneGraph: s.sceneGraph,
    composition: s.composition,
  };
  return JSON.stringify(data, null, 2);
}

export function hydrateTape(v: unknown): TapeParams {
  const t = (v && typeof v === 'object' ? v : {}) as Partial<TapeParams> & {
    stretch?: number;
    geneRate?: number;
    geneMix?: number;
  };
  // Old saves had a single `stretch` field — fall it forward to stretch1.
  const legacyStretch =
    typeof t.stretch === 'number' && Number.isFinite(t.stretch)
      ? Math.max(0, Math.min(1, t.stretch))
      : null;
  return {
    position: clamp01(t.position, DEFAULT_TAPE_PARAMS.position),
    length: clamp01(t.length, DEFAULT_TAPE_PARAMS.length),
    reverse:
      typeof t.reverse === 'boolean' ? t.reverse : DEFAULT_TAPE_PARAMS.reverse,
    // hold is a performance gesture — never restore from save
    hold: false,
    stretch1: clamp01(
      t.stretch1 ?? legacyStretch ?? undefined,
      DEFAULT_TAPE_PARAMS.stretch1
    ),
    gain1: clamp01(t.gain1, DEFAULT_TAPE_PARAMS.gain1),
    stretch2: clamp01(t.stretch2, DEFAULT_TAPE_PARAMS.stretch2),
    gain2: clamp01(t.gain2, DEFAULT_TAPE_PARAMS.gain2),
    // Old saves used `geneRate` / `geneMix` — fall them forward.
    grainRate: clamp01(
      t.grainRate ?? t.geneRate,
      DEFAULT_TAPE_PARAMS.grainRate
    ),
    grainMix: clamp01(
      t.grainMix ?? t.geneMix,
      DEFAULT_TAPE_PARAMS.grainMix
    ),
    mix: clamp01(t.mix, DEFAULT_TAPE_PARAMS.mix),
  };
}

export function hydrateGlitch(v: unknown): GlitchParams {
  const g = (v && typeof v === 'object' ? v : {}) as Partial<GlitchParams>;
  return {
    chance: clamp01(g.chance, DEFAULT_GLITCH_PARAMS.chance),
    mix: clamp01(g.mix, DEFAULT_GLITCH_PARAMS.mix),
  };
}

export function hydrateReverb(v: unknown): ReverbParams {
  const r = (v && typeof v === 'object' ? v : {}) as Partial<ReverbParams>;
  return {
    size: clamp01(r.size, DEFAULT_REVERB_PARAMS.size),
    mix: clamp01(r.mix, DEFAULT_REVERB_PARAMS.mix),
    diffusion: clamp01(r.diffusion, DEFAULT_REVERB_PARAMS.diffusion),
    damping: clamp01(r.damping, DEFAULT_REVERB_PARAMS.damping),
  };
}

export function hydrateSaturation(v: unknown): SaturationParams {
  const s = (v && typeof v === 'object' ? v : {}) as Partial<SaturationParams>;
  return {
    preDrive: clamp01(s.preDrive, DEFAULT_SATURATION_PARAMS.preDrive),
  };
}

// Composition layer. v1 = each scene is a self-contained snapshot of
// tracks + banks + activeBank + macros + sceneGraph. Old `.seq` files
// (no composition field) load as an empty composition; the active state
// loaded from the file body IS the implicit "current scene" until the
// user starts snapping scenes into the composition.
function hydrateScene(
  raw: unknown,
  fallbackTracks: Track[],
  fallbackBanks: (BankSlot | null)[],
): Scene | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Partial<Scene> & { tracks?: unknown; banks?: unknown };
  if (!Array.isArray(o.tracks)) return null;
  // Hydrate tracks the same way the top-level loader does — preserves
  // voice id migrations, default-value backfills, etc.
  const tracks = (o.tracks as Array<Partial<Track>>)
    .filter((t): t is Partial<Track> & { id: string } => !!t && typeof t.id === 'string')
    .map(hydrateTrack);
  if (tracks.length === 0) return null;
  const macros = (o.macros && typeof o.macros === 'object'
    ? o.macros
    : {}) as Partial<{ density: number; chaos: number; motion: number; drift: number; tension: number }>;
  const banks = hydrateBanks(o.banks, () => ({
    tracks,
    macros: {
      density: clamp01(macros.density),
      chaos: clamp01(macros.chaos),
      motion: clamp01(macros.motion, 0.5),
      drift: clamp01(macros.drift, 1),
      tension: clamp01(macros.tension),
    },
  }));
  const activeBank =
    typeof o.activeBank === 'number' && Number.isFinite(o.activeBank)
      ? Math.max(0, Math.min(BANK_SLOT_COUNT - 1, Math.floor(o.activeBank)))
      : null;
  return {
    name: typeof o.name === 'string' ? o.name : undefined,
    tracks: tracks.length > 0 ? tracks : fallbackTracks,
    banks: banks.length > 0 ? banks : fallbackBanks,
    activeBank,
    macros: {
      density: clamp01(macros.density),
      chaos: clamp01(macros.chaos),
      motion: clamp01(macros.motion, 0.5),
      drift: clamp01(macros.drift, 1),
      tension: clamp01(macros.tension),
    },
    sceneGraph: hydrateSceneGraph(o.sceneGraph),
  };
}

// Parse a `.seq` file and extract its active state as a Scene snapshot
// WITHOUT touching the live store. Used by the "import scene from file"
// flow — author a scene in isolation, save it as `.seq`, then pull it
// into a composition slot here without losing what's currently on screen.
export function parseSceneFromSeq(json: string): Scene | null {
  let data: PersistedState;
  try {
    data = JSON.parse(json) as PersistedState;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (!Array.isArray(data.tracks)) return null;
  const rawTracks = data.tracks as Array<Partial<Track> & { id: string }>;
  const tracks = applyPositionalRoleDefaults(
    ensureBothSections(
      rawTracks
        .filter((t): t is Partial<Track> & { id: string } => !!t && typeof t.id === 'string')
        .map(hydrateTrack),
    ),
    rawTracks,
  );
  if (tracks.length === 0) return null;
  const density = clamp01(data.density);
  const chaos = clamp01(data.chaos);
  const motion = clamp01(data.motion, 0.5);
  const drift = clamp01(data.drift, 1);
  const tension = clamp01(data.tension);
  const banks = hydrateBanks(data.banks, () => ({
    tracks,
    macros: { density, chaos, motion, drift, tension },
  }));
  const requestedActive =
    typeof data.activeBank === 'number' && Number.isFinite(data.activeBank)
      ? Math.floor(data.activeBank)
      : 0;
  const activeBank =
    requestedActive >= 0 && requestedActive < BANK_SLOT_COUNT
      ? requestedActive
      : null;
  return {
    tracks,
    banks,
    activeBank,
    macros: { density, chaos, motion, drift, tension },
    sceneGraph: hydrateSceneGraph(data.sceneGraph),
  };
}

export function hydrateComposition(
  raw: unknown,
  fallbackTracks: Track[],
  fallbackBanks: (BankSlot | null)[],
): Composition {
  const empty: Composition = {
    scenes: Array.from({ length: COMPOSITION_SLOT_COUNT }, () => null),
    activeScene: null,
    pendingScene: null,
    endsAfterLast: true,
  };
  if (!raw || typeof raw !== 'object') return empty;
  const o = raw as Partial<Composition> & { scenes?: unknown };
  const scenes: (Scene | null)[] = Array.from(
    { length: COMPOSITION_SLOT_COUNT },
    () => null,
  );
  if (Array.isArray(o.scenes)) {
    for (let i = 0; i < Math.min(COMPOSITION_SLOT_COUNT, o.scenes.length); i++) {
      scenes[i] = hydrateScene(o.scenes[i], fallbackTracks, fallbackBanks);
    }
  }
  const activeScene =
    typeof o.activeScene === 'number' &&
    Number.isFinite(o.activeScene) &&
    o.activeScene >= 0 &&
    o.activeScene < COMPOSITION_SLOT_COUNT &&
    scenes[o.activeScene]
      ? Math.floor(o.activeScene)
      : null;
  return {
    scenes,
    activeScene,
    pendingScene: null,
    endsAfterLast: o.endsAfterLast !== false,
  };
}

// Parse a `.seqcomp` (or legacy `.seq`) file into a Song snapshot. A
// .seq file already serializes a full composition (tracks + banks +
// scenes + bpm + root + scale + sceneGraph), so the same parser
// handles both extensions — the distinction is purely about user-
// facing semantics (one song file = one piece of music).
export function parseSongFromSeqcomp(json: string): Song | null {
  let data: PersistedState;
  try {
    data = JSON.parse(json) as PersistedState;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  if (!Array.isArray(data.tracks)) return null;
  const rawTracks = data.tracks as Array<Partial<Track> & { id: string }>;
  const tracks = applyPositionalRoleDefaults(
    ensureBothSections(
      rawTracks
        .filter((t): t is Partial<Track> & { id: string } => !!t && typeof t.id === 'string')
        .map(hydrateTrack),
    ),
    rawTracks,
  );
  if (tracks.length === 0) return null;
  const density = clamp01(data.density);
  const chaos = clamp01(data.chaos);
  const motion = clamp01(data.motion, 0.5);
  const drift = clamp01(data.drift, 1);
  const tension = clamp01(data.tension);
  const banks = hydrateBanks(data.banks, () => ({
    tracks,
    macros: { density, chaos, motion, drift, tension },
  }));
  const requestedActive =
    typeof data.activeBank === 'number' && Number.isFinite(data.activeBank)
      ? Math.floor(data.activeBank)
      : 0;
  const activeBank =
    requestedActive >= 0 && requestedActive < BANK_SLOT_COUNT
      ? requestedActive
      : null;
  const sceneGraph = hydrateSceneGraph(data.sceneGraph);
  const composition = hydrateComposition(data.composition, tracks, banks);
  return {
    tracks,
    banks,
    activeBank,
    macros: { density, chaos, motion, drift, tension },
    sceneGraph,
    scenes: composition.scenes,
    activeScene: composition.activeScene,
    endsAfterLast: composition.endsAfterLast,
    bpm: typeof data.bpm === 'number' && Number.isFinite(data.bpm) ? data.bpm : 120,
    rootNote:
      typeof data.rootNote === 'number' && Number.isFinite(data.rootNote)
        ? data.rootNote
        : 60,
    scale: data.scale ?? 'major',
    lfos: hydrateLFOs(data.lfos),
  };
}

interface PersistedPerformance {
  version: number;
  songs: (Song | null)[];
  activeSong: number | null;
  tailOutBars: number;
}

export function exportPerformance(): string {
  const s = useSequencerStore.getState();
  const data: PersistedPerformance = {
    version: CURRENT_VERSION,
    songs: s.performance.songs,
    activeSong: s.performance.activeSong,
    tailOutBars: s.performance.tailOutBars,
  };
  return JSON.stringify(data, null, 2);
}

export function parsePerformanceFromSeqset(json: string): Performance | null {
  let data: PersistedPerformance;
  try {
    data = JSON.parse(json) as PersistedPerformance;
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const songs: (Song | null)[] = Array.from(
    { length: PERFORMANCE_SLOT_COUNT },
    () => null,
  );
  if (Array.isArray(data.songs)) {
    for (let i = 0; i < Math.min(PERFORMANCE_SLOT_COUNT, data.songs.length); i++) {
      const raw = data.songs[i];
      if (!raw) continue;
      // Each song is already a Song shape (we wrote it ourselves). Round-trip
      // through stringify+parseSongFromSeqcomp to reuse the full hydration
      // path — keeps voice-id migrations + positional-role defaults aligned
      // with the .seqcomp import path.
      const text = JSON.stringify(raw);
      const song = parseSongFromSeqcomp(text);
      songs[i] = song;
    }
  }
  const activeSong =
    typeof data.activeSong === 'number' &&
    Number.isFinite(data.activeSong) &&
    data.activeSong >= 0 &&
    data.activeSong < PERFORMANCE_SLOT_COUNT &&
    songs[data.activeSong]
      ? Math.floor(data.activeSong)
      : null;
  const tailOutBars =
    typeof data.tailOutBars === 'number' && Number.isFinite(data.tailOutBars)
      ? Math.max(0, Math.min(32, Math.floor(data.tailOutBars)))
      : 2;
  return {
    songs,
    activeSong,
    pendingSong: null,
    tailOutBarsRemaining: 0,
    tailOutBars,
  };
}

// Ghost config. Dwell bars clamped 1..256 — enough range to span
// "shimmer for a couple bars" through "settle for several minutes at 120
// bpm". transitionBars clamped 0..32 (0 = atomic snap, anything past 32
// is musically eccentric).
export function hydrateSceneGraph(v: unknown): SceneGraphConfig {
  const sg = (v && typeof v === 'object' ? v : {}) as Partial<SceneGraphConfig>;
  const minRaw =
    typeof sg.minBars === 'number' && Number.isFinite(sg.minBars)
      ? Math.max(1, Math.min(256, Math.floor(sg.minBars)))
      : DEFAULT_SCENE_GRAPH.minBars;
  const maxRaw =
    typeof sg.maxBars === 'number' && Number.isFinite(sg.maxBars)
      ? Math.max(1, Math.min(256, Math.floor(sg.maxBars)))
      : DEFAULT_SCENE_GRAPH.maxBars;
  const transRaw =
    typeof sg.transitionBars === 'number' && Number.isFinite(sg.transitionBars)
      ? Math.max(0, Math.min(32, Math.floor(sg.transitionBars)))
      : DEFAULT_SCENE_GRAPH.transitionBars;
  const shape =
    sg.shape === 'sustain' ||
    sg.shape === 'build' ||
    sg.shape === 'arc' ||
    sg.shape === 'wave' ||
    sg.shape === 'decay'
      ? sg.shape
      : DEFAULT_SCENE_GRAPH.shape;
  const phaseLength =
    typeof sg.phaseLength === 'number' && Number.isFinite(sg.phaseLength)
      ? Math.max(1, Math.min(1024, Math.floor(sg.phaseLength)))
      : DEFAULT_SCENE_GRAPH.phaseLength;
  const bankOrderMode =
    sg.bankOrderMode === 'entropy' || sg.bankOrderMode === 'sequence'
      ? sg.bankOrderMode
      : DEFAULT_SCENE_GRAPH.bankOrderMode;
  return {
    enabled: typeof sg.enabled === 'boolean' ? sg.enabled : DEFAULT_SCENE_GRAPH.enabled,
    minBars: Math.min(minRaw, maxRaw),
    maxBars: Math.max(minRaw, maxRaw),
    transitionBars: transRaw,
    shape,
    phaseLength,
    bankOrderMode,
  };
}

export function hydrateMaster(v: unknown): MasterParams {
  const m = (v && typeof v === 'object' ? v : {}) as Partial<MasterParams>;
  const loCutRaw =
    typeof m.loCut === 'number' && Number.isFinite(m.loCut)
      ? Math.floor(m.loCut)
      : DEFAULT_MASTER_PARAMS.loCut;
  const modeRaw =
    typeof m.mode === 'number' && Number.isFinite(m.mode)
      ? Math.floor(m.mode)
      : DEFAULT_MASTER_PARAMS.mode;
  const compAttackRaw =
    typeof m.compAttack === 'number' && Number.isFinite(m.compAttack)
      ? Math.floor(m.compAttack)
      : DEFAULT_MASTER_PARAMS.compAttack;
  const compReleaseRaw =
    typeof m.compRelease === 'number' && Number.isFinite(m.compRelease)
      ? Math.floor(m.compRelease)
      : DEFAULT_MASTER_PARAMS.compRelease;
  const biasClamped =
    typeof m.bias === 'number' && Number.isFinite(m.bias)
      ? Math.max(0, Math.min(0.2, m.bias))
      : DEFAULT_MASTER_PARAMS.bias;
  return {
    input: clamp01(m.input, DEFAULT_MASTER_PARAMS.input),
    loCut: Math.max(0, Math.min(3, loCutRaw)),
    comp: clamp01(m.comp, DEFAULT_MASTER_PARAMS.comp),
    compAttack: Math.max(0, Math.min(5, compAttackRaw)),
    compRelease: Math.max(0, Math.min(5, compReleaseRaw)),
    mode: Math.max(0, Math.min(3, modeRaw)),
    drive: clamp01(m.drive, DEFAULT_MASTER_PARAMS.drive),
    bias: biasClamped,
    mix: clamp01(m.mix, DEFAULT_MASTER_PARAMS.mix),
    hiCut: clamp01(m.hiCut, DEFAULT_MASTER_PARAMS.hiCut),
    trim: clamp01(m.trim, DEFAULT_MASTER_PARAMS.trim),
    gateEnabled:
      typeof m.gateEnabled === 'boolean'
        ? m.gateEnabled
        : DEFAULT_MASTER_PARAMS.gateEnabled,
    gateThreshold: clamp01(m.gateThreshold, DEFAULT_MASTER_PARAMS.gateThreshold),
    bypass: typeof m.bypass === 'boolean' ? m.bypass : DEFAULT_MASTER_PARAMS.bypass,
  };
}

export function importProject(json: string): boolean {
  let data: PersistedState;
  try {
    data = JSON.parse(json);
  } catch {
    return false;
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.tracks)) return false;

  const rawTracks = (data.tracks as unknown as Array<Partial<Track>>)
    .filter((t): t is Partial<Track> & { id: string } => !!t && typeof t.id === 'string');
  const hydratedTracks = applyPositionalRoleDefaults(
    ensureBothSections(rawTracks.map(hydrateTrack)),
    rawTracks
  );
  const tracks = hydratedTracks;
  const viewSection: TrackSection =
    data.viewSection === 'melodic' ? 'melodic' : 'drum';

  const density = clamp01(data.density);
  const chaos = clamp01(data.chaos);
  const motion = clamp01(data.motion, 0.5);
  const drift = clamp01(data.drift, 1);
  const tension = clamp01(data.tension);

  const banks = hydrateBanks(data.banks, () => ({
    tracks,
    macros: { density, chaos, motion, drift, tension },
  }));
  const requestedActive =
    typeof data.activeBank === 'number' && Number.isFinite(data.activeBank)
      ? Math.floor(data.activeBank)
      : 0;
  const activeBank =
    requestedActive >= 0 && requestedActive < BANK_SLOT_COUNT
      ? requestedActive
      : 0;

  useSequencerStore.setState({
    bpm: typeof data.bpm === 'number' ? data.bpm : 120,
    rootNote: typeof data.rootNote === 'number' ? data.rootNote : 60,
    scale: data.scale ?? 'major',
    tracks,
    lfos: hydrateLFOs(data.lfos),
    midiOutDeviceId:
      typeof data.midiOutDeviceId === 'string' || data.midiOutDeviceId === null
        ? data.midiOutDeviceId
        : null,
    viewSection,
    density,
    chaos,
    motion,
    drift,
    tension,
    tape: hydrateTape(data.tape),
    glitch: hydrateGlitch(data.glitch),
    reverb: hydrateReverb(data.reverb),
    saturation: hydrateSaturation(data.saturation),
    master: hydrateMaster(data.master),
    banks,
    activeBank,
    pendingBank: null,
    selectingLFO: null,
    globalStep: 0,
    sceneStartStep: 0,
    selectedStep: null,
    tieAnchor: null,
    sceneGraph: hydrateSceneGraph(data.sceneGraph),
    ghostBarsRemaining: 0,
    ghostTargetBars: 0,
    composition: hydrateComposition(data.composition, tracks, banks),
  });
  // Re-seed the chord context so followers (root-follow / chord-tone tracks)
  // have a sensible starting harmony before the chord master plays its first
  // step on the loaded project's scale.
  resetChordContext(
    typeof data.rootNote === 'number' ? data.rootNote : 60,
    data.scale ?? 'major'
  );
  // Pad voicing-drift counters keyed by trackId — the loaded project may
  // reuse track ids but the drift cadence shouldn't carry across loads.
  resetPadDrift();
  // Per-track filter graphs keyed by trackId — same reasoning. Disconnect +
  // clear so the loaded project starts with fresh filters rather than
  // inheriting cutoff/resonance/ring from the prior session's audio graph.
  // Web only: native track filters live in Rust and don't carry state across
  // project loads. Fire-and-forget — caller's load path doesn't depend on
  // the reset completing synchronously.
  void import('../audio/trackFilter')
    .then((m) => m.resetTrackFilters())
    .catch(() => { /* webChain not loaded yet — nothing to reset */ });
  return true;
}

export function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
