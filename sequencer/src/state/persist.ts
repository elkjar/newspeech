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
  type Arrangement,
  type ArrangementRow,
  DEFAULT_ARRANGEMENT,
  type SequencerState,
  banksWithLiveActiveBank,
  resetSceneToFirstBank,
  resetSongToFirstSceneBank,
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
import { DEFAULT_DELAY_PARAMS, DELAY_DIVISIONS, type DelayParams } from '../audio/delay';
import { DEFAULT_SATURATION_PARAMS, type SaturationParams } from '../audio/saturation';
import { DEFAULT_MASTER_PARAMS, type MasterParams } from '../audio/master';
import { resetChordContext } from '../audio/chordContext';
import { resetPadDrift } from '../audio/padState';
import { resetBranchWalk } from '../audio/treeState';
import { resetStepAccumulators } from '../audio/accumulator';

interface PersistedState {
  version: number;
  // Song title (2026-07-06). Optional — older .seq files have no name and
  // load with a title derived from their filename by the caller. Sits right
  // after `version` so the title is the first thing visible when eyeballing
  // the JSON. parseSongFromSeq already reads this same field for .seqset
  // slot titles, so titled .seq files import into performance slots named.
  name?: string;
  bpm: number;
  rootNote: number;
  scale: Scale;
  tracks: Track[];
  lfos?: LFO[];
  midiOutDeviceId?: string | null;
  midiRecInputPort?: string | null;
  viewSection?: TrackSection;
  density?: number;
  chaos?: number;
  motion?: number;
  drift?: number;
  tension?: number;
  voicing?: number;
  tape?: TapeParams;
  glitch?: GlitchParams;
  reverb?: ReverbParams;
  delay?: DelayParams;
  saturation?: SaturationParams;
  master?: MasterParams;
  banks?: (BankSlot | null)[];
  activeBank?: number | null;
  sceneGraph?: SceneGraphConfig;
  // Composition layer added 2026-05-20. Optional so older `.seq` files
  // load unchanged with an empty composition.
  composition?: Composition;
  // Song-mode linear arrangement added 2026-06-23. Optional so older `.seq`
  // files load with an empty arrangement.
  arrangement?: Arrangement;
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
  // Save at the top: the active bank/scene position is NOT persisted — a
  // loaded piece always starts at scene 1 / bank 1 (2026-05-29). Every scene
  // is reset to bank 1, and the top-level live state is serialized as scene 1 /
  // bank 1's content so it loads coherently with no load-time reset.
  const comp = compositionWithLiveActiveScene(s);
  const resetScenes = comp.scenes.map(resetSceneToFirstBank);
  const scene0 = resetScenes[0];
  const liveBanks = banksWithLiveActiveBank(s);
  const topTracks = scene0 ? scene0.tracks : liveBanks[0]?.tracks ?? s.tracks;
  const topBanks = scene0 ? scene0.banks : liveBanks;
  const data: PersistedState = {
    version: CURRENT_VERSION,
    name: s.songTitle ?? undefined,
    bpm: s.bpm,
    rootNote: s.rootNote,
    scale: s.scale,
    tracks: topTracks,
    lfos: s.lfos,
    midiOutDeviceId: s.midiOutDeviceId,
    midiRecInputPort: s.midiRecInputPort,
    viewSection: s.viewSection,
    density: s.density,
    chaos: s.chaos,
    motion: s.motion,
    drift: s.drift,
    tension: s.tension,
    voicing: s.voicing,
    tape: s.tape,
    glitch: s.glitch,
    reverb: s.reverb,
    delay: s.delay,
    saturation: s.saturation,
    master: s.master,
    banks: topBanks,
    activeBank: 0,
    sceneGraph: s.sceneGraph,
    composition: { ...comp, scenes: resetScenes, activeScene: scene0 ? 0 : comp.activeScene },
    // Reset the runtime cursor so a loaded project doesn't resume mid-row.
    arrangement: { ...s.arrangement, cursor: 0, displayCursor: 0, cursorStartStep: 0, pendingEnd: false },
  };
  return JSON.stringify(data, null, 2);
}

// The active scene is represented by the LIVE working state (s.tracks /
// s.banks / macros / sceneGraph), while composition.scenes[activeScene]
// holds the snapshot from when the scene was last snapped — stale the
// moment the user edits anything. applyScene never snaps the outgoing
// scene back, so without this the export's composition would carry the
// pre-edit snapshot for the scene currently on screen. Fold the live
// state into the active slot so an exported song round-trips every
// scene at its current state. No store mutation — the returned object is
// only used for serialization (JSON.stringify deep-copies).
function compositionWithLiveActiveScene(s: SequencerState): Composition {
  const { composition } = s;
  if (composition.activeScene === null) return composition;
  const scenes = composition.scenes.slice();
  scenes[composition.activeScene] = {
    tracks: s.tracks,
    // Fold the live pattern into the active bank slot too — the active
    // bank's step edits live in s.tracks, not s.banks[activeBank].
    banks: banksWithLiveActiveBank(s),
    activeBank: s.activeBank,
    macros: {
      density: s.density,
      chaos: s.chaos,
      motion: s.motion,
      drift: s.drift,
      tension: s.tension,
      voicing: s.voicing,
    },
    sceneGraph: s.sceneGraph,
  };
  return { ...composition, scenes };
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

export function hydrateDelay(v: unknown): DelayParams {
  const d = (v && typeof v === 'object' ? v : {}) as Partial<DelayParams>;
  return {
    timeDivision: DELAY_DIVISIONS.includes(d.timeDivision as DelayParams['timeDivision'])
      ? (d.timeDivision as DelayParams['timeDivision'])
      : DEFAULT_DELAY_PARAMS.timeDivision,
    feedback: clamp01(d.feedback, DEFAULT_DELAY_PARAMS.feedback),
    pingpong: clamp01(d.pingpong, DEFAULT_DELAY_PARAMS.pingpong),
    lofi: clamp01(d.lofi, DEFAULT_DELAY_PARAMS.lofi),
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
    : {}) as Partial<{ density: number; chaos: number; motion: number; drift: number; tension: number; voicing: number }>;
  const banks = hydrateBanks(o.banks, () => ({
    tracks,
    macros: {
      density: clamp01(macros.density),
      chaos: clamp01(macros.chaos),
      motion: clamp01(macros.motion, 0.5),
      drift: clamp01(macros.drift, 1),
      tension: clamp01(macros.tension),
      voicing: clamp01(macros.voicing),
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
      voicing: clamp01(macros.voicing),
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
  const voicing = clamp01(data.voicing);
  const banks = hydrateBanks(data.banks, () => ({
    tracks,
    macros: { density, chaos, motion, drift, tension, voicing },
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
    macros: { density, chaos, motion, drift, tension, voicing },
    sceneGraph: hydrateSceneGraph(data.sceneGraph),
  };
}

export function hydrateArrangement(raw: unknown): Arrangement {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_ARRANGEMENT };
  const o = raw as Partial<Arrangement>;
  const rows: ArrangementRow[] = Array.isArray(o.rows)
    ? o.rows.flatMap((r): ArrangementRow[] => {
        if (!r || typeof r !== 'object') return [];
        const scene = Math.max(0, Math.min(COMPOSITION_SLOT_COUNT - 1, Math.floor((r as ArrangementRow).scene ?? 0)));
        const bank = Math.max(0, Math.min(BANK_SLOT_COUNT - 1, Math.floor((r as ArrangementRow).bank ?? 0)));
        const bars = Math.max(1, Math.floor((r as ArrangementRow).bars ?? 4));
        const mutes = Array.isArray((r as ArrangementRow).mutes)
          ? (r as ArrangementRow).mutes.filter((t): t is string => typeof t === 'string')
          : [];
        return [{ scene, bank, bars, mutes }];
      })
    : [];
  return {
    rows,
    active: typeof o.active === 'boolean' ? o.active : false,
    cursor: 0,
    displayCursor: 0,
    cursorStartStep: 0,
    loop: typeof o.loop === 'boolean' ? o.loop : true,
    pendingEnd: false,
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

// Serialize the live state as a single Scene (.seqscene file). Only the
// scene-shape fields land in the file: tracks, banks, activeBank,
// macros, sceneGraph. Globals (bpm, root, scale, FX, LFOs) are
// excluded because scenes inherit those from their containing song.
interface PersistedScene {
  version: number;
  kind: 'scene';
  name?: string;
  tracks: Track[];
  banks: (BankSlot | null)[];
  activeBank: number | null;
  macros: { density: number; chaos: number; motion: number; drift: number; tension: number; voicing: number };
  sceneGraph: SceneGraphConfig;
}

export function exportSceneAsSeqscene(): string {
  const s = useSequencerStore.getState();
  // Serialize at bank 1 — the active-bank position isn't persisted.
  const scene = resetSceneToFirstBank({
    tracks: s.tracks,
    banks: banksWithLiveActiveBank(s),
    activeBank: s.activeBank,
    macros: { density: s.density, chaos: s.chaos, motion: s.motion, drift: s.drift, tension: s.tension, voicing: s.voicing },
    sceneGraph: s.sceneGraph,
  })!;
  const data: PersistedScene = {
    version: CURRENT_VERSION,
    kind: 'scene',
    tracks: scene.tracks,
    banks: scene.banks,
    activeBank: scene.activeBank,
    macros: scene.macros,
    sceneGraph: scene.sceneGraph,
  };
  return JSON.stringify(data, null, 2);
}

// Parse a `.seqscene` file into a Scene snapshot. Distinct from
// `parseSceneFromSeq` which extracts the active scene from a full song
// file — that path is the legacy fallback for files saved before the
// scene/song split (2026-05-24). New scene files use this strict path.
export function parseSceneFromSeqscene(json: string): Scene | null {
  let data: PersistedScene;
  try {
    data = JSON.parse(json) as PersistedScene;
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
  const macros = (data.macros ?? {}) as Partial<{
    density: number;
    chaos: number;
    motion: number;
    drift: number;
    tension: number;
    voicing: number;
  }>;
  const density = clamp01(macros.density);
  const chaos = clamp01(macros.chaos);
  const motion = clamp01(macros.motion, 0.5);
  const drift = clamp01(macros.drift, 1);
  const tension = clamp01(macros.tension);
  const voicing = clamp01(macros.voicing);
  const banks = hydrateBanks(data.banks, () => ({
    tracks,
    macros: { density, chaos, motion, drift, tension, voicing },
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
    name: typeof data.name === 'string' ? data.name : undefined,
    tracks,
    banks,
    activeBank,
    macros: { density, chaos, motion, drift, tension, voicing },
    sceneGraph: hydrateSceneGraph(data.sceneGraph),
  };
}

// Parse a `.seq` (or legacy `.seqcomp`) file into a Song snapshot. Both
// extensions carry the same JSON shape — full project state including
// tracks, banks, all scenes, and globals. `.seqcomp` was a short-lived
// intermediate name (2026-05-24) before we recognized `.seq` and the
// song format are literally the same thing; the import path accepts
// both. Distinct from `parseSceneFromSeqscene` — songs hold many
// scenes, scenes hold none.
export function parseSongFromSeq(json: string): Song | null {
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
  const voicing = clamp01(data.voicing);
  const banks = hydrateBanks(data.banks, () => ({
    tracks,
    macros: { density, chaos, motion, drift, tension, voicing },
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
  // Two input shapes reach here:
  //   - `.seq` files / standalone songs nest scenes under `composition`.
  //   - Songs stored inside a `.seqset` carry `scenes`/`activeScene`/
  //     `endsAfterLast` as FLAT top-level fields (the Song interface).
  // The flat Song fields already match the Composition shape, so fall
  // back to `data` itself when there's no nested composition — otherwise
  // every song round-tripped out of a performance loses its scenes +
  // active scene (symptom: "no active scene on first song" after loading
  // a .seqset).
  const composition = hydrateComposition(
    data.composition ?? data,
    tracks,
    banks,
  );
  // A Song stored in a .seqset carries its slot title as a flat `name`
  // field; .seq files have no name. Read it back so titles survive a
  // .seqset round-trip.
  const name = (data as { name?: unknown }).name;
  return {
    name: typeof name === 'string' ? name : undefined,
    tracks,
    banks,
    activeBank,
    macros: { density, chaos, motion, drift, tension, voicing },
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
    arrangement: hydrateArrangement(data.arrangement),
  };
}

// Legacy embedded-song .seqset shape (pre 2026-07-06) — full Song snapshots
// baked into the file. Still parsed on load; never written anymore.
interface PersistedPerformance {
  version: number;
  name?: string;
  songs: (Song | null)[];
  activeSong: number | null;
  tailOutBars: number;
}

// Reference-based .seqset (2026-07-06): the set persists PATHS to .seq files,
// not song bodies — songs resolve fresh from disk at set load, so editing a
// .seq updates every set that references it. `path` is absolute; `rel` is
// relative to the .seqset's own folder so a moved/synced folder still
// resolves. Slot titles live on the ref (they're set metadata, not song data).
export interface SeqsetSongRef {
  path: string;
  rel?: string;
  name?: string;
}

interface PersistedSeqset {
  version: number;
  name?: string;
  songRefs: (SeqsetSongRef | null)[];
  activeSong: number | null;
  tailOutBars: number;
}

function dirnameOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

function relativePath(fromDir: string, toPath: string): string {
  const a = fromDir.split('/').filter(Boolean);
  const b = toPath.split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return `${'../'.repeat(a.length - i)}${b.slice(i).join('/')}`;
}

export function resolveRelativePath(fromDir: string, rel: string): string {
  const parts = fromDir.split('/').filter(Boolean);
  for (const seg of rel.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`;
}

// Serialize a Song slot as standalone `.seq` text — the migration path for
// legacy embedded slots (saving an old set extracts each song to disk).
// Round-trips through the same PersistedState shape exportProject writes,
// reset to scene 1 / bank 1 like every saved song.
export function songToSeqText(song: Song): string {
  const s = resetSongToFirstSceneBank(song) ?? song;
  const data: PersistedState = {
    version: CURRENT_VERSION,
    name: s.name,
    bpm: s.bpm,
    rootNote: s.rootNote,
    scale: s.scale,
    tracks: s.tracks,
    lfos: s.lfos,
    density: s.macros.density,
    chaos: s.macros.chaos,
    motion: s.macros.motion,
    drift: s.macros.drift,
    tension: s.macros.tension,
    voicing: s.macros.voicing,
    banks: s.banks,
    activeBank: 0,
    sceneGraph: s.sceneGraph,
    composition: {
      scenes: s.scenes,
      activeScene: s.activeScene,
      pendingScene: null,
      endsAfterLast: s.endsAfterLast,
    },
    arrangement: s.arrangement ?? { ...DEFAULT_ARRANGEMENT },
  };
  return JSON.stringify(data, null, 2);
}

// The caller (PerformanceDialog save flow) guarantees every filled slot is
// file-backed before exporting — the active song auto-saved to its bound
// .seq, legacy embedded slots extracted via songToSeqText. A path-less slot
// here would silently drop from the set, so it's a bug upstream.
export function exportPerformance(setPath: string): string {
  const s = useSequencerStore.getState();
  const setDir = dirnameOf(setPath);
  const songRefs: (SeqsetSongRef | null)[] = s.performance.songs.map(
    (song, i) => {
      const path = s.performance.songPaths[i];
      if (!song || !path) return null;
      return { path, rel: relativePath(setDir, path), name: song.name };
    },
  );
  const data: PersistedSeqset = {
    version: CURRENT_VERSION,
    name: s.performance.name,
    songRefs,
    activeSong: s.performance.activeSong,
    tailOutBars: s.performance.tailOutBars,
  };
  return JSON.stringify(data, null, 2);
}

export type ParsedSeqset =
  | {
      kind: 'refs';
      name?: string;
      refs: (SeqsetSongRef | null)[];
      activeSong: number | null;
      tailOutBars: number;
    }
  | { kind: 'embedded'; performance: Performance };

// Both .seqset generations parse here: reference sets return their refs for
// the caller to resolve against disk (file IO stays out of persist); legacy
// embedded sets hydrate fully and come back as a ready Performance with no
// file backing (paths all null — saving extracts them).
export function parseSeqset(json: string): ParsedSeqset | null {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const d = data as Partial<PersistedSeqset>;
  if (Array.isArray(d.songRefs)) {
    const refs: (SeqsetSongRef | null)[] = Array.from(
      { length: PERFORMANCE_SLOT_COUNT },
      () => null,
    );
    for (let i = 0; i < Math.min(PERFORMANCE_SLOT_COUNT, d.songRefs.length); i++) {
      const raw = d.songRefs[i];
      if (!raw || typeof raw !== 'object' || typeof raw.path !== 'string' || !raw.path) {
        continue;
      }
      refs[i] = {
        path: raw.path,
        rel: typeof raw.rel === 'string' ? raw.rel : undefined,
        name: typeof raw.name === 'string' ? raw.name : undefined,
      };
    }
    const activeSong =
      typeof d.activeSong === 'number' &&
      Number.isFinite(d.activeSong) &&
      d.activeSong >= 0 &&
      d.activeSong < PERFORMANCE_SLOT_COUNT &&
      refs[d.activeSong]
        ? Math.floor(d.activeSong)
        : null;
    const tailOutBars =
      typeof d.tailOutBars === 'number' && Number.isFinite(d.tailOutBars)
        ? Math.max(0, Math.min(32, Math.floor(d.tailOutBars)))
        : 2;
    return {
      kind: 'refs',
      name: typeof d.name === 'string' ? d.name : undefined,
      refs,
      activeSong,
      tailOutBars,
    };
  }
  const legacy = parsePerformanceFromSeqset(json);
  return legacy ? { kind: 'embedded', performance: legacy } : null;
}

function parsePerformanceFromSeqset(json: string): Performance | null {
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
      // through stringify+parseSongFromSeq to reuse the full hydration
      // path — keeps voice-id migrations + positional-role defaults aligned
      // with the .seq import path.
      const text = JSON.stringify(raw);
      const song = parseSongFromSeq(text);
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
    name: typeof data.name === 'string' ? data.name : undefined,
    songs,
    // Embedded songs have no disk identity — saving the set extracts them
    // to .seq files and fills these in.
    songPaths: Array.from({ length: PERFORMANCE_SLOT_COUNT }, () => null),
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
  const voicing = clamp01(data.voicing);

  const banks = hydrateBanks(data.banks, () => ({
    tracks,
    macros: { density, chaos, motion, drift, tension, voicing },
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
    songTitle:
      typeof data.name === 'string' && data.name.trim() ? data.name : null,
    bpm: typeof data.bpm === 'number' ? data.bpm : 120,
    rootNote: typeof data.rootNote === 'number' ? data.rootNote : 60,
    scale: data.scale ?? 'major',
    tracks,
    lfos: hydrateLFOs(data.lfos),
    midiOutDeviceId:
      typeof data.midiOutDeviceId === 'string' || data.midiOutDeviceId === null
        ? data.midiOutDeviceId
        : null,
    midiRecInputPort:
      typeof data.midiRecInputPort === 'string' || data.midiRecInputPort === null
        ? data.midiRecInputPort
        : null,
    viewSection,
    density,
    chaos,
    motion,
    drift,
    tension,
    voicing,
    tape: hydrateTape(data.tape),
    glitch: hydrateGlitch(data.glitch),
    reverb: hydrateReverb(data.reverb),
    delay: hydrateDelay(data.delay),
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
    hoveredStep: null,
    sceneGraph: hydrateSceneGraph(data.sceneGraph),
    ghostBarsRemaining: 0,
    ghostTargetBars: 0,
    composition: hydrateComposition(data.composition, tracks, banks),
    arrangement: hydrateArrangement(data.arrangement),
    pendingArrangementBank: null,
    // Detach the set linkage: a standalone .seq replaces the live state, and
    // a still-active song slot would fold the imported project over that
    // unrelated slot on the next set export / song switch (see
    // songsWithLiveActiveSong + loadSong's outgoing snapSong).
    performance: {
      ...useSequencerStore.getState().performance,
      activeSong: null,
      pendingSong: null,
      tailOutBarsRemaining: 0,
    },
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
  resetBranchWalk();
  resetStepAccumulators();
  return true;
}

// Sanitize a user-supplied name into a filesystem-safe slug. Falls back
// to `<fallbackPrefix>-<timestampSlug>` when the name is empty or
// becomes empty after stripping non-portable characters. Shared between
// the song-save (Transport.tsx) and set-save (PerformanceDialog.tsx)
// paths so default filenames stay consistent.
export function filenameSlug(
  name: string | undefined,
  fallbackPrefix: string,
): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return `${fallbackPrefix}-${timestampSlug()}`;
  const slug = trimmed.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || `${fallbackPrefix}-${timestampSlug()}`;
}

export function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
