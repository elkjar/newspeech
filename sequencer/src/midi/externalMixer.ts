// External mixer control — profile-driven mix state + CC emission.
//
// The XL3 "mixer" page (launchControlXL3Bindings) drives these setters; each
// updates the app-side mix state AND emits a CC to the configured output port.
// Keeping the state HERE (rather than firing CC straight from the XL3 handler)
// is the "app-in-the-middle" design: it lets the XL3's encoder rings + button
// LEDs reflect current values, and lets Ghost drive the same mix moves later
// through the exact same setters.
//
// WHICH mixer is being driven, and what each control row does, is a FILE:
// one `<id>.mixer` JSON per mixer in the instruments folder (the same folder
// as the .midiinstrument files, so it follows the Dropbox override). The file
// carries the channel labels, the MIDI channel, and one entry per control row
// (faders, up to three encoder rows, up to two button rows) with its label and
// CC numbers. Files are re-read on window focus, so an edit shows up on the
// next switch back to the app. The built-in profile below is only the fallback
// for a machine with no file; a file with the same id replaces it. No profile
// selected = the feature is dark — the XL3 mixer page won't engage and nothing
// is emitted.
//
// File format (see MixerFile below):
//   {
//     "schema": "newspeech.mixer", "version": 1,
//     "name": "bluebox",
//     "midiChannel": 1,                       // 1..16
//     "channels": ["DRUMS", "SYNTH", ...],    // ≤ 8, ≤ 5 chars each
//     "faders":   { "label": "LVL", "cc": 21, "default": 100 },
//     "encoders": [ { "label": "RVB", "cc": 31 }, ... ],   // top row first, ≤ 3
//     "buttons":  [ { "label": "MUTE", "cc": 61 }, ... ]   // top row first, ≤ 2
//   }
// "cc" is either a base number (channel c sends base + c) or a list with one
// CC per channel. "default" is the value the app assumes at launch (0..127).
//
// State is intentionally NOT persisted: hardware mixers hold their own mix and
// can't report it back (open-loop), so app state is just our running belief,
// seeded to each row's default every launch. Faders use pickup so a page-flip
// doesn't jump a level; the first encoder/button move resyncs that param.

import { invoke } from '@tauri-apps/api/core';
import { useSequencerStore } from '../state/store';
import { sendMIDIControlChange } from '../audio/midiOut';
import { resolveInstrumentsDir } from '../instruments/instrumentsDir';

const EXT = 'mixer';
const SCHEMA = 'newspeech.mixer';
const MAX_CHANNELS = 8; // XL3 columns
const MAX_ENCODER_ROWS = 3;
const MAX_BUTTON_ROWS = 2;
const LABEL_CHARS = 5; // fits the XL3 per-control display field

// One row of controls across the mixer's channels.
export interface MixerControlRow {
  // Shown after the channel name on the XL3 display ("DRUMS RVB").
  label: string;
  // One CC per channel, in channel order.
  cc: readonly number[];
  // Value assumed at launch, 0..127 (buttons: > 0 = on).
  initial: number;
}

export interface ExternalMixerProfile {
  id: string;
  // Shown in the settings row and on the XL3 display banner.
  name: string;
  // 0-indexed MIDI channel carrying every mixer CC.
  midiChannel: number;
  // Column labels in fader order. Length = channel count.
  channels: readonly string[];
  fader: MixerControlRow | null;
  // Encoder rows, top first.
  encoders: readonly MixerControlRow[];
  // Button rows, top first.
  buttons: readonly MixerControlRow[];
  // File the profile came from, or null for the built-in fallback.
  path: string | null;
}

// On-disk shape. Everything but `channels` has a default.
interface MixerFileRow {
  label?: string;
  cc?: number | number[];
  default?: number;
}
interface MixerFile {
  schema?: string;
  version?: number;
  id?: string;
  name?: string;
  midiChannel?: number;
  channels?: string[];
  faders?: MixerFileRow | null;
  encoders?: MixerFileRow[];
  buttons?: MixerFileRow[];
}

function clamp127(v: number): number {
  return Math.max(0, Math.min(127, Math.round(v)));
}

function parseRow(raw: MixerFileRow, what: string, chCount: number): MixerControlRow {
  if (!raw || typeof raw !== 'object') throw new Error(`${what}: not an object`);
  let cc: number[];
  if (Array.isArray(raw.cc)) {
    if (raw.cc.length < chCount) {
      throw new Error(`${what}: "cc" lists ${raw.cc.length} numbers for ${chCount} channels`);
    }
    cc = raw.cc.slice(0, chCount);
  } else if (typeof raw.cc === 'number') {
    const base = raw.cc;
    cc = Array.from({ length: chCount }, (_, c) => base + c);
  } else {
    throw new Error(`${what}: missing "cc"`);
  }
  for (const n of cc) {
    if (!Number.isInteger(n) || n < 0 || n > 127) {
      throw new Error(`${what}: cc ${n} is outside 0..127`);
    }
  }
  const label = typeof raw.label === 'string' ? raw.label.trim().toUpperCase() : '';
  const initial = typeof raw.default === 'number' ? clamp127(raw.default) : 0;
  return { label, cc, initial };
}

// Parse one .mixer file. Throws with a readable reason on anything unusable.
export function parseMixerFile(text: string, id: string, path: string): ExternalMixerProfile {
  const raw = JSON.parse(text) as MixerFile;
  if (!raw || raw.schema !== SCHEMA) throw new Error(`"schema" is not "${SCHEMA}"`);
  if (!Array.isArray(raw.channels) || raw.channels.length === 0) {
    throw new Error('"channels" is missing or empty');
  }
  if (raw.channels.length > MAX_CHANNELS) {
    throw new Error(`"channels" has ${raw.channels.length} entries; the most is ${MAX_CHANNELS}`);
  }
  const channels = raw.channels.map((c) => String(c).trim().toUpperCase().slice(0, LABEL_CHARS));
  const n = channels.length;
  const midiChannel = raw.midiChannel ?? 1;
  if (!Number.isInteger(midiChannel) || midiChannel < 1 || midiChannel > 16) {
    throw new Error('"midiChannel" must be 1..16');
  }
  const encoders = (raw.encoders ?? []).map((r, i) => parseRow(r, `encoders[${i}]`, n));
  if (encoders.length > MAX_ENCODER_ROWS) {
    throw new Error(`"encoders" has ${encoders.length} rows; the most is ${MAX_ENCODER_ROWS}`);
  }
  const buttons = (raw.buttons ?? []).map((r, i) => parseRow(r, `buttons[${i}]`, n));
  if (buttons.length > MAX_BUTTON_ROWS) {
    throw new Error(`"buttons" has ${buttons.length} rows; the most is ${MAX_BUTTON_ROWS}`);
  }
  const fader = raw.faders ? parseRow(raw.faders, 'faders', n) : null;
  // Two controls on one CC would move together on the mixer.
  const seen = new Map<number, string>();
  const rows: Array<[string, MixerControlRow | null]> = [
    ['faders', fader],
    ...encoders.map((r, i): [string, MixerControlRow] => [`encoders[${i}]`, r]),
    ...buttons.map((r, i): [string, MixerControlRow] => [`buttons[${i}]`, r]),
  ];
  for (const [what, row] of rows) {
    if (!row) continue;
    for (const cc of row.cc) {
      const prev = seen.get(cc);
      if (prev) throw new Error(`cc ${cc} is used by both ${prev} and ${what}`);
      seen.set(cc, what);
    }
  }
  return {
    id,
    name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : id,
    midiChannel: midiChannel - 1,
    channels,
    fader,
    encoders,
    buttons,
    path,
  };
}

function row(label: string, base: number, n: number, initial = 0): MixerControlRow {
  return { label, cc: Array.from({ length: n }, (_, c) => base + c), initial };
}

// Fallback for a machine with no .mixer file. bluebox: the unit maps anything
// as one CC per control on any channel (manual p.45), so this is a clean block
// on MIDI channel 1 MIDI-learned onto the unit.
const BUILT_IN_PROFILES: readonly ExternalMixerProfile[] = [
  {
    id: 'bluebox',
    name: 'bluebox',
    midiChannel: 0,
    channels: ['DRUMS', 'PADS', 'VECTR', 'BASS', 'LEADS', 'NOISE', 'LOOPS', 'SPARE'],
    fader: row('LVL', 21, 8, 100),
    encoders: [row('RVB', 31, 8), row('DLY', 41, 8), row('PAN', 51, 8, 64)],
    buttons: [row('MUTE', 61, 8), row('SOLO', 71, 8)],
    path: null,
  },
];

// --- profile list: files first, then any built-in a file didn't replace ---
let fileProfiles: ExternalMixerProfile[] = [];
// Files that exist but couldn't be used, with the reason (settings row shows it).
let fileErrors: Array<{ path: string; reason: string }> = [];
let profiles: readonly ExternalMixerProfile[] = BUILT_IN_PROFILES;
let loadedSig = '';
const profileListeners = new Set<() => void>();

export function mixerProfiles(): readonly ExternalMixerProfile[] {
  return profiles;
}
export function mixerProfileErrors(): ReadonlyArray<{ path: string; reason: string }> {
  return fileErrors;
}
// Fires when the profile list or any profile's contents change.
export function onMixerProfilesChange(cb: () => void): () => void {
  profileListeners.add(cb);
  return () => profileListeners.delete(cb);
}

// Read every .mixer file in the instruments folder. Called at boot and on
// window focus. An unreachable folder (Dropbox not mounted) leaves the current
// list alone.
export async function loadMixerProfilesFromDisk(): Promise<void> {
  const dir = await resolveInstrumentsDir();
  if (!dir) return;
  let paths: string[];
  try {
    paths = await invoke<string[]>('list_dir_files', { dir, exts: [EXT] });
  } catch (err) {
    console.warn('[mixer] listing profiles failed:', err);
    return;
  }
  const next: ExternalMixerProfile[] = [];
  const errors: Array<{ path: string; reason: string }> = [];
  for (const path of paths) {
    const id = path.split('/').pop()!.replace(new RegExp(`\\.${EXT}$`, 'i'), '');
    try {
      next.push(parseMixerFile(await invoke<string>('read_text_file', { path }), id, path));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(`[mixer] skipping ${path}: ${reason}`);
      errors.push({ path, reason });
    }
  }
  const sig = JSON.stringify([next, errors]);
  if (sig === loadedSig) return;
  loadedSig = sig;
  fileProfiles = next;
  fileErrors = errors;
  profiles = [
    ...fileProfiles,
    ...BUILT_IN_PROFILES.filter((b) => !fileProfiles.some((f) => f.id === b.id)),
  ];
  for (const cb of profileListeners) cb();
}

// The active profile, resolved from the persisted store selection. null =
// feature off (or the selected file is gone).
export function activeMixerProfile(): ExternalMixerProfile | null {
  const id = useSequencerStore.getState().externalMixerProfileId;
  if (!id) return null;
  return profiles.find((p) => p.id === id) ?? null;
}

// --- mix state ---------------------------------------------------------------
interface MixerState {
  fader: number[]; // [channel] 0..127
  enc: number[][]; // [row][channel] 0..127
  btn: boolean[][]; // [row][channel]
}

// Rebuilt (re-seeded to defaults) when the control layout changes — a different
// mixer, or rows pointed at different CCs, makes our running belief about the
// old one meaningless. Relabelling a channel or row keeps the state.
let stateSig: string | null = null;
let state: MixerState = { fader: [], enc: [], btn: [] };

function layoutSig(p: ExternalMixerProfile): string {
  const cc = (r: MixerControlRow | null) => (r ? r.cc.join(',') : '-');
  return [p.id, p.midiChannel, cc(p.fader), ...p.encoders.map(cc), '/', ...p.buttons.map(cc)].join('|');
}

function ensureState(p: ExternalMixerProfile): void {
  const sig = layoutSig(p);
  if (stateSig === sig) return;
  stateSig = sig;
  const n = p.channels.length;
  state = {
    fader: new Array<number>(n).fill(p.fader?.initial ?? 0),
    enc: p.encoders.map((r) => new Array<number>(n).fill(r.initial)),
    btn: p.buttons.map((r) => new Array<boolean>(n).fill(r.initial > 0)),
  };
}

function emit(profile: ExternalMixerProfile, cc: number, value: number): void {
  const port = useSequencerStore.getState().externalMixerPort;
  if (!port) return; // no destination configured — state-only
  sendMIDIControlChange(port, profile.midiChannel, cc, clamp127(value));
}

// Current values. null = no profile, or that row/channel doesn't exist.
export function mixerFaderValue(c: number): number | null {
  const p = activeMixerProfile();
  if (!p || !p.fader || c < 0 || c >= p.channels.length) return null;
  ensureState(p);
  return state.fader[c];
}
export function mixerEncoderValue(rowIdx: number, c: number): number | null {
  const p = activeMixerProfile();
  if (!p || !p.encoders[rowIdx] || c < 0 || c >= p.channels.length) return null;
  ensureState(p);
  return state.enc[rowIdx][c];
}
export function mixerButtonOn(rowIdx: number, c: number): boolean | null {
  const p = activeMixerProfile();
  if (!p || !p.buttons[rowIdx] || c < 0 || c >= p.channels.length) return null;
  ensureState(p);
  return state.btn[rowIdx][c];
}

// --- continuous setters: clamp, store, emit (value is raw 0..127) ---
export function setMixerFader(c: number, value: number): void {
  if (mixerFaderValue(c) === null) return;
  const p = activeMixerProfile()!;
  state.fader[c] = clamp127(value);
  emit(p, p.fader!.cc[c], state.fader[c]);
}
export function setMixerEncoder(rowIdx: number, c: number, value: number): void {
  if (mixerEncoderValue(rowIdx, c) === null) return;
  const p = activeMixerProfile()!;
  state.enc[rowIdx][c] = clamp127(value);
  emit(p, p.encoders[rowIdx].cc[c], state.enc[rowIdx][c]);
}

// --- switches: app-side latching toggle that emits the ABSOLUTE target value
// (127 = on, 0 = off). Value-following switches (high = engaged) latch on the
// held value and release on 0 — a clean toggle from a momentary button, and a
// clean on/off gesture for MIDI-learn to catch. Returns the new state so the
// caller can light the button LED. ---
export function toggleMixerButton(rowIdx: number, c: number): boolean {
  const cur = mixerButtonOn(rowIdx, c);
  if (cur === null) return false;
  const p = activeMixerProfile()!;
  state.btn[rowIdx][c] = !cur;
  emit(p, p.buttons[rowIdx].cc[c], !cur ? 127 : 0);
  return !cur;
}
