// Built-in controller mapping presets. Each preset returns a full
// MidiBinding[] that the mapping store installs as a one-shot user map
// (see MidiBar's "+ Launch Control XL3" button → createUserMap).
//
// Launch Control XL3 (captured 2026-05-29 from the device's factory custom
// mode — all on MIDI port, channel 1):
//   faders        CC 5..12
//   top knobs     CC 13..20
//   middle knobs  CC 21..28
//   bottom knobs  CC 29..36
//   buttons (2×8) CC 37..44 (top row), 45..52 (bottom row) — latching toggles
//                 that alternate 127/0 per press; mute/solo direct-set from
//                 the value so the device latch is the source of truth.
//
// Layout (Chris's mixer-strip spec): top knob row = sequencer-level macros,
// then per-channel mutation / filter / volume down each column, with mute +
// solo on the two button rows. The 8 columns address one group of 8 tracks
// (default = the melodic/lead rows, tracks 8..15); pass trackBase=0 for drums.

import type { MidiBinding } from './midiMap';

const FADER_CC = [5, 6, 7, 8, 9, 10, 11, 12];
const TOP_KNOB_CC = [13, 14, 15, 16, 17, 18, 19, 20];
const MID_KNOB_CC = [21, 22, 23, 24, 25, 26, 27, 28];
const BOT_KNOB_CC = [29, 30, 31, 32, 33, 34, 35, 36];
const TOP_BTN_CC = [37, 38, 39, 40, 41, 42, 43, 44];
const BOT_BTN_CC = [45, 46, 47, 48, 49, 50, 51, 52];

// Top knob row: 5 Ghost macros + 3 master-output knobs.
const TOP_KNOB_TARGETS = [
  'macro:density',
  'macro:chaos',
  'macro:motion',
  'macro:drift',
  'macro:tension',
  'fx:master.input',
  'fx:master.drive',
  'fx:master.mix',
] as const;

/**
 * Build the Launch Control XL3 mixer-strip mapping. The 8 columns are
 * view-relative — they address the Nth track of whatever section is on screen
 * (rhythm → drums, melody → leads), so the surface follows the page toggle
 * instead of pinning to fixed track indices.
 */
export function launchControlXL3Bindings(): MidiBinding[] {
  // midiIn parses channel 0-based (status & 0x0f), so the XL3's MIDI
  // channel 1 arrives as ch:0. Bindings match on that 0-based value.
  // `relative` flags the endless encoders: they only send absolute 0..127,
  // so the dispatcher treats them as deltas (no jump when the page flips).
  const cc = (num: number, target: string, relative = false): MidiBinding => ({
    ch: 0,
    msg: 'cc',
    num,
    target: target as MidiBinding['target'],
    ...(relative ? { relative: true } : {}),
  });
  const bindings: MidiBinding[] = [];

  // Top knob row → sequencer-level (global) controls. Encoders → relative.
  for (let i = 0; i < 8; i++) bindings.push(cc(TOP_KNOB_CC[i], TOP_KNOB_TARGETS[i], true));

  // Per-channel rows. Column i → the i-th track of the active view section.
  // Knob rows are encoders (relative); faders are physical (absolute, pickup);
  // buttons are the latching mute/solo toggles (direct-set from value).
  for (let i = 0; i < 8; i++) {
    bindings.push(cc(MID_KNOB_CC[i], `track:view:${i}:mutation`, true));
    bindings.push(cc(BOT_KNOB_CC[i], `track:view:${i}:filterCutoff`, true));
    bindings.push(cc(FADER_CC[i], `track:view:${i}:gain`));
    bindings.push(cc(TOP_BTN_CC[i], `track:view:${i}:mute`));
    bindings.push(cc(BOT_BTN_CC[i], `track:view:${i}:solo`));
  }

  return bindings;
}

export const LAUNCH_CONTROL_XL3_PRESET_NAME = 'Launch Control XL3';
