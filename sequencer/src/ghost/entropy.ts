// Ghost entropy — pure measurement of how much is happening in a bank.
//
// Used by the Ghost picker to bias bank order toward an authored shape curve
// (sustain / build / arc / wave / decay). NOT a runtime control — entropy is
// a property of the AUTHORED bank, computed once at snap/generate time and
// cached on the slot. The macro density knob is the runtime expression lens
// that operates on top of entropy.
//
// Spec formula from project_ghost.md (LFO term dropped — LFOs are
// session-global, not per-bank, so they can't contribute per-slot variance):
//
//   entropy(bank) = α·channel_count
//                 + β·voice_type_score
//                 + γ·step_density
//                 + δ·mutation_depth
//                 + ζ·polyphony
//
// Each component is normalized to 0..1 and weighted; total ∈ [0,1].
// β heaviest because the spec example (2-ch drone vs 8-ch kit+chord+arp) is
// mostly driven by what voices are playing, not just how many channels.

import type { BankSlot, Track } from '../state/store';
import { voiceEntropyClass, voiceRole } from '../audio/voices';
import { instrumentEntropyClass, getInstrument } from '../instruments/library';
import { isChord } from '../audio/chords';

export interface EntropyResult {
  total: number;
  channels: number;     // 0..1 normalized
  voiceType: number;    // 0..1
  stepDensity: number;  // 0..1
  mutation: number;     // 0..1
  polyphony: number;    // 0..1
}

export const ENTROPY_WEIGHTS = {
  channels: 0.2,
  voiceType: 0.35,
  stepDensity: 0.25,
  mutation: 0.1,
  polyphony: 0.1,
} as const;

const TRACK_COUNT = 16;

// A "fully busy" track fires gates on ~30-35% of its steps, never close to
// 100% — straight-16th drum patterns are 25%, dense kits 30-40%, melodic
// rows usually 10-20%. Without this reference, even saturated banks only
// pushed the stepDensity component up to ~0.07 (well below its 0.25 weight
// budget). Normalizing against `DENSITY_REFERENCE` and clamping lets γ
// actually swing across most of its budget for the bank-density extremes
// the picker needs to differentiate.
const DENSITY_REFERENCE = 0.3;

// Diversity multiplier on β (voiceType). Mean-class alone treats a 6-track
// drums-only bank as "louder" than a 10-track full-mix because all classes
// are 1.0 — musically wrong: a drum solo is intense but not the climax;
// the climax is everything-on-everywhere. Multiplier floors β at 0.4× its
// mean for single-role banks, ramps to 1.0× at 4+ roles (full ensemble).
// Roles counted: drum / pad / lead / bass (last only via MIDI instrument).
const DIVERSITY_FLOOR = 0.4;
const MAX_ROLES = 4;

function trackRole(t: Track): string {
  if (t.source.kind === 'voice') return voiceRole(t.source.id);
  if (t.source.kind === 'instrument') {
    return getInstrument(t.source.id)?.role ?? 'lead';
  }
  return 'lead';
}

function trackIsActive(t: Track): boolean {
  if (t.source.kind === 'empty') return false;
  if (t.mute) return false;
  const len = Math.max(1, Math.min(t.length, t.steps.length));
  for (let i = 0; i < len; i++) {
    const s = t.steps[i];
    if (s?.on && s.probability > 0) return true;
  }
  return false;
}

function trackEntropyClass(t: Track): number {
  if (t.source.kind === 'voice') return voiceEntropyClass(t.source.id);
  if (t.source.kind === 'instrument') return instrumentEntropyClass(t.source.id);
  return 0.5;
}

function trackStepDensity(t: Track): number {
  const len = Math.max(1, Math.min(t.length, t.steps.length));
  let onCount = 0;
  for (let i = 0; i < len; i++) {
    const s = t.steps[i];
    if (s?.on && s.probability > 0) onCount++;
  }
  return onCount / len;
}

function trackIsPolyphonic(t: Track): boolean {
  // Track contributes polyphony if it stacks notes per trigger — a chord
  // voicing with degree > 0 produces a multi-note dispatch. Drum tracks and
  // single-note melodic rows count as 0.
  if (t.source.kind === 'empty') return false;
  if (t.section === 'drum') return false;
  return isChord(t.defaultChordVoicing);
}

/**
 * Compute entropy + component breakdown for a bank slot. Pure function: no
 * side effects, no async, safe to call on any slot regardless of mounted
 * state. Empty slots (no active tracks) read all-zeros — entropy = 0.
 */
export function computeBankEntropy(slot: BankSlot): EntropyResult {
  const activeTracks = slot.tracks.filter(trackIsActive);
  const activeCount = activeTracks.length;

  if (activeCount === 0) {
    return { total: 0, channels: 0, voiceType: 0, stepDensity: 0, mutation: 0, polyphony: 0 };
  }

  const channels = activeCount / TRACK_COUNT;

  let voiceTypeSum = 0;
  let densitySum = 0;
  let mutationSum = 0;
  let polyCount = 0;
  const roles = new Set<string>();
  for (const t of activeTracks) {
    voiceTypeSum += trackEntropyClass(t);
    densitySum += trackStepDensity(t);
    mutationSum += t.mutation;
    if (trackIsPolyphonic(t)) polyCount++;
    roles.add(trackRole(t));
  }
  const voiceTypeMean = voiceTypeSum / activeCount;
  // Diversity ramps DIVERSITY_FLOOR..1 as unique roles span 1..MAX_ROLES.
  // Caps at 1.0 if more roles somehow appear (forward-compat).
  const diversity =
    DIVERSITY_FLOOR +
    (1 - DIVERSITY_FLOOR) * Math.min(1, roles.size / MAX_ROLES);
  const voiceType = voiceTypeMean * diversity;
  const stepDensity = Math.min(1, (densitySum / activeCount) / DENSITY_REFERENCE);
  const mutation = mutationSum / activeCount;
  const polyphony = polyCount / activeCount;

  const w = ENTROPY_WEIGHTS;
  const total =
    w.channels * channels +
    w.voiceType * voiceType +
    w.stepDensity * stepDensity +
    w.mutation * mutation +
    w.polyphony * polyphony;

  return { total, channels, voiceType, stepDensity, mutation, polyphony };
}

/** Convenience for callers that only want the cached scalar. */
export function bankEntropyTotal(slot: BankSlot): number {
  return computeBankEntropy(slot).total;
}
