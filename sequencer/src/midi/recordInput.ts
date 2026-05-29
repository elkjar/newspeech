// Record MIDI note-on into the armed track's current step.
//
// Called from dispatchMidi BEFORE the binding lookup. Returns true if the
// message was consumed (port matches + a track is armed + transport is
// playing) so the dispatcher can short-circuit before running CC bindings
// — the source device may also be CC-mapped, and we don't want a knob
// twist on a keyboard to fire twice.

import { useSequencerStore, RATE_STRIDE } from '../state/store';
import { scheduler } from '../audio/scheduler';
import { snapToScale } from '../audio/scale';
import type { MidiMessage } from './midiIn';

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

  // Phase-1 scope: realtime quantize only. Step-entry (transport stopped)
  // lands in phase 2 with a cursor + advance.
  if (!state.playing) return false;

  const audibleGlobal = scheduler.getAudibleStep();
  if (audibleGlobal === null) return false;

  const stride = RATE_STRIDE[armed.rate];
  const raw = Math.floor((audibleGlobal - state.sceneStartStep) / stride);
  const localStep = ((raw % armed.length) + armed.length) % armed.length;

  // Snap incoming MIDI to the nearest in-scale tone before storing.
  // Default-on quantization: off-key accidentals get pulled to the
  // current scene's scale so a recorded melody stays diatonic without
  // the user thinking about it. Chromatic scale is a no-op in
  // snapToScale, giving full-chromatic capture for free.
  const snapped = snapToScale(msg.num, state.rootNote, state.scale);

  // Overdub semantics: never clear; write pitch + velocity + on.
  // Snapped MIDI note number is stored as `step.pitch` — the armed
  // track should be on `semitones` interp for playback to match the
  // played pitch. Other interps will treat the value as a degree
  // (musically off; the user will see it and switch interp).
  state.setStepPitch(armed.id, localStep, snapped);
  state.setStepVelocity(armed.id, localStep, msg.value / 127);
  state.setStepOn(armed.id, localStep, true);

  return true;
}
