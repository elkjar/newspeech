// Route MIDI note-on to the input-target track: always monitor its voice, and
// when that track is RECORD-armed (not live-only) and the transport is running,
// write the note onto the current step. Note-off releases the monitor voice.
//
// A track can be the input target in one of two modes: record-armed
// (inputArmed — monitors + records while playing) or live (inputLive — monitors
// only, never writes, even mid-playback). The two are mutually exclusive across
// all tracks; only one track is ever the target.
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

export function tryRecordNote(msg: MidiMessage): boolean {
  if (msg.msg !== 'note') return false;

  const state = useSequencerStore.getState();

  // Port gate: only the user-selected record device feeds the recorder.
  // Prevents Launchpad pad presses from leaking into the armed track
  // when both controllers are connected.
  if (!state.midiRecInputPort || msg.port !== state.midiRecInputPort) {
    return false;
  }

  // The input target is whichever track is record-armed OR live. Mutual
  // exclusivity is enforced in the store, so at most one matches.
  const target = state.tracks.find((t) => t.inputArmed || t.inputLive);

  // Silent pinned step-edit. With NO track armed/live, the keyboard normally
  // has nowhere to route — but if a step is pinned in the inspector we still
  // honor it as a retune target. This is the lighter, monitor-less sibling of
  // the armed pinned-edit below: arming is what buys the audible monitor voice,
  // so without it the note lands on the pinned step's pitch silently — pin a
  // step, play a key, the step takes the played pitch (no sound). Only fires
  // when nothing is armed/live, so the armed path's "hear what you edit"
  // behavior is untouched. Pitch only, same scaleDegreeOf conversion as the
  // recorder. Consumed (return true) so the keyboard note never also fires a
  // CC binding.
  if (!target) {
    if (state.tieAnchor) {
      const snappedPin = snapToScale(msg.num, state.rootNote, state.scale);
      const degree = scaleDegreeOf(snappedPin, state.rootNote, state.scale) ?? 0;
      state.setStepPitch(state.tieAnchor.trackId, state.tieAnchor.index, degree);
      return true;
    }
    return false;
  }

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

  // Live monitoring — targeting a track (record-armed OR live) makes its voice
  // audible the moment a key is pressed, whether or not the transport is
  // running. You can't record a line you can't hear, and live mode is monitor
  // -only by design. The voice is tagged with a fresh note id so the matching
  // note-off can release THIS voice (sustains until then). The note is consumed
  // (return true below) regardless, so the device's note-ons never also fire a
  // CC/note binding.
  const noteId = nextNoteId++;
  monitorNote(target, soundingMidi, msg.value / 127, noteId);

  // Held-note bookkeeping: track the press so note-off can release the monitor
  // voice. Writing the step has two modes: realtime overdub (RECORD-armed +
  // transport running — quantizes under the playhead) and pinned step-edit
  // (a step pinned in the inspector — retunes that step, works while stopped).
  // They're mutually exclusive: while armed-and-playing the playhead recorder
  // owns the note; otherwise a pinned step on the target track catches it.
  // Write the note onto the track (overdub under the playhead while armed +
  // playing, or pinned step-edit while stopped). Shared with the Launchpad
  // keyboard page so both controllers record identically. `snapped` is the
  // pre-track-octave, in-scale MIDI note. The returned overdub (if any) lets
  // note-off finalize the GATE from the held duration.
  const overdub = writeRecordedNote(target, snapped, msg.value / 127);

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
//   - else, a step pinned on this track (`tieAnchor`) → surgical pitch retune of
//     that step (the edit-while-stopped path). Pitch only; on/velocity/timing
//     stay as authored. Returns null.
// Returns null if neither applies (e.g. stopped with nothing pinned).
export function writeRecordedNote(
  track: Track,
  snapped: number,
  velocity: number
): RecordedOverdub | null {
  const state = useSequencerStore.getState();
  if (state.playing && track.inputArmed) {
    const aud = scheduler.getAudibleStepTiming();
    if (aud === null) return null;
    const stride = RATE_STRIDE[track.rate];
    // Back out to the sounding row-step boundary (a row step spans `stride`
    // 32nd-note ticks; the audible global step can be partway in).
    const raw = Math.floor((aud.index - state.sceneStartStep) / stride);
    const rowStartGlobal = state.sceneStartStep + raw * stride;
    const rowStepDur = stride * aud.stepDuration;
    const rowStartTime = aud.when - (aud.index - rowStartGlobal) * aud.stepDuration;
    // Snap to the NEAREST row-step boundary; store the signed remainder as
    // microTiming so an early press keeps its pushed feel rather than dumping
    // onto the previous step.
    const frac = (getAudioContext().currentTime - rowStartTime) / rowStepDur; // [0,1)
    let rowIndex = raw;
    let micro = frac;
    if (frac > 0.5) {
      rowIndex = raw + 1;
      micro = frac - 1;
    }
    micro = Math.max(-0.5, Math.min(0.5, micro));
    const localStep = ((rowIndex % track.length) + track.length) % track.length;
    // step.pitch is a SCALE-DEGREE offset from the tonic; convert (inverse of
    // the engine's quantize) so playback reproduces the monitored pitch.
    const degree = scaleDegreeOf(snapped, state.rootNote, state.scale) ?? 0;
    state.setStepPitch(track.id, localStep, degree);
    state.setStepVelocity(track.id, localStep, velocity);
    state.setStepMicroTiming(track.id, localStep, micro);
    state.setStepOn(track.id, localStep, true);
    return { trackId: track.id, localStep, rowStepDur, t0: getAudioContext().currentTime };
  } else if (state.tieAnchor && state.tieAnchor.trackId === track.id) {
    const degree = scaleDegreeOf(snapped, state.rootNote, state.scale) ?? 0;
    state.setStepPitch(track.id, state.tieAnchor.index, degree);
  }
  return null;
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
