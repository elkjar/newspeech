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

import { useSequencerStore, RATE_STRIDE } from '../state/store';
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
  const held: HeldNote = { trackId: target.id, noteId };

  if (state.playing && target.inputArmed) {
    const aud = scheduler.getAudibleStepTiming();
    if (aud !== null) {
      const stride = RATE_STRIDE[target.rate];

      // Which ROW step is sounding, and where that row step started — both as a
      // global-step index and an audioContext time. A row step spans `stride`
      // global (32nd-note) ticks, so the audible global step can be partway
      // into the span; back out to the row-step boundary.
      const raw = Math.floor((aud.index - state.sceneStartStep) / stride);
      const rowStartGlobal = state.sceneStartStep + raw * stride;
      const rowStepDur = stride * aud.stepDuration;
      const rowStartTime = aud.when - (aud.index - rowStartGlobal) * aud.stepDuration;

      // Capture "lazy"/pushed feel instead of hard-quantizing: measure how far
      // into the row step the key was actually pressed, then snap to the
      // NEAREST row-step boundary and store the signed remainder as microTiming
      // (a fraction of the row step, the engine's own unit). Rounding to the
      // nearest boundary — not flooring — means a note played slightly EARLY
      // lands on the step it was aiming at with a small negative offset, rather
      // than dumping onto the previous step and clamping at +0.5.
      const frac = (getAudioContext().currentTime - rowStartTime) / rowStepDur; // [0,1)
      let rowIndex = raw;
      let micro = frac;
      if (frac > 0.5) {
        rowIndex = raw + 1; // pushed early — belongs to the upcoming step
        micro = frac - 1; // negative: ahead of that step's grid position
      }
      micro = Math.max(-0.5, Math.min(0.5, micro));
      const localStep = ((rowIndex % target.length) + target.length) % target.length;

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

      // Overdub semantics: never clear; write pitch + velocity + on + the
      // captured micro-timing. Each press records a single step — holds are NOT
      // captured as ties (that added more glitches than it was worth); tie
      // notes manually after.
      state.setStepPitch(target.id, localStep, degree);
      state.setStepVelocity(target.id, localStep, msg.value / 127);
      state.setStepMicroTiming(target.id, localStep, micro);
      state.setStepOn(target.id, localStep, true);
    }
  } else if (state.tieAnchor && state.tieAnchor.trackId === target.id) {
    // Pinned step-edit. When a step on the input-target track is pinned in the
    // inspector (the white anchor square, set by clicking the step), an incoming
    // note RETUNES that step rather than recording under a playhead — the
    // "edit while stopped" path the realtime recorder above can't reach. Pin a
    // step, play a key: the monitor already sounded it (line 74), and the step
    // takes the played pitch. Pitch only — velocity / probability / timing /
    // on-state stay as authored, so this is a surgical retune, not a re-record.
    // Same scaleDegreeOf conversion as the recorder, so on playback the engine
    // re-applies the track octave identically. Guarded to the target track:
    // a pin on some other row is left alone (its voice wouldn't match the
    // monitor anyway). Keyed off tieAnchor (the explicit click-pin), not
    // hover-driven selectedStep, so a grazed cell can't catch the note.
    const degree = scaleDegreeOf(snapped, state.rootNote, state.scale) ?? 0;
    state.setStepPitch(target.id, state.tieAnchor.index, degree);
  }

  // Re-pressing a still-held note just resets the anchor (its old monitor
  // voice, if monophonic, was already choked by this trigger).
  heldNotes.set(msg.num, held);

  return true;
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

  const track = state.tracks.find((t) => t.id === held.trackId);
  if (!track) return true;

  // Release the held monitor voice — ramps THIS voice down (its own release
  // time) without touching the track's pattern voices.
  monitorRelease(track, held.noteId);
  return true;
}
