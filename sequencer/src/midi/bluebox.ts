// Bluebox mixer model + CC emission.
//
// The XL3 "mixer" page (launchControlXL3Bindings) drives these setters; each
// updates the app-side mix state AND emits a CC to the configured Bluebox
// output port. Keeping the state HERE (rather than firing CC straight from the
// XL3 handler) is the "app-in-the-middle" design: it lets the XL3's encoder
// rings + button LEDs reflect current values, and lets Ghost drive the same
// mix moves later through the exact same setters.
//
// Bluebox MIDI mapping: one CC per control, one control per CC, but ANY CC and
// all on one channel is fine (manual p.45). So we pick a clean block on MIDI
// channel 1. The learn-pass checklist on the unit = each row below × channel.
//
// State is intentionally NOT persisted: the Bluebox holds its own mix and can't
// report it back (open-loop), so app state is just our running belief, seeded
// to sensible defaults each launch. Faders use pickup so a page-flip doesn't
// jump a level; the first encoder/button move resyncs that param both ways.

import { useSequencerStore } from '../state/store';
import { sendMIDIControlChange } from '../audio/midiOut';

// MIDI channel 1 (0-indexed). One channel carries every mixer CC.
export const BLUEBOX_MIDI_CHANNEL = 0;

// The 8 Bluebox mixer channels, in fader/column order (1-based on the unit:
// 1 Drums · 2 Pads · 3 Vector · 4 Bass · 5 Leads · 6 Noise · 7 Loops · 8 spare).
// Labels are ≤5 chars to fit the XL3 per-control display field. Rename freely —
// these are display-only; the CC binding is fixed per column.
export const BLUEBOX_CHANNELS = [
  'DRUMS',
  'PADS',
  'VECTR',
  'BASS',
  'LEADS',
  'NOISE',
  'LOOPS',
  'SPARE',
] as const;
export const BLUEBOX_CH_COUNT = BLUEBOX_CHANNELS.length;

// CC blocks: channel c uses (base + c). All on BLUEBOX_MIDI_CHANNEL.
//   level 21-26 · reverb 31-36 · delay 41-46 · pan 51-56 · mute 61-66 · solo 71-76
const CC_LEVEL = 21;
const CC_REVERB = 31;
const CC_DELAY = 41;
const CC_PAN = 51;
const CC_MUTE = 61;
const CC_SOLO = 71;

export interface BlueboxChannelState {
  level: number; // 0..127
  reverb: number; // 0..127
  delay: number; // 0..127
  pan: number; // 0..127 (64 = center)
  mute: boolean;
  solo: boolean;
}

function defaultChannel(): BlueboxChannelState {
  return { level: 100, reverb: 0, delay: 0, pan: 64, mute: false, solo: false };
}

const mixer: BlueboxChannelState[] = Array.from({ length: BLUEBOX_CH_COUNT }, defaultChannel);

export function blueboxChannel(c: number): BlueboxChannelState | null {
  return mixer[c] ?? null;
}

function port(): string | null {
  return useSequencerStore.getState().blueboxPort;
}

function clamp127(v: number): number {
  return Math.max(0, Math.min(127, Math.round(v)));
}

function emit(cc: number, value: number): void {
  const p = port();
  if (!p) return; // no Bluebox destination configured — state-only
  sendMIDIControlChange(p, BLUEBOX_MIDI_CHANNEL, cc, clamp127(value));
}

// --- continuous setters: clamp, store, emit (value is raw 0..127) ---
export function setBlueboxLevel(c: number, value: number): void {
  const ch = mixer[c];
  if (!ch) return;
  ch.level = clamp127(value);
  emit(CC_LEVEL + c, ch.level);
}
export function setBlueboxReverb(c: number, value: number): void {
  const ch = mixer[c];
  if (!ch) return;
  ch.reverb = clamp127(value);
  emit(CC_REVERB + c, ch.reverb);
}
export function setBlueboxDelay(c: number, value: number): void {
  const ch = mixer[c];
  if (!ch) return;
  ch.delay = clamp127(value);
  emit(CC_DELAY + c, ch.delay);
}
export function setBlueboxPan(c: number, value: number): void {
  const ch = mixer[c];
  if (!ch) return;
  ch.pan = clamp127(value);
  emit(CC_PAN + c, ch.pan);
}

// --- switches: app-side latching toggle that emits the ABSOLUTE target value
// (127 = on, 0 = off). The Bluebox switch is value-following (high = engaged),
// so holding the value high latches and a 0 releases — giving a clean toggle
// from a momentary button, and a clean on/off gesture for MIDI-learn to catch.
// (Confirmed via manual: Bluebox maps everything as Channel:CC, not notes.)
// Returns the new state so the caller can light the button LED. ---
export function toggleBlueboxMute(c: number): boolean {
  const ch = mixer[c];
  if (!ch) return false;
  ch.mute = !ch.mute;
  emit(CC_MUTE + c, ch.mute ? 127 : 0);
  return ch.mute;
}
export function toggleBlueboxSolo(c: number): boolean {
  const ch = mixer[c];
  if (!ch) return false;
  ch.solo = !ch.solo;
  emit(CC_SOLO + c, ch.solo ? 127 : 0);
  return ch.solo;
}
