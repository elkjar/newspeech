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
// MULTI-DEVICE: we support N connected Launchpads (currently used as a pair —
// see launchpadBindings.ts for the left/right "width" layout). Each physical
// device is a `Surface` with its own port pair + diff buffer; the public API
// takes a 0-based `device` index (enumeration order). Two Launchpad X units
// report byte-identical CoreMIDI names, so the Rust layer de-dups port names
// (" #2", "#3"…) — by the time we see them here they're unique strings.
//
// We bypass midiIn.ts's parsed listener and subscribe to the raw
// `midi://message` Tauri event directly, filtering on port name. The
// note-off + cc-release events would be dropped by midiIn's parser
// (it filters velocity-0 note-ons), and we want the full bidirectional
// stream so hold gestures work.

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

/** Listener receives the device index the event came from. */
type EventListener = (device: number, e: LaunchpadEvent) => void;

export interface LaunchpadPortPair {
  inputPort: string;
  outputPort: string;
}

interface Surface {
  inputPort: string;
  outputPort: string;
  /** Last-sent palette color per surface slot, 0-79. Drives diff sending. */
  lastColors: Uint8Array;
}

// Physical surfaces in enumeration order; index = `device` id everywhere else.
let surfaces: Surface[] = [];
// Single shared listener on the raw MIDI stream; dispatches by port to the
// owning surface. (One listener for all devices rather than one per device.)
let messageUnlisten: UnlistenFn | null = null;
const listeners = new Set<EventListener>();
const connectionListeners = new Set<() => void>();

export function getConnectedCount(): number {
  return surfaces.length;
}

/** Input port names of the connected devices, in device-index order. */
export function getConnectedInputPorts(): string[] {
  return surfaces.map((s) => s.inputPort);
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
// MIDI pair — the DAW port doesn't relay pad presses to the host the same
// way. Prefer ports that contain " midi" over " daw".
const LAUNCHPAD_NAME_NEEDLE = 'launchpad x';
const MIDI_TOKEN = /(?:^|[\s_-])midi(?:[\s_-]|#|$)/i;
const DAW_TOKEN = /(?:^|[\s_-])daw(?:[\s_-]|#|$)/i;

/** All Launchpad MIDI-surface ports (not the DAW pair), in enumeration order. */
function launchpadMidiPorts(ports: string[]): string[] {
  const matches = ports.filter((n) => n.toLowerCase().includes(LAUNCHPAD_NAME_NEEDLE));
  // Prefer the MIDI surface; if a device somehow exposes no explicitly-named
  // MIDI port, fall back to any non-DAW port for it.
  const midi = matches.filter((n) => MIDI_TOKEN.test(n));
  if (midi.length > 0) return midi;
  return matches.filter((n) => !DAW_TOKEN.test(n));
}

/**
 * Pair up every connected Launchpad's MIDI input + output ports. Inputs and
 * outputs are matched by enumeration order: device A's in+out both come first,
 * device B's both come second. (CoreMIDI lists endpoints per device in a
 * consistent order; the de-dup suffixes assigned by the Rust layer line up
 * because both lists are deduped the same way.) Returns one pair per device.
 */
export function findAllLaunchpadPorts(
  inputs: string[],
  outputs: string[]
): LaunchpadPortPair[] {
  const inPorts = launchpadMidiPorts(inputs);
  const outPorts = launchpadMidiPorts(outputs);
  const n = Math.min(inPorts.length, outPorts.length);
  const pairs: LaunchpadPortPair[] = [];
  for (let i = 0; i < n; i++) {
    pairs.push({ inputPort: inPorts[i], outputPort: outPorts[i] });
  }
  return pairs;
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

function midiIndexFor(addr: LaunchpadAddress): number {
  if (addr.element === 'pad') return noteForPad(addr.index);
  if (addr.element === 'top') return ccForTop(addr.index);
  return ccForSide(addr.index);
}

// ---------- color sending ----------

function sendBytes(device: number, bytes: number[]): void {
  const surface = surfaces[device];
  if (!surface) return;
  // Fire-and-forget; midi_send retries internally if the port is stale.
  invoke('midi_send', { portName: surface.outputPort, bytes }).catch((err) => {
    console.warn('[launchpad] send failed:', err);
  });
}

/**
 * Set a surface element to a monochrome white brightness 0..127. Sends a
 * type-3 RGB SysEx with (level, level, level) so we get full 0-127 brightness
 * resolution instead of being limited to the palette's handful of whites.
 */
export function setColor(device: number, addr: LaunchpadAddress, level: number): void {
  const surface = surfaces[device];
  if (!surface) return;
  const slot = slotForAddress(addr);
  const v = Math.max(0, Math.min(127, level | 0));
  if (surface.lastColors[slot] === v) return;
  surface.lastColors[slot] = v;
  const idx = midiIndexFor(addr);
  sendBytes(device, [...SYSEX_HEADER, SYSEX_CMD_LED, 0x03, idx, v, v, v, ...SYSEX_FOOTER]);
}

export function setPadColor(device: number, index: number, level: number): void {
  setColor(device, { element: 'pad', index }, level);
}

export function setTopColor(device: number, index: number, level: number): void {
  setColor(device, { element: 'top', index }, level);
}

export function setSideColor(device: number, index: number, level: number): void {
  setColor(device, { element: 'side', index }, level);
}

/**
 * Set a surface element to a pulsing palette color (alternates between off
 * and the chosen palette index). Used for "pending" states where animation
 * differentiates from a static-bright "active." The Launchpad's pulse mode
 * only takes a palette index — `paletteColor = 3` is bright white, the
 * closest match for our monochrome surface. Invalidates the diff buffer so
 * the next static setColor re-sends.
 */
export function setPulse(device: number, addr: LaunchpadAddress, paletteColor: number): void {
  const surface = surfaces[device];
  if (!surface) return;
  const slot = slotForAddress(addr);
  const idx = midiIndexFor(addr);
  const c = Math.max(0, Math.min(127, paletteColor | 0));
  const status = addr.element === 'pad' ? 0x92 : 0xb2;
  sendBytes(device, [status, idx, c]);
  // Sentinel above the static range; the next setColor diff-check will
  // always fail and re-send the desired static brightness.
  surface.lastColors[slot] = 0xff;
}

export function setTopPulse(device: number, index: number, paletteColor: number): void {
  setPulse(device, { element: 'top', index }, paletteColor);
}

/**
 * Bulk redraw the whole surface in one SysEx. Caller passes a brightness
 * 0..127 for every slot 0..79; we emit each as a type-3 RGB triple of
 * (level, level, level) so the surface stays monochrome.
 */
export function bulkRedraw(device: number, desired: Uint8Array): void {
  const surface = surfaces[device];
  if (!surface) return;
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
    surface.lastColors[slot] = v;
  }
  sendBytes(device, [...SYSEX_HEADER, SYSEX_CMD_LED, ...specs, ...SYSEX_FOOTER]);
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

async function ensureMessageListener(): Promise<boolean> {
  if (messageUnlisten) return true;
  try {
    messageUnlisten = await listen<{ port: string; bytes: number[] }>(
      'midi://message',
      (event) => {
        const device = surfaces.findIndex((s) => s.inputPort === event.payload.port);
        if (device < 0) return;
        const e = parseInput(event.payload.bytes);
        if (!e) return;
        for (const cb of listeners) cb(device, e);
      }
    );
    return true;
  } catch (err) {
    console.error('[launchpad] listen failed:', err);
    return false;
  }
}

async function connectOne(pair: LaunchpadPortPair): Promise<Surface | null> {
  // Subscribing midiIn.ts already opens the input port on the Rust side
  // for every connected input; we just need to filter messages for ours.
  // Belt-and-suspenders: explicit subscribe in case our connect lands
  // before the midiIn auto-subscribe poll runs.
  try {
    await invoke('midi_subscribe_input', { portName: pair.inputPort });
  } catch (err) {
    console.warn('[launchpad] subscribe input failed:', err);
  }
  const surface: Surface = {
    inputPort: pair.inputPort,
    outputPort: pair.outputPort,
    lastColors: new Uint8Array(SURFACE_SIZE),
  };
  return surface;
}

function enterProgrammerMode(surface: Surface): void {
  invoke('midi_send', { portName: surface.outputPort, bytes: PROGRAMMER_MODE_ON }).catch(
    () => {}
  );
}

/**
 * Reconcile the connected surfaces to exactly `pairs` (device order = list
 * order). Existing surfaces whose input port is no longer present are torn
 * down; new pairs are connected; surviving ones are reused in place. Returns
 * the resulting device count. Idempotent — safe to call on every hot-plug
 * poll. Caller re-attaches bindings if the count changes.
 */
export async function syncLaunchpads(pairs: LaunchpadPortPair[]): Promise<number> {
  if (!TAURI) return 0;
  const desiredIn = new Set(pairs.map((p) => p.inputPort));
  // Tear down surfaces no longer desired.
  const removed = surfaces.filter((s) => !desiredIn.has(s.inputPort));
  for (const s of removed) await teardownSurface(s);

  // Build the new ordered list, reusing live surfaces, connecting the rest.
  const byInput = new Map(surfaces.map((s) => [s.inputPort, s]));
  const next: Surface[] = [];
  const freshlyConnected: Surface[] = [];
  for (const pair of pairs) {
    const existing = byInput.get(pair.inputPort);
    if (existing) {
      // Output port could in principle have changed; keep it in sync.
      existing.outputPort = pair.outputPort;
      next.push(existing);
      continue;
    }
    const surface = await connectOne(pair);
    if (surface) {
      next.push(surface);
      freshlyConnected.push(surface);
    }
  }
  surfaces = next;

  if (surfaces.length > 0) {
    const ok = await ensureMessageListener();
    if (!ok) {
      surfaces = [];
      return 0;
    }
  }

  // Enter Programmer Mode + wipe only the freshly-connected surfaces. The
  // device needs a beat to swap modes before it accepts color updates; an
  // immediate bulk redraw can land mid-swap and miss LEDs. 30 ms is
  // observed-safe.
  if (freshlyConnected.length > 0) {
    for (const s of freshlyConnected) enterProgrammerMode(s);
    await new Promise((r) => setTimeout(r, 30));
    for (const s of freshlyConnected) {
      const device = surfaces.indexOf(s);
      if (device >= 0) bulkRedraw(device, new Uint8Array(SURFACE_SIZE));
    }
  }

  notifyConnectionChange();
  return surfaces.length;
}

async function teardownSurface(surface: Surface): Promise<void> {
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
      portName: surface.outputPort,
      bytes: [...SYSEX_HEADER, SYSEX_CMD_LED, ...wipe, ...SYSEX_FOOTER],
    });
    await invoke('midi_send', { portName: surface.outputPort, bytes: PROGRAMMER_MODE_OFF });
  } catch {
    // ignore
  }
}

export async function disconnectAll(): Promise<void> {
  if (surfaces.length === 0 && !messageUnlisten) return;
  const prev = surfaces;
  surfaces = [];
  for (const s of prev) await teardownSurface(s);
  if (messageUnlisten) {
    messageUnlisten();
    messageUnlisten = null;
  }
  notifyConnectionChange();
}

// HMR cleanup — without this, the Tauri event listener (and any binding
// subscriptions tied to the surface) outlive module reload and double up.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void disconnectAll();
    listeners.clear();
    connectionListeners.clear();
  });
}
