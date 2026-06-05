// Route MIDI note-on to the input-target track and ALWAYS monitor its voice;
// recording (writing steps) is gated by the per-track record arm. Note-off
// releases the monitor voice.
//
// Functional model: MONITORING is live all the time — playing a key sounds the
// target's voice with no toggle. RECORDING is the only toggle (the per-track
// arm). The target is the RECORD-armed track, else the track whose step is
// pinned in the inspector (`tieAnchor`) — so with nothing armed you still
// monitor (and pitch-edit) the SELECTED step's voice, mirroring the Launchpad
// keyboard page. Writes: armed + playing → realtime overdub under the playhead;
// a pinned step → that step's pitch is set from the played note. The old
// monitor-only `inputLive` toggle was dropped — monitoring is now free.
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

export function tryRecordNote(msg: MidiMessage): boolean {
  if (msg.msg !== 'note') return false;

  const state = useSequencerStore.getState();

  // Port gate: only the user-selected record device feeds the recorder.
  // Prevents Launchpad pad presses from leaking into the armed track
  // when both controllers are connected.
  if (!state.midiRecInputPort || msg.port !== state.midiRecInputPort) {
    return false;
  }

  // The input target is the armed MELODIC track, else the track whose step is
  // pinned in the inspector (`tieAnchor`). Scoped to melodic because drum
  // channels arm independently (multi) for the Launchpad drum page — they must
  // not hijack the MIDI keyboard, which plays melodically. The pinned-track
  // fallback lets the keyboard MONITOR + edit the SELECTED step's voice without
  // arming — the same select-a-step model as the Launchpad keyboard page. With
  // neither an armed melodic track nor a pin, the note falls through (return
  // false) to any CC binding on this device.
  const target =
    state.tracks.find((t) => t.inputArmed && t.section === 'melodic') ??
    (state.tieAnchor
      ? state.tracks.find((t) => t.id === state.tieAnchor!.trackId)
      : undefined);
  if (!target) return false;

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
//   - else, ARMED + a step pinned on this track (`tieAnchor`) → surgical pitch
//     retune of that step (the edit-while-stopped path). Pitch only;
//     on/velocity/timing stay as authored. Returns null. Gated on the arm so a
//     merely-selected (focused) channel doesn't catch retunes.
// Returns null if neither applies (not armed, or stopped with nothing pinned).
export function writeRecordedNote(
  track: Track,
  snapped: number,
  velocity: number
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
  } else if (track.inputArmed && state.tieAnchor && state.tieAnchor.trackId === track.id) {
    const degree = scaleDegreeOf(snapped, state.rootNote, state.scale) ?? 0;
    state.setStepPitch(track.id, state.tieAnchor.index, degree);
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
//   - else, ARMED + a step pinned on this track (`tieAnchor`) → author the chord
//     onto that pinned step (the edit-while-stopped path). Gated on the arm too:
//     clicking a step now selects/focuses its channel (and sets tieAnchor), so
//     without this an unarmed "selected" channel would catch chord writes.
// Returns null when nothing was written (not armed, or stopped + nothing pinned →
// audition only) or after a pinned write (no gate to finalize while stopped).
export function writeRecordedChord(
  track: Track,
  voicing: ChordVoicing,
  pitchDegrees: number,
  velocity: number
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
  } else if (track.inputArmed && state.tieAnchor && state.tieAnchor.trackId === track.id) {
    state.setStepChordVoicing(track.id, state.tieAnchor.index, voicing);
    state.setStepPitch(track.id, state.tieAnchor.index, pitchDegrees);
    state.setStepOn(track.id, state.tieAnchor.index, true);
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
