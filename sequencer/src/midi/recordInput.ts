// Route MIDI note-on to the input-target track and ALWAYS monitor its voice;
// recording (writing steps) is gated by the per-track record arm. Note-off
// releases the monitor voice.
//
// Functional model: MONITORING is live all the time — playing a key sounds the
// target channel's voice with no toggle. The target channel is the RECORD-armed
// melodic track, else the HOVERED step's track, else the focused/selected
// channel. WRITING is cursor-driven: while stopped, a played note is authored
// onto the step the mouse is HOVERING (placement) — move the cursor off the grid
// and you play/audition freely with nothing written. Selecting/pinning a step no
// longer catches keyboard writes (that made stopped monitoring impossible: every
// audition note overwrote the selected step). Writes: armed + playing → realtime
// overdub under the playhead; stopped + hovering a step → that step is authored
// from the played note. EVERY note source (external MIDI keyboard AND the
// Launchpad keyboard/chord pages) shares this via resolveInputTarget — no
// per-device differentiation. The old monitor-only `inputLive` toggle was dropped.
//
// Called from dispatchMidi BEFORE the binding lookup. Returns true if the
// message was consumed (port matches + a track is the input target) so the
// dispatcher can short-circuit before running CC bindings — the source device
// may also be CC-mapped, and we don't want a knob twist on a keyboard to fire
// twice.

import { useSequencerStore, RATE_STRIDE, MAX_STEPS, type Track } from '../state/store';
import { scheduler } from '../audio/scheduler';
import { getAudioContext } from '../audio/audioContext';
import { snapToScale, scaleDegreeOf } from '../audio/scale';
import { monitorNote, monitorRelease } from '../audio/monitor';
import type { ChordVoicing } from '../audio/chords';
import type { MidiMessage } from './midiIn';

// Notes currently held down on the record device, keyed by raw MIDI note
// number. Set on every note-on while armed so note-off can release the
// sustaining monitor voice. Module-level: a key release can arrive many ticks
// after the press.
interface HeldNote {
  trackId: string;
  noteId: number; // monitor voice handle, for targeted note-off release
  overdub: RecordedOverdub | null; // set if this press recorded a step; note-off writes its gate
}
const heldNotes = new Map<number, HeldNote>();

// Monotonic voice-handle source for the monitor. Nonzero (0 = untagged in the
// native engine). A double makes ~9e15 ids — never realistically exhausted.
let nextNoteId = 1;

// The channel a played note targets + the step it writes to — SHARED by every
// note source (external MIDI keyboard AND the Launchpad keyboard/chord pages) so
// they behave identically. There is intentionally no per-device differentiation:
// a Launchpad in keyboard mode IS a MIDI keyboard.
//   - track: the voice to MONITOR + author on — the armed MELODIC track, else the
//     HOVERED step's track, else the focused channel (last clicked). Melodic-only
//     for the armed case so the Launchpad drum page's multi-arm can't hijack it.
//   - writeIndex: the step a note is authored onto while STOPPED — the hovered
//     step. Cursor off the grid (or transport playing) → null → monitor only.
// Returns null when no channel has been engaged at all.
export interface InputTarget {
  track: Track;
  writeIndex: number | null;
}
export function resolveInputTarget(): InputTarget | null {
  const state = useSequencerStore.getState();
  const byId = (id: string | null | undefined) =>
    id ? state.tracks.find((t) => t.id === id) : undefined;
  const hov = state.playing ? null : state.hoveredStep;
  const track =
    state.tracks.find((t) => t.inputArmed && t.section === 'melodic') ??
    byId(hov?.trackId) ??
    byId(state.focusedTrackId);
  if (!track) return null;
  const writeIndex =
    hov && hov.trackId === track.id && hov.index < track.length ? hov.index : null;
  return { track, writeIndex };
}

export function tryRecordNote(msg: MidiMessage): boolean {
  if (msg.msg !== 'note') return false;

  const state = useSequencerStore.getState();

  // Port gate: only the user-selected record device feeds the recorder.
  // Prevents Launchpad pad presses from leaking into the armed track
  // when both controllers are connected.
  if (!state.midiRecInputPort || msg.port !== state.midiRecInputPort) {
    return false;
  }

  // Resolve the target channel + write step — the SAME logic the Launchpad pages
  // use (see resolveInputTarget). Falls through (return false → CC bindings) when
  // no channel has been engaged.
  const resolved = resolveInputTarget();
  if (!resolved) return false;
  const target = resolved.track;

  // Snap incoming MIDI to the nearest in-scale tone. Default-on quantization:
  // off-key accidentals get pulled to the current scene's scale so a recorded
  // melody stays diatonic without the user thinking about it. Chromatic scale
  // is a no-op in snapToScale, giving full-chromatic capture for free.
  const snapped = snapToScale(msg.num, state.rootNote, state.scale);

  // The note the target track will actually SOUND: the engine applies the
  // track's octave offset to every melodic trigger, so fold it in here too —
  // this is the pitch the loop plays back, and the pitch we monitor with, so
  // live audition matches the recorded result.
  const soundingMidi = snapped + target.octave * 12;

  // Live monitoring — ALWAYS sounds the target's voice the moment a key is
  // pressed, whether the target is armed or just the selected (pinned) step's
  // track, and whether or not the transport is running. Monitoring is free; the
  // arm only gates recording (below). The voice is tagged with a fresh note id
  // so the matching note-off can release THIS voice (sustains until then). The
  // note is consumed (return true below) regardless, so the device's note-ons
  // never also fire a CC/note binding.
  const noteId = nextNoteId++;
  monitorNote(target, soundingMidi, msg.value / 127, noteId);

  // Author the note. `snapped` is the pre-track-octave, in-scale MIDI note.
  // Writing has two modes (mutually exclusive): armed + playing → realtime
  // overdub quantized under the playhead; else a hovered step (resolved.writeIndex)
  // → author it. The returned overdub (if any) lets note-off finalize the GATE.
  const overdub = writeRecordedNote(target, snapped, msg.value / 127, resolved.writeIndex);

  // Re-pressing a still-held note just resets the anchor (its old monitor
  // voice, if monophonic, was already choked by this trigger).
  heldNotes.set(msg.num, { trackId: target.id, noteId, overdub });

  return true;
}

// A realtime overdub in flight: which step was written + the timing needed to
// finalize its GATE (note length) when the key is released. Returned by
// writeRecordedNote so the caller can stash it on the held-note and hand it to
// finalizeRecordedNote on note-off.
export interface RecordedOverdub {
  trackId: string;
  localStep: number;
  rowStepDur: number; // seconds of one row-step at record time
  t0: number; // audio-clock time of the note-on
}

// Write a played note onto `track` — the shared record path for both the MIDI
// keyboard (above) and the Launchpad keyboard page. `snapped` is the in-scale
// MIDI note BEFORE the track octave (the engine re-applies track.octave on
// playback, so callers that monitor at an absolute pitch must subtract it).
// Two modes, mutually exclusive:
//   - armed + playing → realtime overdub quantized under the playhead, with the
//     press's "lazy/pushed" offset captured as microTiming. Returns a
//     RecordedOverdub so note-off can write the GATE from how long it was held.
//   - else, when `writeIndex` is non-null (the HOVERED step — every note source
//     resolves it the same way via resolveInputTarget) → author that step.
//     Placing on an OFF step turns it on + sets pitch + velocity (a new note);
//     retuning an already-ON step sets pitch only, preserving its velocity/feel.
//     Returns null.
// Returns null if neither mode applies (stopped with nothing hovered → monitor
// only).
export function writeRecordedNote(
  track: Track,
  snapped: number,
  velocity: number,
  writeIndex: number | null
): RecordedOverdub | null {
  const state = useSequencerStore.getState();
  if (state.playing && track.inputArmed) {
    const q = quantizedOverdubStep(track);
    if (q === null) return null;
    // step.pitch is a SCALE-DEGREE offset from the tonic; convert (inverse of
    // the engine's quantize) so playback reproduces the monitored pitch.
    const degree = scaleDegreeOf(snapped, state.rootNote, state.scale) ?? 0;
    state.setStepPitch(track.id, q.localStep, degree);
    state.setStepVelocity(track.id, q.localStep, velocity);
    state.setStepMicroTiming(track.id, q.localStep, q.micro);
    state.setStepOn(track.id, q.localStep, true);
    return { trackId: track.id, localStep: q.localStep, rowStepDur: q.rowStepDur, t0: getAudioContext().currentTime };
  } else if (writeIndex !== null) {
    const degree = scaleDegreeOf(snapped, state.rootNote, state.scale) ?? 0;
    const wasOn = !!track.steps[writeIndex]?.on;
    state.setStepPitch(track.id, writeIndex, degree);
    if (!wasOn) {
      // New note placed by hover/pin — capture the played velocity + turn it on.
      state.setStepVelocity(track.id, writeIndex, velocity);
      state.setStepOn(track.id, writeIndex, true);
    }
  }
  return null;
}

// Write a played CHORD onto `track` — the chord sibling of writeRecordedNote,
// for the Launchpad chord page. Stores the exact `voicing` plock (degree +
// extension/inversion/spread) plus `pitchDegrees` (the chord page's selected
// octave expressed in scale-degree space; the engine re-applies track.octave on
// playback, so callers monitor at +track.octave to match). NO chord detection —
// the voicing IS the pad you pressed. Same two mutually-exclusive modes as
// writeRecordedNote:
//   - armed + playing → realtime overdub quantized under the playhead. Returns a
//     RecordedOverdub so the pad release can finalize the GATE (chord length)
//     from how long it was held, exactly like a recorded note.
//   - else, when `writeIndex` is non-null (the HOVERED step, from the chord page
//     via resolveInputTarget) → author the chord onto that step. Sets voicing +
//     pitch + on; captures velocity only when placing on an OFF step (preserves
//     an existing note's dynamics on retune).
// Returns null when nothing was written (stopped + nothing hovered → audition
// only) or after a stopped write (no gate to finalize).
export function writeRecordedChord(
  track: Track,
  voicing: ChordVoicing,
  pitchDegrees: number,
  velocity: number,
  writeIndex: number | null
): RecordedOverdub | null {
  const state = useSequencerStore.getState();
  if (state.playing && track.inputArmed) {
    const q = quantizedOverdubStep(track);
    if (q === null) return null;
    state.setStepChordVoicing(track.id, q.localStep, voicing);
    state.setStepPitch(track.id, q.localStep, pitchDegrees);
    state.setStepVelocity(track.id, q.localStep, velocity);
    state.setStepMicroTiming(track.id, q.localStep, q.micro);
    state.setStepOn(track.id, q.localStep, true);
    return { trackId: track.id, localStep: q.localStep, rowStepDur: q.rowStepDur, t0: getAudioContext().currentTime };
  } else if (writeIndex !== null) {
    const wasOn = !!track.steps[writeIndex]?.on;
    state.setStepChordVoicing(track.id, writeIndex, voicing);
    state.setStepPitch(track.id, writeIndex, pitchDegrees);
    state.setStepOn(track.id, writeIndex, true);
    if (!wasOn) state.setStepVelocity(track.id, writeIndex, velocity);
  }
  return null;
}

// Quantize "now" to the nearest row-step boundary of `track` under the live
// playhead, capturing the signed remainder as microTiming (so an early press
// keeps its pushed feel rather than dumping onto the previous step). Shared by
// the melodic recorder and the drum-page hit recorder. Returns null if the
// transport timing isn't available yet. rowStepDur is returned for callers that
// finalize a held gate later.
function quantizedOverdubStep(
  track: Track
): { localStep: number; micro: number; rowStepDur: number } | null {
  const state = useSequencerStore.getState();
  const aud = scheduler.getAudibleStepTiming();
  if (aud === null) return null;
  const stride = RATE_STRIDE[track.rate];
  // Back out to the sounding row-step boundary (a row step spans `stride`
  // 32nd-note ticks; the audible global step can be partway in).
  const raw = Math.floor((aud.index - state.sceneStartStep) / stride);
  const rowStartGlobal = state.sceneStartStep + raw * stride;
  const rowStepDur = stride * aud.stepDuration;
  const rowStartTime = aud.when - (aud.index - rowStartGlobal) * aud.stepDuration;
  const frac = (getAudioContext().currentTime - rowStartTime) / rowStepDur; // [0,1)
  let rowIndex = raw;
  let micro = frac;
  if (frac > 0.5) {
    rowIndex = raw + 1;
    micro = frac - 1;
  }
  micro = Math.max(-0.5, Math.min(0.5, micro));
  const localStep = ((rowIndex % track.length) + track.length) % track.length;
  return { localStep, micro, rowStepDur };
}

// Record a live drum hit (from the Launchpad drum page) onto a channel under the
// playhead — same quantize + microtiming capture as the melodic recorder, but
// writes on/velocity/microtiming/RATCHET (no pitch: drums aren't pitched). Drums
// are one-shots, so there's no held gate to finalize on release. Records only
// when the channel is armed (`inputArmed` — the drum page's top-row toggles it,
// which is multi for drums) and the transport is running (overdub quantizes
// under the playhead). `ratchet` is the drum page's per-channel ladder selection
// (1 = single, 2..8 = roll).
export function writeDrumHit(track: Track, velocity: number, ratchet: number): void {
  const state = useSequencerStore.getState();
  if (!(state.playing && track.inputArmed)) return;
  const q = quantizedOverdubStep(track);
  if (q === null) return;
  state.setStepVelocity(track.id, q.localStep, velocity);
  state.setStepMicroTiming(track.id, q.localStep, q.micro);
  state.setStepRatchet(track.id, q.localStep, Math.max(1, Math.min(8, Math.floor(ratchet))));
  state.setStepOn(track.id, q.localStep, true);
}

// Finalize a recorded note's LENGTH from how long the key was held: gate =
// heldSeconds / rowStepDuration. The engine gate ceiling was raised to
// MAX_STEPS (the longest pattern), so the gate alone carries the full note
// length — a recorded note sounds exactly as long as it was monitored, with no
// tie chains. (Capped at MAX_STEPS since a note can't meaningfully outlast the
// pattern.) Floor of 0.1 keeps the briefest tap audible. Called on note-off
// with the RecordedOverdub from the matching note-on.
export function finalizeRecordedNote(ov: RecordedOverdub): void {
  const heldSteps = (getAudioContext().currentTime - ov.t0) / ov.rowStepDur;
  const state = useSequencerStore.getState();
  state.setStepGate(ov.trackId, ov.localStep, Math.max(0.1, Math.min(MAX_STEPS, heldSteps)));
  state.setStepTie(ov.trackId, ov.localStep, false); // length lives in the gate, not a tie
}

// Close a held note: release the sustaining monitor voice. Holds are NOT
// captured as ties — that proved glitchier than it was worth, and tying notes
// manually after a take is cleaner. Returns true if the message was consumed
// from the record port (so it never falls through to a binding).
export function tryRecordNoteOff(msg: MidiMessage): boolean {
  if (msg.msg !== 'noteoff') return false;

  const state = useSequencerStore.getState();
  if (!state.midiRecInputPort || msg.port !== state.midiRecInputPort) {
    return false;
  }

  const held = heldNotes.get(msg.num);
  if (!held) return true; // not a note we're tracking — consume and move on
  heldNotes.delete(msg.num);

  // Write the recorded note's LENGTH from how long the note was held — gate for
  // short notes, a tie chain for longer ones (the note-on/off feel).
  if (held.overdub) finalizeRecordedNote(held.overdub);

  const track = state.tracks.find((t) => t.id === held.trackId);
  if (!track) return true;

  // Release the held monitor voice — ramps THIS voice down (its own release
  // time) without touching the track's pattern voices.
  monitorRelease(track, held.noteId);
  return true;
}
