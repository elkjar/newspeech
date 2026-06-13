// Bind the Launch Control XL3 (DAW mode) to the sequencer store.
//
// Layout (Chris's mixer-strip spec, now hardware-viable via value-sync):
//   top encoder row    → sequencer macros: density·motion·drift·chaos·tension
//                        + master input·drive·mix  (global, don't follow page;
//                        order matches the on-screen MacroStrip)
//   middle encoder row → per-channel mutation   (follows the rhythm/melody page)
//   bottom encoder row → per-channel filter cutoff (follows page)
//   faders             → per-channel volume (gain) — physical, soft-takeover
//   top button row     → per-channel mute   (toggle; LED white = muted)
//   bottom button row  → per-channel solo   (toggle; LED white = soloed)
//   transport play     → start/stop
//   transport record   → arm the FOCUSED (selected) channel for MIDI recording
//                        (LED white = focused channel armed)
//   transport ◀ / ▶    → select rhythm (drum) / melody view
//
// VALUE-SYNC is the trick that makes the absolute, can't-do-relative encoders
// usable: we keep each encoder's device-side position written to match its
// parameter. A turn maps 1:1 to the value; when a param changes elsewhere
// (Ghost, on-screen, or a rhythm/melody page flip) we rewrite the encoder
// position so the hardware tracks it — so the user's hand never causes a jump.
// Faders can't be host-moved (physical), so they use pickup instead.

import { useSequencerStore, type Track } from '../state/store';
import { togglePlayback } from '../audio/transport';
import { modulated, GLOBAL_TRACK_ID, type LFODestKnob } from '../audio/lfo';
import {
  onXL3Event,
  onXL3ConnectionChange,
  setEncoderValue,
  setEncoderLed,
  setButtonLed,
  setPlayLed,
  setRecordLed,
  setTrackLeftLed,
  setTrackRightLed,
  type XL3Event,
} from './launchControlXL3';
import { sourceIsMelodic } from '../instruments/library';

type StoreState = ReturnType<typeof useSequencerStore.getState>;

const ENC_COUNT = 24;
const BTN_COUNT = 16;
const LED_ON = 127;
const LED_OFF = 0;
const PICKUP_EPS = 1 / 127;
const LED_TICK_MS = 33; // ~30 Hz LED animation for LFO-reactive encoder lights

let ledTick: ReturnType<typeof setInterval> | null = null;

// Top row, encoders 0..7 → globals (don't follow the page). 0..4 = the 5
// macros (order MATCHES the on-screen MacroStrip: density · motion · drift ·
// chaos · tension); 5..7 = FX mix for tape · glitch · reverb. `lfoKnob` is the
// LFO destination name so the LED can show the live modulated value.
interface GlobalTarget {
  get: (s: StoreState) => number;
  set: (s: StoreState, v: number) => void;
  lfoKnob: LFODestKnob;
}
const TOP_TARGETS: GlobalTarget[] = [
  { get: (s) => s.density, set: (s, v) => s.setDensity(v), lfoKnob: 'density' },
  { get: (s) => s.motion, set: (s, v) => s.setMotion(v), lfoKnob: 'motion' },
  { get: (s) => s.drift, set: (s, v) => s.setDrift(v), lfoKnob: 'drift' },
  { get: (s) => s.chaos, set: (s, v) => s.setChaos(v), lfoKnob: 'chaos' },
  { get: (s) => s.tension, set: (s, v) => s.setTension(v), lfoKnob: 'tension' },
  { get: (s) => s.tape.mix, set: (s, v) => s.setTape({ mix: v }), lfoKnob: 'tapeMix' },
  { get: (s) => s.glitch.mix, set: (s, v) => s.setGlitch({ mix: v }), lfoKnob: 'glitchMix' },
  { get: (s) => s.reverb.mix, set: (s, v) => s.setReverb({ mix: v }), lfoKnob: 'reverbMix' },
];

let attached = false;
let unsubs: Array<() => void> = [];
// Last position we believe each encoder holds (sent OR received). Drives the
// diff so we don't fight the user's hand while they turn.
const lastEncPos: number[] = new Array(ENC_COUNT).fill(-1);
// White LED level per encoder ring, reflecting its value (brightness = value).
const lastEncLed: number[] = new Array(ENC_COUNT).fill(-1);
const lastBtnLed: number[] = new Array(BTN_COUNT).fill(-1);
let lastPlayLed = -1;
let lastRecordLed = -1;
let lastTrackLeftLed = -1;
let lastTrackRightLed = -1;
// Fader soft-takeover: engage only once the fader crosses the live value.
const faderPickup: Array<{ trackId: string; engaged: boolean; lastIn: number } | null> =
  new Array(8).fill(null);

function viewTracks(s: StoreState): Track[] {
  return s.tracks.filter((t) => t.section === s.viewSection).slice(0, 8);
}

// The "selected" channel the Record button arms — same channel the on-screen
// piano roll / step inspector reflect (focusedTrackId, the target the Launchpad
// channel switcher sets). Mirrors PianoRoll.resolveFocusedTrack's fallback so a
// press is never a dead no-op before anything's been explicitly focused.
function focusedTrack(s: StoreState): Track | null {
  if (s.focusedTrackId) {
    const t = s.tracks.find((t) => t.id === s.focusedTrackId);
    if (t) return t;
  }
  return (
    s.tracks.find((t) => sourceIsMelodic(t.source)) ??
    s.tracks.find((t) => t.source.kind !== 'empty') ??
    s.tracks[0] ??
    null
  );
}

// Base 0..1 value for each encoder index (the stored param, pre-LFO). null =
// no track at that column → encoder dark, no position write.
function encoderValue01(s: StoreState, i: number): number | null {
  if (i < 8) return TOP_TARGETS[i].get(s);
  const col = (i - 8) % 8;
  const track = viewTracks(s)[col];
  if (!track) return null;
  if (i < 16) return track.mutation;
  return track.filterCutoff;
}

function applyEncoder(s: StoreState, i: number, value: number): void {
  const v01 = value / 127;
  if (i < 8) {
    TOP_TARGETS[i].set(s, v01);
    return;
  }
  const col = (i - 8) % 8;
  const track = viewTracks(s)[col];
  if (!track) return;
  if (i < 16) s.setTrackMutation(track.id, v01);
  else s.setTrackFilterCutoff(track.id, v01);
}

// Live 0..1 value INCLUDING any assigned LFO modulation — drives the LED so it
// breathes with the LFO. Falls back to the base value when nothing is routed.
function encoderLiveValue01(s: StoreState, i: number): number | null {
  if (i < 8) return modulated(TOP_TARGETS[i].get(s), s.lfos, GLOBAL_TRACK_ID, TOP_TARGETS[i].lfoKnob);
  const col = (i - 8) % 8;
  const track = viewTracks(s)[col];
  if (!track) return null;
  const knob: LFODestKnob = i < 16 ? 'mutation' : 'filterCutoff';
  const base = i < 16 ? track.mutation : track.filterCutoff;
  return modulated(base, s.lfos, track.id, knob);
}

// Write encoder positions to match the BASE param value (so the encoder's
// counter tracks where the user set it — value-sync, no jump on page-flip).
// Diffed so we never re-send a value the encoder already reports. LEDs are
// handled separately by the animation tick (they follow the LIVE/modulated
// value so LFOs breathe).
function syncEncoders(): void {
  const s = useSequencerStore.getState();
  for (let i = 0; i < ENC_COUNT; i++) {
    const v01 = encoderValue01(s, i);
    if (v01 === null) continue; // unused slot / no track — leave dark
    const pos = Math.round(v01 * 127);
    if (Math.abs(pos - lastEncPos[i]) > 1) {
      setEncoderValue(i, pos);
      lastEncPos[i] = pos;
    }
  }
}

// LED animation tick: light each encoder white at a brightness reflecting its
// LIVE (LFO-modulated) value, so an assigned LFO makes the light breathe.
// Diffed so static encoders send nothing; unused slots stay dark. ~30 Hz.
function tickEncoderLeds(): void {
  const s = useSequencerStore.getState();
  for (let i = 0; i < ENC_COUNT; i++) {
    const v01 = encoderLiveValue01(s, i);
    const led = v01 === null ? 0 : Math.round(v01 * 127);
    if (led === lastEncLed[i]) continue;
    setEncoderLed(i, led);
    lastEncLed[i] = led;
  }
}

// Button LEDs: top row = mute, bottom row = solo, white when active. Plus the
// transport play button, lit while playing.
function syncButtonLeds(): void {
  const s = useSequencerStore.getState();
  const tracks = viewTracks(s);
  for (let i = 0; i < BTN_COUNT; i++) {
    const col = i % 8;
    const track = tracks[col];
    let level = LED_OFF;
    if (track) level = (i < 8 ? track.mute : track.solo) ? LED_ON : LED_OFF;
    if (level === lastBtnLed[i]) continue;
    setButtonLed(i, level);
    lastBtnLed[i] = level;
  }
  const playLed = s.playing ? LED_ON : LED_OFF;
  if (playLed !== lastPlayLed) {
    setPlayLed(playLed);
    lastPlayLed = playLed;
  }
  // Record button reflects the focused (selected) channel's arm state.
  const ft = focusedTrack(s);
  const recordLed = ft?.inputArmed ? LED_ON : LED_OFF;
  if (recordLed !== lastRecordLed) {
    setRecordLed(recordLed);
    lastRecordLed = recordLed;
  }
  // Track ◀/▶ show the active section: ◀ lit on rhythm (drum), ▶ on melody.
  const leftLed = s.viewSection === 'drum' ? LED_ON : LED_OFF;
  const rightLed = s.viewSection === 'melodic' ? LED_ON : LED_OFF;
  if (leftLed !== lastTrackLeftLed) {
    setTrackLeftLed(leftLed);
    lastTrackLeftLed = leftLed;
  }
  if (rightLed !== lastTrackRightLed) {
    setTrackRightLed(rightLed);
    lastTrackRightLed = rightLed;
  }
}

function syncSurface(): void {
  syncEncoders();
  syncButtonLeds();
}

function handleEvent(e: XL3Event): void {
  const s = useSequencerStore.getState();
  if (e.kind === 'encoder') {
    // Record the reported position so syncEncoders won't write it back, then
    // apply 1:1. Value-sync keeps device + param aligned, so no jump. The LED
    // follows on the next animation tick (≤33ms).
    lastEncPos[e.index] = e.value;
    applyEncoder(s, e.index, e.value);
    return;
  }
  if (e.kind === 'fader') {
    const track = viewTracks(s)[e.index];
    if (!track) return;
    const cur01 = Math.min(1, track.gain / 2);
    const in01 = e.value / 127;
    let st = faderPickup[e.index];
    if (!st || st.trackId !== track.id) {
      const engaged = Math.abs(in01 - cur01) <= PICKUP_EPS;
      faderPickup[e.index] = { trackId: track.id, engaged, lastIn: in01 };
      if (!engaged) return;
    } else if (!st.engaged) {
      const crossed =
        Math.abs(in01 - cur01) <= PICKUP_EPS ||
        (st.lastIn < cur01 && in01 >= cur01) ||
        (st.lastIn > cur01 && in01 <= cur01);
      st.lastIn = in01;
      if (!crossed) return;
      st.engaged = true;
    } else {
      st.lastIn = in01;
    }
    s.setTrackGain(track.id, in01 * 2);
    return;
  }
  if (e.kind === 'transport') {
    if (!e.pressed) return; // momentary; act on press
    // Play through the same helper the UI uses (full audio/scheduler lifecycle).
    if (e.transport === 'play') void togglePlayback();
    // Record → toggle the focused (selected) channel's MIDI record arm — the
    // same arm the Track-row dot + Launchpad drum top row drive (single-target
    // for melodic, multi for drums; setTrackInputArmed handles that). Lets you
    // arm the live-playing channel from the controller, no laptop.
    else if (e.transport === 'record') {
      const t = focusedTrack(s);
      if (t) s.setTrackInputArmed(t.id, !t.inputArmed);
    }
    // Track ◀ / ▶ → select rhythm (drum) / melody view. Drives the same
    // viewSection the on-screen toggle + per-channel rows follow.
    else if (e.transport === 'trackLeft') s.setViewSection('drum');
    else if (e.transport === 'trackRight') s.setViewSection('melodic');
    return;
  }
  // button — momentary; act on press, toggle the boolean. LED follows via the
  // store subscription (syncButtonLeds).
  if (!e.pressed) return;
  const col = e.index % 8;
  const track = viewTracks(s)[col];
  if (!track) return;
  if (e.index < 8) s.setTrackMute(track.id, !track.mute);
  else s.setTrackSolo(track.id, !track.solo);
}

// Signature of everything the surface reflects — re-sync only when it changes
// (not on every globalStep tick during playback).
function surfaceSignature(): string {
  const s = useSequencerStore.getState();
  let sig = `${s.playing ? 'P' : 's'}|${s.viewSection}|${s.density},${s.chaos},${s.motion},${s.drift},${s.tension}`;
  sig += `|${s.tape.mix},${s.glitch.mix},${s.reverb.mix}|`;
  // Focused channel + its arm state drive the Record LED. The focused track may
  // be in the other section (viewTracks won't cover it), so track it explicitly.
  const ft = focusedTrack(s);
  sig += `R${ft?.id ?? '-'}:${ft?.inputArmed ? 1 : 0}|`;
  for (const t of viewTracks(s)) {
    sig += `${t.id}:${t.mutation},${t.filterCutoff},${t.gain},${t.mute ? 1 : 0},${t.solo ? 1 : 0};`;
  }
  return sig;
}

export function attachXL3Bindings(): void {
  if (attached) return;
  attached = true;
  // Full sync on attach so the hardware matches current state immediately.
  resetState();
  syncSurface();

  unsubs.push(onXL3Event(handleEvent));

  // Re-sync on any surface-relevant store change (page flip, Ghost moving a
  // macro, on-screen edits, mute/solo). Filtered by signature so playback
  // ticks don't churn it.
  let prevSig = surfaceSignature();
  unsubs.push(
    useSequencerStore.subscribe(() => {
      const sig = surfaceSignature();
      if (sig === prevSig) return;
      const sectionChanged = sig.split('|')[1] !== prevSig.split('|')[1];
      prevSig = sig;
      // On a page flip the addressed tracks change, so fader pickup must re-arm.
      if (sectionChanged) for (let i = 0; i < 8; i++) faderPickup[i] = null;
      syncSurface();
    })
  );

  // Re-sync when the device (re)connects.
  unsubs.push(
    onXL3ConnectionChange(() => {
      resetState();
      syncSurface();
    })
  );

  // Animate encoder LEDs from the live (LFO-modulated) values. Diffed, so it's
  // quiet unless something is actually moving (an LFO, or a turn landing).
  if (ledTick === null) ledTick = setInterval(tickEncoderLeds, LED_TICK_MS);
}

function resetState(): void {
  for (let i = 0; i < ENC_COUNT; i++) {
    lastEncPos[i] = -1;
    lastEncLed[i] = -1;
  }
  for (let i = 0; i < BTN_COUNT; i++) lastBtnLed[i] = -1;
  lastPlayLed = -1;
  lastRecordLed = -1;
  lastTrackLeftLed = -1;
  lastTrackRightLed = -1;
  for (let i = 0; i < 8; i++) faderPickup[i] = null;
}

export function detachXL3Bindings(): void {
  if (!attached) return;
  if (ledTick !== null) {
    clearInterval(ledTick);
    ledTick = null;
  }
  for (const u of unsubs) u();
  unsubs = [];
  attached = false;
  resetState();
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    detachXL3Bindings();
  });
}
