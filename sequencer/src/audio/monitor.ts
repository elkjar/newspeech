// Live input monitoring for the armed recording track.
//
// When a track is armed for MIDI recording, every note-on from the record
// device should make immediate audible sound — you can't record a melody you
// can't hear. This fires the armed track's own voice at the absolute MIDI note
// the track will SOUND (scale-snapped + octave-applied by the caller, so live
// audition matches loop playback) + velocity, the moment the note arrives,
// independent of whether the transport is running. Recording into the grid
// still only happens while playing (see recordInput.ts); monitoring is always
// on while armed.
//
// The note SUSTAINS while the key is held: each press tags its voice with a
// unique note id and triggers with a long hold, and the matching release (on
// note-off) ramps that exact voice down — without touching the armed track's
// pattern voices, which share the same trackId. So a held note rings for as
// long as you hold it, matching the tie it records. Section is SECTION_NONE
// so the live monitor never bleeds into recording stems.

import { triggerSample, releaseNote } from './nativeEngine';
import { getAudioContext } from './audioContext';
import { samplePlayer } from './samplePlayer';
import { resolveVoiceEnvelope } from '../instruments/voiceEditsStore';
import { resolveDeviceId, sendMIDINote, sendMIDINoteOn, sendMIDINoteOff } from './midiOut';
import { useSequencerStore, type Track } from '../state/store';

// Scheduled on/off window for instrument-row (external MIDI) drum hits.
const MONITOR_HOLD_SECS = 0.25;
// Native sustain ceiling — a safety net for a missed note-off (stuck key /
// dropped MIDI). The note-off normally releases the voice well before this;
// without an off it auto-releases here instead of ringing forever.
const MONITOR_MAX_HOLD_SECS = 30;

// Held MIDI-out monitor notes, keyed by the same noteId the caller hands to
// monitorRelease. An instrument row has no audio voice to release — instead we
// remember which (port, channel, note) we sent note-on for, so note-off can
// close exactly that note on exactly that port. Module-level: a key release can
// land many ticks after the press, and across pattern swaps.
interface HeldMidiMonitor {
  deviceId: string;
  channel: number;
  note: number;
}
const heldMidiMonitors = new Map<number, HeldMidiMonitor>();

// Resolve the MIDI output port an instrument row sends to: its own portName,
// else the rig-wide default device. Null if neither resolves (no port → no
// monitor). Shared by every instrument-row monitor branch below.
function instrumentDevice(track: Track): string | null {
  const { midiOutDeviceId } = useSequencerStore.getState();
  return resolveDeviceId(track.midi.portName, midiOutDeviceId);
}

export function monitorNote(
  track: Track,
  soundingMidi: number,
  velocity: number,
  noteId: number,
): void {
  // Instrument (external-MIDI) rows: send a live note-on to the track's port
  // and remember it so monitorRelease sends the matching note-off when the key
  // lifts. Mirrors the engine's outNote rule (tick.ts): a fixed track.midi.note
  // (drum-style mapping) overrides the played pitch, else the keyboard's
  // sounding MIDI note plays through.
  if (track.source.kind === 'instrument') {
    const deviceId = instrumentDevice(track);
    if (!deviceId) return;
    const note = track.midi.note !== null ? track.midi.note : soundingMidi;
    sendMIDINoteOn(deviceId, track.midi.channel, note, velocity);
    heldMidiMonitors.set(noteId, { deviceId, channel: track.midi.channel, note });
    return;
  }
  if (track.source.kind !== 'voice') return;
  const voice = track.source.id;
  const env = resolveVoiceEnvelope(voice);

  const pick = samplePlayer.pickNativeSample(voice, soundingMidi, track.id);
  if (!pick) return;
  const out = track.output;
  const pan = ((track.pan ?? 0.5) - 0.5) * 2;
  void triggerSample(pick.path, {
    gain: velocity * pick.voiceGain * (track.gain ?? 1),
    pan,
    pitch: pick.pitch,
    outFirst: out?.firstChannel ?? 0,
    outStereo: out?.stereo ?? true,
    trackId: track.id,
    delaySecs: 0,
    monophonic: track.monophonic === true,
    // Manifest choke group — live-monitored hats choke each other the
    // same way pattern playback does.
    chokeGroup: pick.chokeGroup ?? undefined,
    section: 0,
    envelopeAttack: env?.attack,
    envelopeDecay: env?.decay,
    envelopeSustain: env?.sustain,
    envelopeRelease: env?.release,
    // Long hold so the voice sustains at its sustain level until note-off
    // releases it. Enveloped voices only — flat-gain voices (drums/leads)
    // ring for their sample length and the note-off ramp fades that.
    envelopeHold: env ? MONITOR_MAX_HOLD_SECS : undefined,
    noteId,
    start: pick.start,
    end: pick.end,
    loopMode: pick.loop,
    filterType: pick.filterType,
    cutoff: pick.cutoff,
    resonance: pick.resonance,
    lfoShape: pick.lfoShape,
    lfoRateHz: pick.lfoRateHz,
    lfoDepth: pick.lfoDepth,
    mods: pick.mods,
    granular: pick.granular,
  });
}

// Audition a CHORD on a track's voice. Used by the Launchpad chord page — press
// a pad, hear the chord, and it SUSTAINS while the pad is held, exactly like a
// keyboard-page note. The caller hands one monitor `noteId` per interval
// (parallel array); each tone is tagged with its id and triggered with a long
// hold, and the pad release ramps each id down via monitorChordRelease —
// without touching the track's pattern voices, which share the same trackId. One
// voice per interval, NOT monophonic so the tones sound together. `rootMidi` is
// the chord root the intervals are offsets from (already octave-applied by the
// caller); section 0 keeps auditions out of recording stems.
export function monitorChord(
  track: Track,
  rootMidi: number,
  intervals: number[],
  velocity: number,
  noteIds: number[],
): void {
  // Instrument row: open a live note per tone and remember each (port, channel,
  // note) under its noteId so monitorRelease sends the matching note-off when the
  // pad lifts. A fixed track.midi.note (rare on a chord row) collapses every tone
  // onto it; normally note is null so each interval sounds.
  if (track.source.kind === 'instrument') {
    const deviceId = instrumentDevice(track);
    if (!deviceId) return;
    intervals.forEach((interval, i) => {
      const note = track.midi.note !== null ? track.midi.note : rootMidi + interval;
      sendMIDINoteOn(deviceId, track.midi.channel, note, velocity);
      heldMidiMonitors.set(noteIds[i], { deviceId, channel: track.midi.channel, note });
    });
    return;
  }
  if (track.source.kind !== 'voice') return;
  const voice = track.source.id;
  const env = resolveVoiceEnvelope(voice);

  const out = track.output;
  const pan = ((track.pan ?? 0.5) - 0.5) * 2;
  intervals.forEach((interval, i) => {
    const pick = samplePlayer.pickNativeSample(voice, rootMidi + interval, track.id);
    if (!pick) return;
    void triggerSample(pick.path, {
      gain: velocity * pick.voiceGain * (track.gain ?? 1),
      pan,
      pitch: pick.pitch,
      outFirst: out?.firstChannel ?? 0,
      outStereo: out?.stereo ?? true,
      trackId: track.id,
      delaySecs: 0,
      monophonic: false,
      // First tone only — a per-tone choke would ramp out this chord's
      // own earlier tones (see the App.tsx dispatch path).
      chokeGroup: i === 0 && pick.chokeGroup ? pick.chokeGroup : undefined,
      section: 0,
      envelopeAttack: env?.attack,
      envelopeDecay: env?.decay,
      envelopeSustain: env?.sustain,
      envelopeRelease: env?.release,
      // Long hold so each tone sustains at its sustain level until the pad
      // release ramps it down (flat-gain voices ring their sample length).
      envelopeHold: env ? MONITOR_MAX_HOLD_SECS : undefined,
      noteId: noteIds[i],
      start: pick.start,
      end: pick.end,
      loopMode: pick.loop,
      filterType: pick.filterType,
      cutoff: pick.cutoff,
      resonance: pick.resonance,
      lfoShape: pick.lfoShape,
      lfoRateHz: pick.lfoRateHz,
      lfoDepth: pick.lfoDepth,
      mods: pick.mods,
      granular: pick.granular,
    });
  });
}

// Release every tone of a held chord audition — ramps each tagged voice down
// over the voice's own release time. Mirrors monitorRelease, one call per
// chord tone.
export function monitorChordRelease(track: Track, noteIds: number[]): void {
  for (const id of noteIds) monitorRelease(track, id);
}

// Trigger a drum/one-shot voice at its NATURAL pitch — fire-and-forget, no
// note id (one-shots ring their sample length, nothing to release). Passing no
// MIDI note makes pickNativeSample (and the web player) pick the base bank at
// pitch 1.0, so a pad hit sounds exactly like a sequenced drum step. Used by the
// Launchpad drum page for finger-drumming; velocity comes from pad pressure.
export function monitorDrum(track: Track, velocity: number): void {
  // Instrument row: a short scheduled on/off hit on the row's mapped drum note
  // (track.midi.note — the kit-note wiring; see the hardware kit maps). No
  // pitch to derive, so a row with no mapped note can't drum out — skip it.
  if (track.source.kind === 'instrument') {
    if (track.midi.note === null) return;
    const deviceId = instrumentDevice(track);
    if (!deviceId) return;
    sendMIDINote(
      deviceId,
      track.midi.channel,
      track.midi.note,
      velocity,
      getAudioContext().currentTime,
      MONITOR_HOLD_SECS,
    );
    return;
  }
  if (track.source.kind !== 'voice') return;
  const voice = track.source.id;

  const pick = samplePlayer.pickNativeSample(voice, undefined, track.id);
  if (!pick) return;
  const out = track.output;
  const pan = ((track.pan ?? 0.5) - 0.5) * 2;
  void triggerSample(pick.path, {
    gain: velocity * pick.voiceGain * (track.gain ?? 1),
    pan,
    pitch: pick.pitch,
    outFirst: out?.firstChannel ?? 0,
    outStereo: out?.stereo ?? true,
    trackId: track.id,
    delaySecs: 0,
    monophonic: track.monophonic === true,
    chokeGroup: pick.chokeGroup ?? undefined,
    section: 0, // SECTION_NONE — auditions stay out of recording stems
    start: pick.start,
    end: pick.end,
    loopMode: pick.loop,
    filterType: pick.filterType,
    cutoff: pick.cutoff,
    resonance: pick.resonance,
    lfoShape: pick.lfoShape,
    lfoRateHz: pick.lfoRateHz,
    lfoDepth: pick.lfoDepth,
    mods: pick.mods,
    granular: pick.granular,
  });
}

// Release a held monitor voice on note-off — ramps the tagged voice down over
// the voice's own release time (clean, no click).
export function monitorRelease(track: Track, noteId: number): void {
  // Instrument rows: close the live note we opened on note-on.
  const held = heldMidiMonitors.get(noteId);
  if (held) {
    heldMidiMonitors.delete(noteId);
    sendMIDINoteOff(held.deviceId, held.channel, held.note);
    return;
  }
  if (track.source.kind !== 'voice') return;
  const release = resolveVoiceEnvelope(track.source.id)?.release;
  void releaseNote(noteId, release);
}
