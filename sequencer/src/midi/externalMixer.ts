// External mixer control — profile-driven mix state + CC emission.
//
// The XL3 "mixer" page (launchControlXL3Bindings) drives these setters; each
// updates the app-side mix state AND emits a CC to the configured output port.
// Keeping the state HERE (rather than firing CC straight from the XL3 handler)
// is the "app-in-the-middle" design: it lets the XL3's encoder rings + button
// LEDs reflect current values, and lets Ghost drive the same mix moves later
// through the exact same setters.
//
// WHICH mixer is being driven is data, not code: an ExternalMixerProfile
// carries the channel labels, channel count, MIDI channel, and CC block
// layout. Profiles ship as built-in presets (currently the 1010music Bluebox
// mapping). No profile selected = the feature is dark — the XL3 mixer page
// won't engage and nothing is emitted.
//
// State is intentionally NOT persisted: hardware mixers hold their own mix and
// can't report it back (open-loop), so app state is just our running belief,
// seeded to sensible defaults each launch. Faders use pickup so a page-flip
// doesn't jump a level; the first encoder/button move resyncs that param.

import { useSequencerStore } from '../state/store';
import { sendMIDIControlChange } from '../audio/midiOut';

// CC block bases: mixer channel c uses (base + c), all on the profile's
// MIDI channel.
export interface ExternalMixerCcBlocks {
  level: number;
  reverb: number;
  delay: number;
  pan: number;
  mute: number;
  solo: number;
}

export interface ExternalMixerProfile {
  id: string;
  // Shown in the settings row and on the XL3 display banner.
  name: string;
  // 0-indexed MIDI channel carrying every mixer CC.
  midiChannel: number;
  // Column labels in fader order (≤5 chars to fit the XL3 per-control display
  // field). Length = channel count; max 8 (the XL3 has 8 columns).
  channels: readonly string[];
  cc: ExternalMixerCcBlocks;
}

// Built-in profiles. bluebox: the unit maps anything as one CC per control on
// any channel (manual p.45), so the preset is a clean block on MIDI channel 1
// MIDI-learned onto the unit — level 21-28 · reverb 31-38 · delay 41-48 ·
// pan 51-58 · mute 61-68 · solo 71-78.
export const EXTERNAL_MIXER_PRESETS: readonly ExternalMixerProfile[] = [
  {
    id: 'bluebox',
    name: 'bluebox',
    midiChannel: 0,
    channels: ['DRUMS', 'PADS', 'VECTR', 'BASS', 'LEADS', 'NOISE', 'LOOPS', 'SPARE'],
    cc: { level: 21, reverb: 31, delay: 41, pan: 51, mute: 61, solo: 71 },
  },
];

// The active profile, resolved from the persisted store selection. null =
// feature off.
export function activeMixerProfile(): ExternalMixerProfile | null {
  const id = useSequencerStore.getState().externalMixerProfileId;
  if (!id) return null;
  return EXTERNAL_MIXER_PRESETS.find((p) => p.id === id) ?? null;
}

export interface MixerChannelState {
  level: number; // 0..127
  reverb: number; // 0..127
  delay: number; // 0..127
  pan: number; // 0..127 (64 = center)
  mute: boolean;
  solo: boolean;
}

function defaultChannel(): MixerChannelState {
  return { level: 100, reverb: 0, delay: 0, pan: 64, mute: false, solo: false };
}

// Mix state, rebuilt (re-seeded to defaults) when the active profile changes —
// a different mixer means our running belief about the old one is meaningless.
let stateProfileId: string | null = null;
let mixer: MixerChannelState[] = [];

function ensureState(profile: ExternalMixerProfile): void {
  if (stateProfileId === profile.id && mixer.length === profile.channels.length) return;
  stateProfileId = profile.id;
  mixer = Array.from({ length: profile.channels.length }, defaultChannel);
}

export function mixerChannel(c: number): MixerChannelState | null {
  const profile = activeMixerProfile();
  if (!profile) return null;
  ensureState(profile);
  return mixer[c] ?? null;
}

function clamp127(v: number): number {
  return Math.max(0, Math.min(127, Math.round(v)));
}

function emit(profile: ExternalMixerProfile, cc: number, value: number): void {
  const port = useSequencerStore.getState().externalMixerPort;
  if (!port) return; // no destination configured — state-only
  sendMIDIControlChange(port, profile.midiChannel, cc, clamp127(value));
}

// --- continuous setters: clamp, store, emit (value is raw 0..127) ---
function setContinuous(c: number, key: 'level' | 'reverb' | 'delay' | 'pan', value: number): void {
  const profile = activeMixerProfile();
  if (!profile) return;
  ensureState(profile);
  const ch = mixer[c];
  if (!ch) return;
  ch[key] = clamp127(value);
  emit(profile, profile.cc[key] + c, ch[key]);
}

export function setMixerLevel(c: number, value: number): void {
  setContinuous(c, 'level', value);
}
export function setMixerReverb(c: number, value: number): void {
  setContinuous(c, 'reverb', value);
}
export function setMixerDelay(c: number, value: number): void {
  setContinuous(c, 'delay', value);
}
export function setMixerPan(c: number, value: number): void {
  setContinuous(c, 'pan', value);
}

// --- switches: app-side latching toggle that emits the ABSOLUTE target value
// (127 = on, 0 = off). Value-following switches (high = engaged) latch on the
// held value and release on 0 — a clean toggle from a momentary button, and a
// clean on/off gesture for MIDI-learn to catch. Returns the new state so the
// caller can light the button LED. ---
function toggleSwitch(c: number, key: 'mute' | 'solo'): boolean {
  const profile = activeMixerProfile();
  if (!profile) return false;
  ensureState(profile);
  const ch = mixer[c];
  if (!ch) return false;
  ch[key] = !ch[key];
  emit(profile, profile.cc[key] + c, ch[key] ? 127 : 0);
  return ch[key];
}

export function toggleMixerMute(c: number): boolean {
  return toggleSwitch(c, 'mute');
}
export function toggleMixerSolo(c: number): boolean {
  return toggleSwitch(c, 'solo');
}
