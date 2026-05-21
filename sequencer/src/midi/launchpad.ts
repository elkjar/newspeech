// Novation Launchpad X transport layer — Tauri only.
//
// Programmer Mode bypasses the device's built-in Live layout, giving raw
// note-on/CC control of every pad and full palette/RGB color via SysEx +
// channel messages. We drive the device end-to-end so the sequencer owns
// the layout.
//
// Reference: Novation "Launchpad X — Programmer's Reference Guide" (Nov 2019).
//
// SysEx framing: F0 00 20 29 02 0C [cmd] [data...] F7
//   cmd 0x0E 01 = enter Programmer Mode
//   cmd 0x0E 00 = exit  (back to Live Mode)
//   cmd 0x03    = LED color spec(s). Spec format per LED:
//                   type 0: [0, idx, color]            (palette static)
//                   type 1: [1, idx, colorA, colorB]   (flashing)
//                   type 2: [2, idx, color]            (pulsing)
//                   type 3: [3, idx, R, G, B]          (RGB)
//
// Channel-message LED control (lighter for single-pad diffs):
//   pads: 0x90 [note 11-88] [color]      static
//         0x91 ...                       flashing
//         0x92 ...                       pulsing
//   CCs:  0xB0 [cc 19-99]   [color]      static
//
// Address space (flat 0..79):
//   0..63   grid pads, row-major, row 0 = top.   note = (8 - row)*10 + (col+1)
//   64..71  top row CCs left-to-right.            cc = 91 + (idx - 64)
//   72..79  right column CCs top-to-bottom.       cc = 89 - (idx - 72)*10
//
// We bypass midiIn.ts's parsed listener and subscribe to the raw
// `midi://message` Tauri event directly, filtering on port name. The
// note-off + cc-release events would be dropped by midiIn's parser
// (it filters velocity-0 note-ons), and we want the full bidirectional
// stream so future hold gestures work.

import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

const TAURI = isTauri();

const SYSEX_HEADER = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x0c];
const SYSEX_FOOTER = [0xf7];
const SYSEX_CMD_LED = 0x03;
const SYSEX_CMD_MODE = 0x0e;
const PROGRAMMER_MODE_ON = [...SYSEX_HEADER, SYSEX_CMD_MODE, 0x01, ...SYSEX_FOOTER];
const PROGRAMMER_MODE_OFF = [...SYSEX_HEADER, SYSEX_CMD_MODE, 0x00, ...SYSEX_FOOTER];

const SURFACE_SIZE = 80;
const GRID_SIZE = 64;
const TOP_ROW_START = 64;
const SIDE_COL_START = 72;

export type LaunchpadElement = 'pad' | 'top' | 'side';

export interface LaunchpadAddress {
  element: LaunchpadElement;
  /** For pads: 0..63 (row*8 + col). For top: 0..7 (left→right). For side: 0..7 (top→bottom). */
  index: number;
}

export interface LaunchpadEvent {
  addr: LaunchpadAddress;
  pressed: boolean;
  /** Press velocity (0..127). 0 on release. */
  velocity: number;
}

type EventListener = (e: LaunchpadEvent) => void;

interface State {
  inputPort: string;
  outputPort: string;
  unlisten: UnlistenFn | null;
  /** Last-sent palette color per surface slot, 0-79. Drives diff sending. */
  lastColors: Uint8Array;
}

let state: State | null = null;
const listeners = new Set<EventListener>();
const connectionListeners = new Set<() => void>();

export function isLaunchpadConnected(): boolean {
  return state !== null;
}

export function getConnectedPort(): string | null {
  return state ? state.inputPort : null;
}

export function onLaunchpadConnectionChange(cb: () => void): () => void {
  connectionListeners.add(cb);
  return () => {
    connectionListeners.delete(cb);
  };
}

function notifyConnectionChange(): void {
  for (const cb of connectionListeners) cb();
}

// Match by port name substring. Launchpad X exposes TWO port pairs on
// macOS: "LPX MIDI" (the standard programmer surface) and "LPX DAW" (a
// proprietary handshake Ableton uses for its auto-mapping). We need the
// MIDI pair — the DAW port doesn't relay pad presses to host the same
// way. Prefer ports that contain " midi" over " daw"; fall back to any
// "launchpad x" match if neither suffix is present.
const LAUNCHPAD_NAME_NEEDLE = 'launchpad x';

function pickLaunchpadPort(ports: string[]): string | undefined {
  const matches = ports.filter((n) => n.toLowerCase().includes(LAUNCHPAD_NAME_NEEDLE));
  if (matches.length === 0) return undefined;
  const midi = matches.find((n) => /(?:^|[\s_-])midi(?:[\s_-]|$)/i.test(n));
  if (midi) return midi;
  // Avoid the DAW port if we have any other option.
  const nonDaw = matches.find((n) => !/(?:^|[\s_-])daw(?:[\s_-]|$)/i.test(n));
  return nonDaw ?? matches[0];
}

export function findLaunchpadPorts(
  inputs: string[],
  outputs: string[]
): { inputPort: string; outputPort: string } | null {
  const inputPort = pickLaunchpadPort(inputs);
  const outputPort = pickLaunchpadPort(outputs);
  if (!inputPort || !outputPort) return null;
  return { inputPort, outputPort };
}

// ---------- address ↔ MIDI conversion ----------

function noteForPad(index: number): number {
  // index = row*8 + col, row 0 = top. Note layout: row 0 → 81-88, row 7 → 11-18.
  const row = Math.floor(index / 8);
  const col = index % 8;
  return (8 - row) * 10 + (col + 1);
}

function ccForTop(index: number): number {
  return 91 + index;
}

function ccForSide(index: number): number {
  return 89 - index * 10;
}

function addressFromNote(note: number): LaunchpadAddress | null {
  const tens = Math.floor(note / 10);
  const ones = note % 10;
  if (tens < 1 || tens > 8 || ones < 1 || ones > 8) return null;
  const row = 8 - tens;
  const col = ones - 1;
  return { element: 'pad', index: row * 8 + col };
}

function addressFromCC(cc: number): LaunchpadAddress | null {
  if (cc >= 91 && cc <= 98) return { element: 'top', index: cc - 91 };
  if (cc === 89 || cc === 79 || cc === 69 || cc === 59 || cc === 49 || cc === 39 || cc === 29 || cc === 19) {
    return { element: 'side', index: (89 - cc) / 10 };
  }
  return null;
}

function slotForAddress(addr: LaunchpadAddress): number {
  if (addr.element === 'pad') return addr.index;
  if (addr.element === 'top') return TOP_ROW_START + addr.index;
  return SIDE_COL_START + addr.index;
}

// ---------- color sending ----------

function sendBytes(bytes: number[]): void {
  if (!state) return;
  // Fire-and-forget; midi_send retries internally if the port is stale.
  invoke('midi_send', { portName: state.outputPort, bytes }).catch((err) => {
    console.warn('[launchpad] send failed:', err);
  });
}

function midiIndexFor(addr: LaunchpadAddress): number {
  if (addr.element === 'pad') return noteForPad(addr.index);
  if (addr.element === 'top') return ccForTop(addr.index);
  return ccForSide(addr.index);
}

/**
 * Set a surface element to a monochrome white brightness 0..127. Sends a
 * type-3 RGB SysEx with (level, level, level) so we get full 0-127 brightness
 * resolution instead of being limited to the palette's handful of whites.
 */
export function setColor(addr: LaunchpadAddress, level: number): void {
  if (!state) return;
  const slot = slotForAddress(addr);
  const v = Math.max(0, Math.min(127, level | 0));
  if (state.lastColors[slot] === v) return;
  state.lastColors[slot] = v;
  const idx = midiIndexFor(addr);
  sendBytes([...SYSEX_HEADER, SYSEX_CMD_LED, 0x03, idx, v, v, v, ...SYSEX_FOOTER]);
}

export function setPadColor(index: number, level: number): void {
  setColor({ element: 'pad', index }, level);
}

export function setTopColor(index: number, level: number): void {
  setColor({ element: 'top', index }, level);
}

export function setSideColor(index: number, level: number): void {
  setColor({ element: 'side', index }, level);
}

/**
 * Set a surface element to a pulsing palette color (alternates between off
 * and the chosen palette index). Used for "pending" states where animation
 * differentiates from a static-bright "active." The Launchpad's pulse mode
 * only takes a palette index — `paletteColor = 3` is bright white, the
 * closest match for our monochrome surface. Invalidates the diff buffer so
 * the next static setColor re-sends.
 */
export function setPulse(addr: LaunchpadAddress, paletteColor: number): void {
  if (!state) return;
  const slot = slotForAddress(addr);
  const idx = midiIndexFor(addr);
  const c = Math.max(0, Math.min(127, paletteColor | 0));
  const status = addr.element === 'pad' ? 0x92 : 0xb2;
  sendBytes([status, idx, c]);
  // Sentinel above the static range; the next setColor diff-check will
  // always fail and re-send the desired static brightness.
  state.lastColors[slot] = 0xff;
}

export function setTopPulse(index: number, paletteColor: number): void {
  setPulse({ element: 'top', index }, paletteColor);
}

/**
 * Bulk redraw the whole surface in one SysEx. Caller passes a brightness
 * 0..127 for every slot 0..79; we emit each as a type-3 RGB triple of
 * (level, level, level) so the surface stays monochrome.
 */
export function bulkRedraw(desired: Uint8Array): void {
  if (!state) return;
  if (desired.length !== SURFACE_SIZE) {
    console.warn('[launchpad] bulkRedraw expected', SURFACE_SIZE, 'levels, got', desired.length);
    return;
  }
  const specs: number[] = [];
  for (let slot = 0; slot < SURFACE_SIZE; slot++) {
    const v = desired[slot];
    let idx: number;
    if (slot < GRID_SIZE) idx = noteForPad(slot);
    else if (slot < SIDE_COL_START) idx = ccForTop(slot - TOP_ROW_START);
    else idx = ccForSide(slot - SIDE_COL_START);
    specs.push(0x03, idx, v, v, v);
    state.lastColors[slot] = v;
  }
  sendBytes([...SYSEX_HEADER, SYSEX_CMD_LED, ...specs, ...SYSEX_FOOTER]);
}

export function clearAll(): void {
  if (!state) return;
  bulkRedraw(new Uint8Array(SURFACE_SIZE));
}

// ---------- input parsing ----------

function parseInput(bytes: number[]): LaunchpadEvent | null {
  if (bytes.length < 3) return null;
  const status = bytes[0] & 0xf0;
  const data1 = bytes[1];
  const data2 = bytes[2];
  if (status === 0x90 || status === 0x80) {
    const addr = addressFromNote(data1);
    if (!addr) return null;
    const pressed = status === 0x90 && data2 > 0;
    return { addr, pressed, velocity: pressed ? data2 : 0 };
  }
  if (status === 0xb0) {
    const addr = addressFromCC(data1);
    if (!addr) return null;
    return { addr, pressed: data2 > 0, velocity: data2 };
  }
  return null;
}

export function onLaunchpadEvent(cb: EventListener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

// ---------- lifecycle ----------

export async function connectLaunchpad(
  inputPort: string,
  outputPort: string
): Promise<boolean> {
  if (!TAURI) return false;
  if (state && state.inputPort === inputPort && state.outputPort === outputPort) {
    return true;
  }
  // Tear down any prior connection cleanly first.
  await disconnectLaunchpad();
  state = {
    inputPort,
    outputPort,
    unlisten: null,
    lastColors: new Uint8Array(SURFACE_SIZE),
  };
  // Subscribing midiIn.ts already opens the input port on the Rust side
  // for every connected input; we just need to filter messages for ours.
  // Belt-and-suspenders: explicit subscribe in case our connect lands
  // before the midiIn auto-subscribe poll runs.
  try {
    await invoke('midi_subscribe_input', { portName: inputPort });
  } catch (err) {
    console.warn('[launchpad] subscribe input failed:', err);
  }
  try {
    state.unlisten = await listen<{ port: string; bytes: number[] }>(
      'midi://message',
      (event) => {
        if (!state || event.payload.port !== state.inputPort) return;
        const e = parseInput(event.payload.bytes);
        if (!e) return;
        for (const cb of listeners) cb(e);
      }
    );
  } catch (err) {
    console.error('[launchpad] listen failed:', err);
    state = null;
    return false;
  }
  // Enter Programmer Mode and wipe the surface.
  sendBytes(PROGRAMMER_MODE_ON);
  // The device needs a beat to swap modes before it accepts color updates;
  // an immediate bulk redraw can land mid-swap and miss some LEDs. 30 ms is
  // observed-safe.
  await new Promise((r) => setTimeout(r, 30));
  bulkRedraw(new Uint8Array(SURFACE_SIZE));
  notifyConnectionChange();
  return true;
}

export async function disconnectLaunchpad(): Promise<void> {
  if (!state) return;
  const prev = state;
  state = null;
  // Best-effort: clear LEDs + exit Programmer Mode. If the device is already
  // unplugged these will fail silently inside midi_send.
  try {
    const wipe: number[] = [];
    for (let slot = 0; slot < SURFACE_SIZE; slot++) {
      let idx: number;
      if (slot < GRID_SIZE) idx = noteForPad(slot);
      else if (slot < SIDE_COL_START) idx = ccForTop(slot - TOP_ROW_START);
      else idx = ccForSide(slot - SIDE_COL_START);
      wipe.push(0x00, idx, 0);
    }
    await invoke('midi_send', {
      portName: prev.outputPort,
      bytes: [...SYSEX_HEADER, SYSEX_CMD_LED, ...wipe, ...SYSEX_FOOTER],
    });
    await invoke('midi_send', { portName: prev.outputPort, bytes: PROGRAMMER_MODE_OFF });
  } catch {
    // ignore
  }
  if (prev.unlisten) prev.unlisten();
  notifyConnectionChange();
}

// HMR cleanup — without this, the Tauri event listener (and any binding
// subscriptions tied to the surface) outlive module reload and double up.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void disconnectLaunchpad();
    listeners.clear();
    connectionListeners.clear();
  });
}
