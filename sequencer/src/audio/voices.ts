export type VoiceCategory = 'drum' | 'melodic';

export interface MutationProfile {
  flipChance: number;
  velSpread: number;
  pitchJumpProb: number;
  pitchWeights: { octave: number; fifth: number; small: number };
  gateBias: number;
  gateSpread: number;
  // Asymmetric tie-flip rates (split 2026-05-24 — the old single
  // `tieFlipChance` made it as easy to create new chains as to break them,
  // which produced occasional full-bar tied notes when consecutive FNV
  // seeds happened to land below the threshold). OnChance is the rate at
  // which an authored-untied step flips ON → creating / extending a chain;
  // OffChance is the rate at which an authored-tied step flips OFF →
  // breaking a chain. Off should be HIGHER so mutation reads as adding
  // variety to existing chains, not building new long sustains.
  tieFlipOnChance: number;
  tieFlipOffChance: number;
  stepWeights?: number[];
  // Stage 7: probability the chord master applies a chord-aware mutation
  // (dropChordTone / borrowChord / shuffleInversion / shiftSpread) on a
  // given chord step. Only consulted when the track is the melodic-slot-0
  // chord master AND the step's voicing.degree > 0; ignored elsewhere.
  chordMutationChance: number;
}

export const DEFAULT_MUTATION: MutationProfile = {
  flipChance: 0.25,
  velSpread: 0.4,
  pitchJumpProb: 0.7,
  pitchWeights: { octave: 0.3, fifth: 0.3, small: 0.4 },
  gateBias: 0.4,
  gateSpread: 0.8,
  tieFlipOnChance: 0.05,
  tieFlipOffChance: 0.2,
  chordMutationChance: 0.35,
};

// Drums never pitch-jump via mutation. The internal-synth fallback ignores
// midiNote, but sample voices use playbackRate to pitch-shift — without a
// drum-specific profile here, mutation would dramatically retune kicks/snares.
export const DRUM_MUTATION: MutationProfile = {
  ...DEFAULT_MUTATION,
  pitchJumpProb: 0,
  pitchWeights: { octave: 0, fifth: 0, small: 0 },
  chordMutationChance: 0,
};

export const KICK_MUTATION: MutationProfile = {
  ...DRUM_MUTATION,
  // light pull toward quarter notes (1, 2, 3, 4 of each bar) without forbidding offbeats
  stepWeights: [1, 0.6, 0.6, 0.6, 1, 0.6, 0.6, 0.6, 1, 0.6, 0.6, 0.6, 1, 0.6, 0.6, 0.6],
};

export const HAT_O_MUTATION: MutationProfile = {
  ...DRUM_MUTATION,
  // bias placement to offbeats (the "and" of each beat in 16ths) — zeros elsewhere
  // automatically prevent sequential adjacency.
  stepWeights: [0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0],
};

export const BASS_MUTATION: MutationProfile = {
  flipChance: 0.15,
  velSpread: 0.35,
  pitchJumpProb: 0.5,
  pitchWeights: { octave: 0.1, fifth: 0.4, small: 0.5 },
  gateBias: 0.3,
  gateSpread: 0.6,
  tieFlipOnChance: 0.03,
  tieFlipOffChance: 0.15,
  chordMutationChance: 0,
};

// Pads sustain rather than flip rhythmically, never jump pitch (harmony comes
// from the published chord context, not mutation rolls), bias toward longer
// gates (more overlap → voicing-crossfade-via-long-release), and love chord-
// aware mutations (drop / borrow / shuffle / shift). Consulted only when the
// pad-type voice is on the chord-master row; non-master rows just see the
// rhythmic-mutation fields.
export const PAD_MUTATION: MutationProfile = {
  flipChance: 0.1,
  velSpread: 0.25,
  pitchJumpProb: 0,
  pitchWeights: { octave: 0, fifth: 0, small: 0 },
  gateBias: 0.7,
  gateSpread: 0.3,
  // Pads love sustain — the few ties they do shift should keep them long,
  // not chop them shorter. Keep off-rate modest to preserve the
  // crossfade-via-long-release character pads depend on.
  tieFlipOnChance: 0.02,
  tieFlipOffChance: 0.05,
  chordMutationChance: 0.55,
};

export interface VoiceEnvelope {
  attack: number;            // seconds; min 0.001 enforced at trigger time
  decay?: number;            // seconds; omitted = no decay phase, sustain stays at peak
  sustain?: number;          // 0..1, fraction of peak; default 1
  release: number;           // seconds; min 0.001 enforced at trigger time
}

export interface VoiceLoop {
  start: number;             // seconds into the buffer
  end: number;               // seconds into the buffer
}

// Open union — pad is the first category. Tagging a voice with `type: 'pad'`
// opts it into pad-type dispatch (custom mutations + built-in per-tone pan
// motion). All pad behaviour is keyed off this tag via `isPadVoice(id)`.
export type VoiceType = 'pad';

export interface PadConfig {
  // Auto-shuffle inversion or spread every N chord-master triggers (independent
  // of mutation knob rolls). 0 disables.
  voicingDriftEveryNTriggers: number;
  // Probability a drift event fires when the trigger-count cadence hits; below
  // 1 smooths the timing so it doesn't feel strictly metronomic.
  voicingDriftChance: number;
  voicingDriftAxis: 'inversion' | 'spread' | 'either';

  // Per-trigger chance a non-bass chord tone is dropped at dispatch (audible
  // only — followers still see the full chord via the published context).
  dropoutChance: number;
  // Weighting toward upper tones; 0 uniform, 1 always-top, soft-power between.
  dropoutUpperBias: number;

  // Each tone's gate is multiplied by random in [min, max]. Slight skew toward
  // >1 lets chord tones bloom rather than truncate.
  gateStagger: { min: number; max: number };

  // Independent slow LFO per tone. Rates and phase offsets indexed by tone
  // position mod length — prime-spaced so the field never re-aligns.
  panLfoRatesHz: number[];
  panLfoPhaseOffsetsRad: number[];
  // Max sweep from each tone's base (positional spread) pan position.
  panLfoDepth: number;
}

// Per-track audio-mix defaults applied when this voice is assigned to a
// track. Separate from VoiceDef.gain (which is a per-TRIGGER velocity trim
// stacking on manifest gain) — these write into track.filterCutoff / .fxSend
// / .gain / etc. Applied by the compose populate functions on initial
// assignment AND by setTrackSource when a user manually picks the voice.
// Only specified fields override; unspecified fields keep role / empty
// defaults so each voice contributes only the knobs it has opinions about.
export interface VoiceTrackDefaults {
  filterCutoff?: number;
  filterResonance?: number;
  fxSend?: number;
  gain?: number;
  pan?: number;
}

export interface VoiceDef {
  id: string;
  label: string;
  category: VoiceCategory;
  // Behavioral role — drives mutation profile + ghost entropy class via
  // role mapping. Independent of `category` (which is just drum vs.
  // melodic for dispatch routing) and `type` (which opts into specific
  // dispatch features like pad voicing-drift). When absent,
  // voiceMutation falls back to category-derived defaults.
  role?: VoiceRole;
  // Optional category tag; 'pad' opts the voice into pad dispatch in
  // samplePlayer and the chord-master voicing-drift hook in App.tsx.
  type?: VoiceType;
  mutationProfile?: MutationProfile;
  envelope?: VoiceEnvelope;  // opt-in ADSR shaping in samplePlayer; absent = play sample as-is
  loop?: VoiceLoop;          // opt-in looping; absent = source plays to end naturally
  // Per-voice default gain trim, applied at trigger time to velocity. For
  // sample voices this stacks on top of the manifest's `gain` field; for
  // synth voices this is the only intrinsic gain control. Used to dial in
  // perceived loudness parity across voices so chord assembly and master
  // bus aren't pushed into limiting by a hot voice. Absent = 1.0.
  gain?: number;
  // Per-voice natural-register shift, applied to the requested midiNote at
  // trigger time (integer octaves, semitones internally = octaveOffset * 12).
  // Composes additively with per-track `octave`. Used to anchor pad voices
  // in their intended low register without forcing per-track octave authoring.
  octaveOffset?: number;
  // Pad-specific tuning; required-in-spirit when type === 'pad'.
  padConfig?: PadConfig;
  // Per-track mix defaults applied on voice assignment (compose + manual).
  trackDefaults?: VoiceTrackDefaults;
  // Ghost entropy contribution score (0..1). Captures the spec stratification
  // "drones < pads < drums < percussion." Drone/pad voices read low (sustained,
  // little perceived rhythmic activity); drum + percussion voices read high
  // (transients, dense rhythmic energy). Optional — `voiceEntropyClass` falls
  // back to a category/type-derived default when absent so existing voice defs
  // keep working unchanged.
  entropyClass?: number;
}

// Defaults aimed at "obviously moving, obviously pad" per visible-defaults
// rule. The user tunes per-voice once they listen; centralized so first pad
// voice has a sensible starting point.
export const DEFAULT_PAD_CONFIG: PadConfig = {
  voicingDriftEveryNTriggers: 4,
  voicingDriftChance: 0.8,
  voicingDriftAxis: 'either',
  dropoutChance: 0.45,
  dropoutUpperBias: 0.7,
  gateStagger: { min: 0.85, max: 1.15 },
  panLfoRatesHz: [0.07, 0.11, 0.13, 0.17, 0.19, 0.23],
  panLfoPhaseOffsetsRad: [0, 1.7, 3.1, 4.6, 5.9, 2.3],
  panLfoDepth: 0.45,
};

// Static (non-sample) voices. Empty now — every voice is sample-backed and
// surfaced via manifestRegistry. Adding a new voice = drop a folder under
// public/samples/ or the user samples dir. Slot retained as the merge point
// in case a future pure-synth voice needs to live alongside sample voices.
// (`BASS_MUTATION` below is still exported for the MIDI bass-role instrument
// mutation lookup in instruments/library.ts.)
const STATIC_VOICES: VoiceDef[] = [];

// Cached merged voice list, invalidated when the manifestRegistry changes.
// The cache exists because `runTick` and `samplePlayer.trigger` call the
// `voiceX(id)` helpers in tight inner loops; rebuilding the list per call
// (~40 entries, but per-step × per-track × per-frame) would show up.
//
// The import from manifestRegistry is circular — manifestRegistry imports
// types and mutation constants from this file. Both modules are safe under
// the cycle because neither reads the cross-module binding at module-init
// time: this file only calls `deriveSampleVoices` / `subscribe` inside
// function bodies (executed after both modules finish initializing), and
// manifestRegistry only reads its imports from voices.ts inside its own
// function bodies.
import {
  deriveSampleVoices,
  subscribe as subscribeRegistry,
} from '../instruments/manifestRegistry';

let voicesCache: VoiceDef[] | null = null;
let unsubscribeRegistry: (() => void) | null = null;

function getCachedVoices(): VoiceDef[] {
  if (!unsubscribeRegistry) {
    unsubscribeRegistry = subscribeRegistry(() => {
      voicesCache = null;
    });
  }
  if (voicesCache === null) {
    voicesCache = [...STATIC_VOICES, ...deriveSampleVoices()];
  }
  return voicesCache;
}

// Clear the registry subscription + cache so the next module reload starts
// clean. Without this every HMR cycle of voices.ts (or any importer of it)
// would leave the previous cache-invalidation callback live in the registry's
// listener Set forever — silent leak (callback is cheap), but the Set grows
// unbounded across a long dev session.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (unsubscribeRegistry) {
      unsubscribeRegistry();
      unsubscribeRegistry = null;
    }
    voicesCache = null;
  });
}

/**
 * Returns the current merged voice list (static + registry-derived).
 * Reflects any kits registered up to the call time; updates when new kits
 * are registered via the manifestRegistry subscription. Always non-empty
 * (STATIC_VOICES guarantees at least `bass`).
 */
export function getVoices(): VoiceDef[] {
  return getCachedVoices();
}

export function voiceCategory(voiceId: string): VoiceCategory {
  return getCachedVoices().find((v) => v.id === voiceId)?.category ?? 'melodic';
}

export function isMelodicVoice(voiceId: string): boolean {
  return voiceCategory(voiceId) === 'melodic';
}

export function voiceLabel(voiceId: string): string {
  return getCachedVoices().find((v) => v.id === voiceId)?.label ?? voiceId;
}

// Role → profile mapping. Same shape as instrumentMutation's role switch
// so MIDI instruments and sample voices get the same behavior given the
// same role label. Per-voice `mutationProfile` overrides (e.g. KICK_MUTATION
// for specific kick voices) take precedence over the role default.
export function voiceMutation(voiceId: string): MutationProfile {
  const voice = getCachedVoices().find((v) => v.id === voiceId);
  if (!voice) return DEFAULT_MUTATION;
  if (voice.mutationProfile) return voice.mutationProfile;
  switch (voice.role) {
    case 'drum': return DRUM_MUTATION;
    case 'bass': return BASS_MUTATION;
    case 'pad': return PAD_MUTATION;
    case 'texture': return PAD_MUTATION;
    case 'lead': return DEFAULT_MUTATION;
    default:
      // No explicit role + no explicit profile. Fall back to category:
      // drum voices get DRUM_MUTATION (no pitch jump), everything else
      // gets DEFAULT_MUTATION (lead-shaped).
      return voice.category === 'drum' ? DRUM_MUTATION : DEFAULT_MUTATION;
  }
}


export function voiceEnvelope(voiceId: string): VoiceEnvelope | undefined {
  return getCachedVoices().find((v) => v.id === voiceId)?.envelope;
}

export function voiceLoop(voiceId: string): VoiceLoop | undefined {
  return getCachedVoices().find((v) => v.id === voiceId)?.loop;
}

export function voiceGain(voiceId: string): number {
  return getCachedVoices().find((v) => v.id === voiceId)?.gain ?? 1;
}

export function voiceOctaveOffset(voiceId: string): number {
  return getCachedVoices().find((v) => v.id === voiceId)?.octaveOffset ?? 0;
}

export function voiceType(voiceId: string): VoiceType | undefined {
  return getCachedVoices().find((v) => v.id === voiceId)?.type;
}

export function voicePadConfig(voiceId: string): PadConfig | undefined {
  return getCachedVoices().find((v) => v.id === voiceId)?.padConfig;
}

export function voiceTrackDefaults(voiceId: string): VoiceTrackDefaults | undefined {
  return getCachedVoices().find((v) => v.id === voiceId)?.trackDefaults;
}

export function isPadVoice(voiceId: string): boolean {
  return voiceType(voiceId) === 'pad';
}

// Role classification used to attach behavior (mutation profile, ghost
// entropy class) to a voice by what it IS, not which slot it lands in.
// Mirrors InstrumentRole on the MIDI side so the two sources share a
// mental model. Slot-position bass/anchor detection in the engine stays
// as a positional fallback, but role is the authoring intent.
//
// 'bass' added 2026-05-24 — previously the type was drum/pad/lead and
// sample voices "didn't carry bass distinction" (was per-track / slot-1
// positional). Now manifests can declare a bass voice explicitly so it
// gets BASS_MUTATION wherever it's slotted.
// 'texture' added 2026-05-26 — long sustained source material (field
// recordings, drones, processed loops) loaded from the `textures/`
// folder. Behaves pad-like for mutation/entropy, but is a distinct role
// so the transport-stop fade can target texture voices specifically
// (fade out over seconds) while everything else cuts immediately.
export type VoiceRole = 'drum' | 'bass' | 'lead' | 'pad' | 'texture';

/**
 * Coarse role bucket for a voice id. Returns the voice's explicit role
 * if declared, otherwise infers from category + type. Used by Ghost's
 * entropy formula diversity multiplier and by the mutation lookup.
 */
export function voiceRole(voiceId: string): VoiceRole {
  const v = getCachedVoices().find((vd) => vd.id === voiceId);
  if (!v) return 'lead';
  if (v.role) return v.role;
  if (v.category === 'drum') return 'drum';
  if (v.type === 'pad') return 'pad';
  return 'lead';
}

/**
 * Ghost entropy contribution for a voice id. Reads the voice's `entropyClass`
 * override when present; otherwise derives from category + type. Endpoints
 * stretched to 0..1 so the spec's "drones < pads < drums < percussion"
 * stratification produces meaningful absolute spread (was 0.20..0.75; new
 * range 0.05..1.0 makes a pure-drone bank read genuinely low and an all-
 * percussion bank read genuinely high).
 *   melodic + type=pad    → 0.05 (drones/pads — sustained, low perceived activity)
 *   melodic (no pad type) → 0.50 (leads, motifs, bass — mid)
 *   drum                  → 1.00 (percussion category — transients, high activity)
 * Unknown ids fall through to 0.50 (neutral melodic baseline).
 */
export function voiceEntropyClass(voiceId: string): number {
  const v = getCachedVoices().find((vd) => vd.id === voiceId);
  if (!v) return 0.5;
  if (typeof v.entropyClass === 'number') return v.entropyClass;
  // Role-driven first — bass voices anchor at 0.30 (low-freq, mid-low
  // entropy contribution) to match instrumentEntropyClass's bass slot.
  if (v.role === 'bass') return 0.3;
  if (v.role === 'pad') return 0.05;
  if (v.role === 'texture') return 0.05;
  if (v.role === 'drum') return 1;
  // Fallbacks for voices that don't declare a role: drum-category goes
  // percussion-tier, pad-typed voices go sustained-tier, everything else
  // sits at the neutral melodic baseline.
  if (v.category === 'drum') return 1;
  if (v.type === 'pad') return 0.05;
  return 0.5;
}
