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
// The note SUSTAINS while the key is held (native path): each press tags its
// voice with a unique note id and triggers with a long hold, and the matching
// release (on note-off) ramps that exact voice down — without touching the
// armed track's pattern voices, which share the same trackId. So a held note
// rings for as long as you hold it, matching the tie it records. Section is
// SECTION_NONE so the live monitor never bleeds into recording stems.
//
// Web build: no targeted release exists on the Web Audio sample player, so it
// stays a short fire-and-forget audition (the web build isn't the recording
// target — the native engine is). monitorRelease is a no-op there.

import { isNativeAudioAvailable, triggerSample, releaseNote } from './nativeEngine';
import { getAudioContext } from './audioContext';
import { samplePlayer } from './samplePlayer';
import { voiceEnvelope } from './voices';
import type { Track } from '../state/store';

// Web audition window (fire-and-forget). Native sustains instead.
const MONITOR_HOLD_SECS = 0.25;
// Native sustain ceiling — a safety net for a missed note-off (stuck key /
// dropped MIDI). The note-off normally releases the voice well before this;
// without an off it auto-releases here instead of ringing forever.
const MONITOR_MAX_HOLD_SECS = 30;

export function monitorNote(
  track: Track,
  soundingMidi: number,
  velocity: number,
  noteId: number,
): void {
  // Internal voices only. Instrument (external-MIDI) rows would need a
  // note-on/off pair sent to the hardware port — deferred until there's a
  // workflow that records into a MIDI-out row.
  if (track.source.kind !== 'voice') return;
  const voice = track.source.id;
  const env = voiceEnvelope(voice);

  if (isNativeAudioAvailable()) {
    const pick = samplePlayer.pickNativeSample(voice, soundingMidi);
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
    });
    return;
  }

  // Web build — fire-and-forget audition (no targeted release available).
  samplePlayer.trigger(
    voice,
    getAudioContext().currentTime,
    velocity,
    soundingMidi,
    1, // gate
    MONITOR_HOLD_SECS, // step duration → hold window
    [0], // single tone
    track.pan,
    track.id,
    track.monophonic,
    undefined, // section = none (monitor stays out of recording stems)
  );
}

// Audition a CHORD on a track's voice (fire-and-forget). Used by the Launchpad
// chord page — tap a pad, hear the chord, nothing to release (tapping a
// progression rings each chord for ~AUDITION window then decays). One voice per
// interval, NOT monophonic so the tones sound together. `rootMidi` is the
// chord root the intervals are offsets from (already octave-applied by the
// caller); section 0 keeps auditions out of recording stems.
const AUDITION_HOLD_SECS = 1.0;
export function monitorChord(
  track: Track,
  rootMidi: number,
  intervals: number[],
  velocity: number,
): void {
  if (track.source.kind !== 'voice') return;
  const voice = track.source.id;
  const env = voiceEnvelope(voice);

  if (isNativeAudioAvailable()) {
    const out = track.output;
    const pan = ((track.pan ?? 0.5) - 0.5) * 2;
    for (const interval of intervals) {
      const pick = samplePlayer.pickNativeSample(voice, rootMidi + interval);
      if (!pick) continue;
      void triggerSample(pick.path, {
        gain: velocity * pick.voiceGain * (track.gain ?? 1),
        pan,
        pitch: pick.pitch,
        outFirst: out?.firstChannel ?? 0,
        outStereo: out?.stereo ?? true,
        trackId: track.id,
        delaySecs: 0,
        monophonic: false,
        section: 0,
        envelopeAttack: env?.attack,
        envelopeDecay: env?.decay,
        envelopeSustain: env?.sustain,
        envelopeRelease: env?.release,
        envelopeHold: env ? AUDITION_HOLD_SECS : undefined,
      });
    }
    return;
  }

  // Web build — fire-and-forget chord audition.
  samplePlayer.trigger(
    voice,
    getAudioContext().currentTime,
    velocity,
    rootMidi,
    1,
    AUDITION_HOLD_SECS,
    intervals,
    track.pan,
    track.id,
    false,
    undefined,
  );
}

// Release a held monitor voice on note-off. Native only — ramps the tagged
// voice down over the voice's own release time (clean, no click). No-op on the
// web build, where the audition already fired and ended on its own.
export function monitorRelease(track: Track, noteId: number): void {
  if (!isNativeAudioAvailable()) return;
  if (track.source.kind !== 'voice') return;
  const release = voiceEnvelope(track.source.id)?.release;
  void releaseNote(noteId, release);
}
