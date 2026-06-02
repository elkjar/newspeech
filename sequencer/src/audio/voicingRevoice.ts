// Live chord re-voicing for the voicing macro (Increment 2).
//
// Increment 1 made the voicing knob re-voice the chord at its NEXT trigger.
// This module lets a SUSTAINING (pad) chord that's already ringing follow the
// macro — so an LFO on the voicing knob breathes a held pad open and closed.
//
// Model (per the design): a voicing change is a small voice-leading diff, not
// a blanket re-pitch.
//   - tones that MOVE (inversion / spread) → re-pitch the existing voice
//   - a tone that APPEARS (extension 7→9→11) → bloom in as a fresh voice
//   - a tone that DISAPPEARS → fade out
// Matching is nearest-pitch: each ringing note pairs with its closest target,
// leftovers on either side are adds / removes. That gives minimal-movement
// voice leading for free.
//
// The registry holds the LAST chord fired per chord-master track plus enough
// recipe to spawn added tones identically to the original trigger. Only the
// native (cpal) path supports this — `repitchNote` has no Web Audio analogue.
// Mutated chords (drop/borrow/shuffle) are never registered (the engine omits
// `revoice` for them) so re-derivation never fights a per-trigger mutation.

import { resolveChord, applyVoicingMacro, type ChordVoicing } from './chords';
import type { Scale } from './scale';

export interface ChordToneVoice {
  noteId: number;
  midi: number;
}

export interface SoundingChord {
  trackId: string;
  // Sample voice id — for re-picking when an added tone blooms in.
  voice: string;
  // Authored (pre-macro) voicing + scene context, so the target chord can be
  // re-derived at ANY later macro value via applyVoicingMacro + resolveChord.
  authoredVoicing: ChordVoicing;
  rootNote: number;
  scale: Scale;
  pitchOffset: number;
  // Chord root MIDI the intervals were added to at trigger (already includes
  // track.octave). Target absolute pitch = baseMidi + interval.
  baseMidi: number;
  // Currently-sounding tones (noteId ↔ absolute MIDI). Mutated in place as the
  // chord is re-voiced.
  tones: ChordToneVoice[];
  // Trigger recipe for spawning added tones (gain folds in the per-sample
  // pick's voiceGain at spawn time — store the pre-pick factors here).
  velocity: number;
  trackGain: number;
  pan: number;
  outFirst: number;
  outStereo: boolean;
  section: number;
  isTexture: boolean;
  env?: {
    attack?: number;
    decay?: number;
    sustain?: number;
    release?: number;
    hold?: number;
  };
}

// Note-id namespace for revoice voices. Kept far above the live-input monitor
// counter (recordInput.ts starts at 1 and increments per played note) so the
// two id spaces can never collide. JS integers are exact well past this.
let nextId = 1;
const REVOICE_ID_BASE = 1_000_000_000;
export function allocRevoiceNoteId(): number {
  return REVOICE_ID_BASE + nextId++;
}

const registry = new Map<string, SoundingChord>();

export function registerChord(chord: SoundingChord): void {
  registry.set(chord.trackId, chord);
}

export function clearChord(trackId: string): void {
  registry.delete(trackId);
}

export function clearAllChords(): void {
  registry.clear();
}

export function soundingChords(): SoundingChord[] {
  return [...registry.values()];
}

// Target absolute MIDI notes for a chord at the given (LFO-modulated) macro.
export function targetMidisFor(c: SoundingChord, modVoicing: number): number[] {
  const eff = applyVoicingMacro(c.authoredVoicing, modVoicing);
  const { intervals } = resolveChord(c.rootNote, c.scale, eff, c.pitchOffset);
  return intervals.map((iv) => c.baseMidi + iv);
}

export interface RevoicePlan {
  // Existing voices to re-pitch: rate multiplier = 2^((newMidi-oldMidi)/12).
  repitch: { noteId: number; ratio: number }[];
  // Voices to release (tone removed from the chord).
  removeNoteIds: number[];
  // New tones to trigger (bloom in). Caller picks a sample, allocs a noteId,
  // and appends the result to the chord's tones.
  addMidis: number[];
  // The kept (matched, possibly re-pitched) tones at their NEW midi. Caller
  // sets chord.tones = keptTones + (the triggered adds).
  keptTones: ChordToneVoice[];
}

// Nearest-pitch voice-leading diff between the ringing tones and the target.
export function diffChord(
  current: ChordToneVoice[],
  target: number[],
): RevoicePlan {
  const remaining = [...target];
  const repitch: { noteId: number; ratio: number }[] = [];
  const removeNoteIds: number[] = [];
  const keptTones: ChordToneVoice[] = [];

  // Match low→high for stable, monotonic pairing.
  const sorted = [...current].sort((a, b) => a.midi - b.midi);
  for (const tone of sorted) {
    if (remaining.length === 0) {
      removeNoteIds.push(tone.noteId);
      continue;
    }
    let best = 0;
    let bestDist = Math.abs(remaining[0] - tone.midi);
    for (let i = 1; i < remaining.length; i++) {
      const d = Math.abs(remaining[i] - tone.midi);
      if (d < bestDist) {
        best = i;
        bestDist = d;
      }
    }
    const targetMidi = remaining.splice(best, 1)[0];
    if (targetMidi !== tone.midi) {
      repitch.push({
        noteId: tone.noteId,
        ratio: Math.pow(2, (targetMidi - tone.midi) / 12),
      });
    }
    keptTones.push({ noteId: tone.noteId, midi: targetMidi });
  }

  return { repitch, removeNoteIds, addMidis: remaining, keptTones };
}
