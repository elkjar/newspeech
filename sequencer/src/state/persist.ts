import {
  useSequencerStore,
  BANK_SLOT_COUNT,
  type Track,
  type TrackSection,
  type BankSlot,
} from './store';
import { ensureBothSections, hydrateTrack, hydrateLFOs, hydrateBanks } from './hydrate';
import { type LFO } from '../audio/lfo';
import type { Scale } from '../audio/scale';
import { DEFAULT_TAPE_PARAMS, type TapeParams } from '../audio/tape';
import { DEFAULT_GLITCH_PARAMS, type GlitchParams } from '../audio/glitch';
import { DEFAULT_REVERB_PARAMS, type ReverbParams } from '../audio/reverb';
import { DEFAULT_SATURATION_PARAMS, type SaturationParams } from '../audio/saturation';
import { DEFAULT_MASTER_PARAMS, type MasterParams } from '../audio/master';

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
}

function clamp01(v: unknown, fallback = 0.5): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.max(0, Math.min(1, v))
    : fallback;
}

const CURRENT_VERSION = 1;

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
  };
  return JSON.stringify(data, null, 2);
}

function hydrateTape(v: unknown): TapeParams {
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

function hydrateGlitch(v: unknown): GlitchParams {
  const g = (v && typeof v === 'object' ? v : {}) as Partial<GlitchParams>;
  return {
    chance: clamp01(g.chance, DEFAULT_GLITCH_PARAMS.chance),
    mix: clamp01(g.mix, DEFAULT_GLITCH_PARAMS.mix),
  };
}

function hydrateReverb(v: unknown): ReverbParams {
  const r = (v && typeof v === 'object' ? v : {}) as Partial<ReverbParams>;
  return {
    size: clamp01(r.size, DEFAULT_REVERB_PARAMS.size),
    mix: clamp01(r.mix, DEFAULT_REVERB_PARAMS.mix),
  };
}

function hydrateSaturation(v: unknown): SaturationParams {
  const s = (v && typeof v === 'object' ? v : {}) as Partial<SaturationParams>;
  return {
    preDrive: clamp01(s.preDrive, DEFAULT_SATURATION_PARAMS.preDrive),
  };
}

function hydrateMaster(v: unknown): MasterParams {
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

  const tracks = ensureBothSections(
    (data.tracks as unknown as Array<Partial<Track>>)
      .filter((t): t is Partial<Track> & { id: string } => !!t && typeof t.id === 'string')
      .map(hydrateTrack)
  );
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
    selectedStep: null,
    tieAnchor: null,
  });
  return true;
}

export function timestampSlug(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}
