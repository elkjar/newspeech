// Record MIDI note-on into the armed track's current step, and close held
// notes into ties on note-off.
//
// Called from dispatchMidi BEFORE the binding lookup. Returns true if the
// message was consumed (port matches + a track is armed + transport is
// playing) so the dispatcher can short-circuit before running CC bindings
// — the source device may also be CC-mapped, and we don't want a knob
// twist on a keyboard to fire twice.

import { useSequencerStore, RATE_STRIDE } from '../state/store';
import { scheduler } from '../audio/scheduler';
import { snapToScale, scaleDegreeOf } from '../audio/scale';
import { monitorNote, monitorRelease } from '../audio/monitor';
import type { MidiMessage } from './midiIn';

// Notes currently held down on the record device, keyed by raw MIDI note
// number. Set on every note-on while armed (so note-off can release the
// sustaining monitor voice), and carries the recorded start step when the
// transport was running (so note-off can tie across the steps the note
// spanned). Module-level: a key release can arrive many ticks after the press.
interface HeldNote {
  trackId: string;
  noteId: number; // monitor voice handle, for targeted note-off release
  startLocal?: number; // track-local step the note-on recorded onto (if any)
  startGlobal?: number; // global step at press, for span measurement (if recorded)
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

  const armed = state.tracks.find((t) => t.inputArmed);
  if (!armed) return false;

  // Snap incoming MIDI to the nearest in-scale tone. Default-on quantization:
  // off-key accidentals get pulled to the current scene's scale so a recorded
  // melody stays diatonic without the user thinking about it. Chromatic scale
  // is a no-op in snapToScale, giving full-chromatic capture for free.
  const snapped = snapToScale(msg.num, state.rootNote, state.scale);

  // The note the armed track will actually SOUND: the engine applies the
  // track's octave offset to every melodic trigger, so fold it in here too —
  // this is the pitch the loop plays back, and the pitch we monitor with, so
  // live audition matches the recorded result.
  const soundingMidi = snapped + armed.octave * 12;

  // Live monitoring — arming a track makes its voice audible the moment a key
  // is pressed, whether or not the transport is running. You can't record a
  // line you can't hear. The voice is tagged with a fresh note id so the
  // matching note-off can release THIS voice (sustains until then). The note
  // is consumed (return true below) regardless, so the record device's
  // note-ons never also fire a CC/note binding.
  const noteId = nextNoteId++;
  monitorNote(armed, soundingMidi, msg.value / 127, noteId);

  // Held-note bookkeeping: always track the press so note-off can release the
  // monitor voice. Recording the step itself is realtime-quantize only and
  // needs the transport running — when stopped we still monitor, but there's
  // no playhead to write under (step-entry while stopped is a future mode).
  const held: HeldNote = { trackId: armed.id, noteId };

  if (state.playing) {
    const audibleGlobal = scheduler.getAudibleStep();
    if (audibleGlobal !== null) {
      const stride = RATE_STRIDE[armed.rate];
      const raw = Math.floor((audibleGlobal - state.sceneStartStep) / stride);
      const localStep = ((raw % armed.length) + armed.length) % armed.length;

      // `step.pitch` is a SCALE-DEGREE offset from the scene tonic, not an
      // absolute MIDI note — the engine resolves it with quantize(rootNote,
      // scale, pitch) on semitones ("ignore") tracks. So convert the played
      // note to its degree (the exact inverse of that quantize) before
      // storing; on playback the engine re-applies the octave offset,
      // reproducing the pitch we just monitored. snapToScale guarantees an
      // in-scale note, so scaleDegreeOf won't return null (0 fallback is
      // belt-and-suspenders). Best on a semitones/"ignore" track; follower
      // interps reinterpret the degree against the chord context.
      const degree = scaleDegreeOf(snapped, state.rootNote, state.scale) ?? 0;

      // Overdub semantics: never clear; write pitch + velocity + on.
      state.setStepPitch(armed.id, localStep, degree);
      state.setStepVelocity(armed.id, localStep, msg.value / 127);
      state.setStepOn(armed.id, localStep, true);

      held.startLocal = localStep;
      held.startGlobal = audibleGlobal;
    }
  }

  // Re-pressing a still-held note just resets the anchor (its old monitor
  // voice, if monophonic, was already choked by this trigger).
  heldNotes.set(msg.num, held);

  return true;
}

// Close a held note: release the sustaining monitor voice, and (if the press
// recorded a step) tie that step forward across every step the key was held
// for. Returns true if the message was consumed from the record port (so it
// never falls through to a binding), whether or not a tie resulted.
export function tryRecordNoteOff(msg: MidiMessage): boolean {
  if (msg.msg !== 'noteoff') return false;

  const state = useSequencerStore.getState();
  if (!state.midiRecInputPort || msg.port !== state.midiRecInputPort) {
    return false;
  }

  const held = heldNotes.get(msg.num);
  if (!held) return true; // not a note we're tracking — consume and move on
  heldNotes.delete(msg.num);

  const track = state.tracks.find((t) => t.id === held.trackId);
  if (!track) return true;

  // Release the held monitor voice — ramps THIS voice down (its own release
  // time) without touching the track's pattern voices. Always, even if nothing
  // was recorded (stopped-transport monitoring still sustains until release).
  monitorRelease(track, held.noteId);

  // Ties only apply if the press actually recorded a start step (transport was
  // running). Nothing recorded → monitor-only press, done above.
  if (held.startLocal === undefined || held.startGlobal === undefined) return true;

  // Track-steps elapsed while the key was held. Same global-step clock + stride
  // the press used, so it survives a rate change mid-hold.
  const releaseGlobal = scheduler.getAudibleStep();
  if (releaseGlobal === null) return true; // transport stopped mid-hold
  const stride = RATE_STRIDE[track.rate];
  const advanced = Math.round((releaseGlobal - held.startGlobal) / stride);
  if (advanced < 1) return true; // released within the start step — single note

  // tieToNext on startLocal .. startLocal+advanced-1 sustains the note across
  // advanced+1 steps. Clamp at the pattern's last step so a long hold sustains
  // to the end rather than wrapping the tie around the loop. The engine
  // re-articulates per the voice's tie cap (leads cap at 2), so over-long holds
  // stay musical without any clamping here.
  for (let k = 0; k < advanced; k++) {
    const idx = held.startLocal + k;
    if (idx > track.length - 2) break;
    state.setStepTie(track.id, idx, true);
  }
  return true;
}
