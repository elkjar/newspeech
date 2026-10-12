// Channel strip — per-track mix processing on the track bus (see
// docs/channel-strip.md). P1 = EQ. Shape, defaults, hydration and the filter
// math the curve is drawn from; the DSP lives in Rust (audio.rs BusEq),
// pushed via nativeEngine.setChannelStripsBulk.
//
// Saved per TRACK SLOT in the .seq (`channelStrips`), outside the Track
// objects, so a bank swap never changes the mix.

export type EqType = 'hp' | 'lp' | 'bell' | 'lowshelf' | 'highshelf' | 'notch';

export interface EqBand {
  on: boolean;
  type: EqType;
  // Hz, 20..20000
  freq: number;
  // dB, ±18 (bell / shelves only)
  gainDb: number;
  q: number;
  // HP/LP only: 12 or 24 dB/oct
  slope: 12 | 24;
}

export interface ChannelStrip {
  // Whole-strip bypass (settings kept; the engine fades the strip out).
  bypass: boolean;
  // Always 6: [0] = HP, [1] = LP, [2..5] = parametric (bell/shelf/notch).
  eq: { bands: EqBand[] };
}

export const EQ_BAND_COUNT = 6;
export const EQ_FREQ_MIN = 20;
export const EQ_FREQ_MAX = 20000;
export const EQ_GAIN_MAX = 18;
export const EQ_Q_MIN = 0.1;
export const EQ_Q_MAX = 18;
export const EQ_PARAMETRIC_TYPES: EqType[] = ['bell', 'lowshelf', 'highshelf', 'notch'];

const DEFAULT_BANDS: EqBand[] = [
  { on: false, type: 'hp', freq: 40, gainDb: 0, q: 0.707, slope: 24 },
  { on: false, type: 'lp', freq: 16000, gainDb: 0, q: 0.707, slope: 12 },
  { on: false, type: 'lowshelf', freq: 120, gainDb: 0, q: 0.707, slope: 12 },
  { on: false, type: 'bell', freq: 500, gainDb: 0, q: 1, slope: 12 },
  { on: false, type: 'bell', freq: 2500, gainDb: 0, q: 1, slope: 12 },
  { on: false, type: 'highshelf', freq: 8000, gainDb: 0, q: 0.707, slope: 12 },
];

export function defaultChannelStrip(): ChannelStrip {
  return { bypass: false, eq: { bands: DEFAULT_BANDS.map((b) => ({ ...b })) } };
}

export function bandLabel(i: number): string {
  return i === 0 ? 'hp' : i === 1 ? 'lp' : String(i - 1);
}

const num = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;

function hydrateBand(v: unknown, i: number): EqBand {
  const d = DEFAULT_BANDS[i];
  const b = (v && typeof v === 'object' ? v : {}) as Partial<EqBand>;
  // HP/LP slots keep their type; parametric slots accept any parametric type.
  const type: EqType =
    i < 2
      ? d.type
      : EQ_PARAMETRIC_TYPES.includes(b.type as EqType)
        ? (b.type as EqType)
        : d.type;
  return {
    on: typeof b.on === 'boolean' ? b.on : d.on,
    type,
    freq: num(b.freq, EQ_FREQ_MIN, EQ_FREQ_MAX, d.freq),
    gainDb: num(b.gainDb, -EQ_GAIN_MAX, EQ_GAIN_MAX, d.gainDb),
    q: num(b.q, EQ_Q_MIN, EQ_Q_MAX, d.q),
    slope: b.slope === 12 || b.slope === 24 ? b.slope : d.slope,
  };
}

export function hydrateChannelStrip(v: unknown): ChannelStrip {
  const s = (v && typeof v === 'object' ? v : {}) as { bypass?: unknown; eq?: { bands?: unknown[] } };
  const raw = Array.isArray(s.eq?.bands) ? s.eq!.bands! : [];
  return {
    bypass: s.bypass === true,
    eq: { bands: Array.from({ length: EQ_BAND_COUNT }, (_, i) => hydrateBand(raw[i], i)) },
  };
}

// Missing / malformed → {} (every track flat), so old .seq files sound
// identical.
export function hydrateChannelStrips(v: unknown): Record<string, ChannelStrip> {
  const out: Record<string, ChannelStrip> = {};
  if (!v || typeof v !== 'object') return out;
  for (const [id, strip] of Object.entries(v as Record<string, unknown>)) {
    out[id] = hydrateChannelStrip(strip);
  }
  return out;
}

export function eqIsFlat(strip: ChannelStrip | undefined): boolean {
  return !strip || strip.bypass || strip.eq.bands.every((b) => !b.on);
}

// --- filter math (mirrors audio.rs `svf_coefs`) ---
//
// Simper/Cytomic trapezoidal SVF: out = m0·x + m1·band + m2·low, with
// g = tan(π·fc/sr) (shelves scale g by √A). Trapezoidal integration is the
// bilinear transform, so the digital response at f is the analog prototype
// H(s) = m0 + (m1·s + m2) / (s² + k·s + 1) at s = jΩ, Ω = tan(π·f/sr) / g.

interface SvfStage {
  g: number;
  k: number;
  m0: number;
  m1: number;
  m2: number;
}

const BUTTERWORTH_Q = Math.SQRT1_2;
// 4th-order Butterworth as two 2nd-order stages.
const BW4_Q = [0.5412, 1.3066];

export function bandStages(b: EqBand, sr: number): SvfStage[] {
  const fc = Math.min(Math.max(b.freq, EQ_FREQ_MIN), sr * 0.49);
  const g0 = Math.tan((Math.PI * fc) / sr);
  const A = Math.pow(10, b.gainDb / 40);
  const q = Math.max(EQ_Q_MIN, b.q);
  if (b.type === 'hp' || b.type === 'lp') {
    // 24 dB: Butterworth pair, the band's Q scales the resonant stage.
    const qs = b.slope === 24 ? [BW4_Q[0], BW4_Q[1] * (q / BUTTERWORTH_Q)] : [q];
    return qs.map((sq) => {
      const k = 1 / sq;
      return b.type === 'hp'
        ? { g: g0, k, m0: 1, m1: -k, m2: -1 }
        : { g: g0, k, m0: 0, m1: 0, m2: 1 };
    });
  }
  switch (b.type) {
    case 'bell': {
      const k = 1 / (q * A);
      return [{ g: g0, k, m0: 1, m1: k * (A * A - 1), m2: 0 }];
    }
    case 'lowshelf': {
      const k = 1 / q;
      return [{ g: g0 / Math.sqrt(A), k, m0: 1, m1: k * (A - 1), m2: A * A - 1 }];
    }
    case 'highshelf': {
      const k = 1 / q;
      return [{ g: g0 * Math.sqrt(A), k, m0: A * A, m1: k * (1 - A) * A, m2: 1 - A * A }];
    }
    case 'notch':
    default: {
      const k = 1 / q;
      return [{ g: g0, k, m0: 1, m1: -k, m2: 0 }];
    }
  }
}

// |H| in dB of one band at frequency f.
export function bandResponseDb(b: EqBand, f: number, sr: number): number {
  let mag = 1;
  const w = Math.tan((Math.PI * Math.min(f, sr * 0.499)) / sr);
  for (const st of bandStages(b, sr)) {
    const O = w / st.g;
    // den = (1 - Ω²) + j·k·Ω ; num = m0·den + m2 + j·m1·Ω
    const dr = 1 - O * O;
    const di = st.k * O;
    const nr = st.m0 * dr + st.m2;
    const ni = st.m0 * di + st.m1 * O;
    mag *= Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return 20 * Math.log10(Math.max(mag, 1e-6));
}

export function freqLabel(hz: number): string {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 1 : 2)}k` : `${Math.round(hz)}`;
}

// Knob ↔ value maps for the band controls (knobs are 0..1).
export const freqToNorm = (hz: number) =>
  Math.log(hz / EQ_FREQ_MIN) / Math.log(EQ_FREQ_MAX / EQ_FREQ_MIN);
export const normToFreq = (n: number) =>
  EQ_FREQ_MIN * Math.pow(EQ_FREQ_MAX / EQ_FREQ_MIN, Math.max(0, Math.min(1, n)));
export const qToNorm = (q: number) => Math.log(q / EQ_Q_MIN) / Math.log(EQ_Q_MAX / EQ_Q_MIN);
export const normToQ = (n: number) =>
  EQ_Q_MIN * Math.pow(EQ_Q_MAX / EQ_Q_MIN, Math.max(0, Math.min(1, n)));
