import type { Track } from '../../state/store';

// Voice pools by role. Composer picks one voice per role per compose call so
// the resulting bank has consistent timbre across each row's lifetime. All
// IDs match the existing VOICES list — anything renamed/added there should be
// reflected here too. The curation lives in the sample library + Faust output
// chain (not in this taxonomy); these pools just sort the curated voices by
// the role they're best suited to.
const CHORD_MASTER_VOICES = [
  'rhodes-mk1',
  'soft-piano',
  'tape-piano',
  'under-piano',
  'encounter',
  'pulsed',
  'sinewaves-scope',
];

// Track.monophonic = true on bass tracks (set by populateBass) handles the
// retrigger choke for long-sustain voices like mini-moog when used as bass.
// The same voice stays polyphonic when picked for motif/flavor roles.
const BASS_VOICES = ['mini-moog'];

const MOTIF_VOICES = [
  'rhodes-mk1',
  'soft-piano',
  'tape-piano',
  'under-piano',
  'hydra-plaits',
  'mini-moog',
  'root-grain',
  'sinewaves-scope',
];

// Flavor voices — pad-y / atmospheric. Sit behind the rhythmic content as
// sustained layers, follow chord changes via chord-tone pitchInterp.
const FLAVOR_VOICES = [
  'encounter',
  'pulsed',
  'sinewaves-scope',
  'under-piano',
  'tape-piano',
];

// Drum kit layout — locked to ns-kit-1. Slot index = positional role:
//   0 kick / 1 snare / 2 hat-c / 3 hat-o / 4 cym (crash) /
//   5 ride / 6 floortom / 7 racktom
// Locking the layout (rather than rolling percussion picks per session)
// lets the conductor reason about each slot SEMANTICALLY — cym is for
// phrase accents, ride is the ambient/sparse comp voice, toms are fill
// accents. blck_noir voices stay available via the manual picker.
const DRUM_BY_SLOT = [
  'ns1-kick',
  'ns1-snare',
  'ns1-hat-c',
  'ns1-hat-o',
  'ns1-cym',
  'ns1-ride',
  'ns1-floortom',
  'ns1-racktom',
] as const;

export function randomFrom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

// Inclusive integer in [min, max]. Used to roll fresh Euclidean params per
// compose call so two compose-X invocations don't produce identical drum
// patterns. Voice picks already varied; rhythmic params do too now.
export function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

export function drumVoiceForSlot(slot: number): string {
  return DRUM_BY_SLOT[slot] ?? DRUM_BY_SLOT[DRUM_BY_SLOT.length - 1];
}

// Band-identity resolver. Applied to MELODIC voices only (chord master,
// bass, motifs, flavors) — if the track already has a voice assigned,
// compose moves preserve it so user-driven voice swaps persist across
// new bank generations. Falls back to the palette pick only when the
// slot is empty.
//
// DRUM voices are NOT routed through this — they always use DRUM_BY_SLOT
// directly. The drum kit layout is intentionally locked (slot 0 = kick,
// 1 = snare, etc. all ns-kit-1), so auto-generated banks consistently
// use the kit regardless of what the default-preset's drum slots happen
// to be set to.
export function activeVoice(t: Track, fallback: string): string {
  return t.source.kind === 'voice' ? t.source.id : fallback;
}

// Voice palette — session-scoped band identity. First compose call (any
// intent) picks all the voices; subsequent compose calls reuse them so
// transitions feel like the same ensemble playing different ideas rather
// than swapping to a different ensemble entirely. Module-scope so page
// reload regenerates; expose resetPalette() for explicit "fresh band"
// reset via UI.
export interface VoicePalette {
  chordMaster: string;
  bass: string;
  motifs: string[]; // length 3
  flavors: string[]; // length 3
}

let currentPalette: VoicePalette | null = null;

// Fisher-Yates shuffle, then slice — guarantees distinct picks. Falls back
// to random-with-repeat if requested count exceeds pool size.
export function pickDistinctVoices(pool: readonly string[], count: number): string[] {
  if (count >= pool.length) {
    const out: string[] = [];
    for (let i = 0; i < count; i++) out.push(pool[i % pool.length]);
    return out;
  }
  const copy = [...pool];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

export function getOrCreatePalette(): VoicePalette {
  if (currentPalette) return currentPalette;
  currentPalette = {
    chordMaster: randomFrom(CHORD_MASTER_VOICES),
    bass: randomFrom(BASS_VOICES),
    motifs: pickDistinctVoices(MOTIF_VOICES, 3),
    flavors: pickDistinctVoices(FLAVOR_VOICES, 3),
  };
  return currentPalette;
}

export function resetPalette(): void {
  currentPalette = null;
}

export function getCurrentPalette(): VoicePalette | null {
  return currentPalette;
}
