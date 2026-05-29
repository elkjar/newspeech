// Novation Launch Control XL3 transport — Tauri only.
//
// The XL3 is wired up in DAW mode (not its standalone custom mode). DAW mode
// is the key: it's the only mode where the host can WRITE the encoders'
// positions back to the device. The XL3 encoders can't send relative (a known
// hardware limitation — see [[reference-launch-control-xl3]]); they're absolute
// and clamp at 0/127. By keeping each encoder synced to its parameter (write
// the position whenever the param changes or the page flips), a turn maps 1:1
// to the value with no jumps and no clamp problems — the encoder always sits
// AT the value with headroom both ways.
//
// Confirmed empirically (2026-05-29):
//   enter DAW mode : Note On  9F 0C 7F   (exit: 9F 0C 00)   — Launchkey-family
//   encoders (in)  : ch16 (BF) CC 13..36, absolute 0..127
//   faders   (in)  : ch16 (BF) CC 5..12,  absolute 0..127 (physical — pickup)
//   buttons  (in)  : ch1  (B0) CC 37..52, momentary 127/0
//   set encoder pos: send ch16 (BF) CC <13+n> = value  → resets its counter
//   LED            : F0 00 20 29 02 15 01 53 <index> <R> <G> <B> F7
//                    indices match CC numbers (faders 5-12, encoders 13-36,
//                    buttons 37-52). Monochrome: white = 127,127,127; off = 0.
//
// All DAW-mode I/O is on the device's "DAW" port pair (LCXL3 1 DAW In/Out),
// NOT the "MIDI" pair. We listen to the raw `midi://message` Tauri event
// filtered on the DAW-out port name, mirroring the Launchpad bridge.

import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

const TAURI = isTauri();

const SYSEX_HEADER = [0xf0, 0x00, 0x20, 0x29, 0x02, 0x15];
const SYSEX_FOOTER = [0xf7];
const SYSEX_LED = [0x01, 0x53];
const DAW_MODE_ON = [0x9f, 0x0c, 0x7f];
const DAW_MODE_OFF = [0x9f, 0x0c, 0x00];

// CC layout (DAW mode). Encoders/faders on ch16 (status 0xBF), buttons ch1 (0xB0).
const ENC_CC_BASE = 13; // encoders 0..23 → CC 13..36
const ENC_COUNT = 24;
const FADER_CC_BASE = 5; // faders 0..7 → CC 5..12
const FADER_COUNT = 8;
const BTN_CC_BASE = 37; // buttons 0..15 → CC 37..52
const BTN_COUNT = 16;
const ENC_STATUS = 0xbf; // CC, channel 16
const BTN_STATUS = 0xb0; // CC, channel 1
// Transport + nav buttons (DAW mode, ch1, momentary 127/0).
const PLAY_CC = 116;
const RECORD_CC = 118;
const TRACK_LEFT_CC = 103; // Track ◀
const TRACK_RIGHT_CC = 102; // Track ▶

export type XL3ControlKind = 'encoder' | 'fader' | 'button' | 'transport';
export type XL3Transport = 'play' | 'record' | 'trackLeft' | 'trackRight';

export interface XL3Event {
  kind: XL3ControlKind;
  /** encoder 0..23, fader 0..7, button 0..15; unused for transport. */
  index: number;
  /** Continuous value 0..127 for encoder/fader; 0/127 for button/transport. */
  value: number;
  /** For buttons/transport: pressed = value > 0. */
  pressed: boolean;
  /** Which transport button, when kind === 'transport'. */
  transport?: XL3Transport;
}

type EventListener = (e: XL3Event) => void;

interface State {
  inputPort: string; // DAW Out (device → host)
  outputPort: string; // DAW In  (host → device)
  unlisten: UnlistenFn | null;
}

let state: State | null = null;
const listeners = new Set<EventListener>();
const connectionListeners = new Set<() => void>();

export function isXL3Connected(): boolean {
  return state !== null;
}

export function getXL3Port(): string | null {
  return state ? state.inputPort : null;
}

export function onXL3ConnectionChange(cb: () => void): () => void {
  connectionListeners.add(cb);
  return () => connectionListeners.delete(cb);
}

function notifyConnectionChange(): void {
  for (const cb of connectionListeners) cb();
}

// The XL3 exposes two port pairs ("LCXL3 1 MIDI" + "LCXL3 1 DAW"). DAW mode
// runs entirely on the DAW pair (same two-pair pattern as the Launchpad, but
// here we WANT the DAW port, not the MIDI one). Prefer a name containing
// "daw"; fall back to any LCXL3 port.
const XL3_NEEDLE = 'lcxl3';

function pickDawPort(ports: string[]): string | undefined {
  const matches = ports.filter((n) => n.toLowerCase().includes(XL3_NEEDLE));
  if (matches.length === 0) return undefined;
  const daw = matches.find((n) => /(?:^|[\s_-])daw(?:[\s_-]|$)/i.test(n));
  return daw ?? matches[0];
}

export function findXL3Ports(
  inputs: string[],
  outputs: string[]
): { inputPort: string; outputPort: string } | null {
  const inputPort = pickDawPort(inputs);
  const outputPort = pickDawPort(outputs);
  if (!inputPort || !outputPort) return null;
  return { inputPort, outputPort };
}

// ---------- output ----------

function sendBytes(bytes: number[]): void {
  if (!state) return;
  invoke('midi_send', { portName: state.outputPort, bytes }).catch((err) => {
    console.warn('[xl3] send failed:', err);
  });
}

/** Write an encoder's position (0..23 → 0..127). Resets the device-side
 *  counter so the next turn resumes from here — the core of value-sync. */
export function setEncoderValue(index: number, value: number): void {
  if (!state || index < 0 || index >= ENC_COUNT) return;
  const v = Math.max(0, Math.min(127, Math.round(value)));
  sendBytes([ENC_STATUS, ENC_CC_BASE + index, v]);
}

/** Set any control's LED to a monochrome white level 0..127 (0 = off). */
export function setLed(controlIndex: number, level: number): void {
  if (!state) return;
  const v = Math.max(0, Math.min(127, level | 0));
  sendBytes([...SYSEX_HEADER, ...SYSEX_LED, controlIndex, v, v, v, ...SYSEX_FOOTER]);
}

/** LED for a button by 0..15 index (maps to control index = CC). */
export function setButtonLed(index: number, level: number): void {
  if (index < 0 || index >= BTN_COUNT) return;
  setLed(BTN_CC_BASE + index, level);
}

/** LED for an encoder ring by 0..23 index. */
export function setEncoderLed(index: number, level: number): void {
  if (index < 0 || index >= ENC_COUNT) return;
  setLed(ENC_CC_BASE + index, level);
}

// ---------- input parsing ----------

function parseInput(bytes: number[]): XL3Event | null {
  if (bytes.length < 3) return null;
  const status = bytes[0];
  const cc = bytes[1];
  const value = bytes[2];
  if (status === ENC_STATUS) {
    if (cc >= ENC_CC_BASE && cc < ENC_CC_BASE + ENC_COUNT) {
      return { kind: 'encoder', index: cc - ENC_CC_BASE, value, pressed: value > 0 };
    }
    if (cc >= FADER_CC_BASE && cc < FADER_CC_BASE + FADER_COUNT) {
      return { kind: 'fader', index: cc - FADER_CC_BASE, value, pressed: value > 0 };
    }
    return null;
  }
  if (status === BTN_STATUS) {
    if (cc >= BTN_CC_BASE && cc < BTN_CC_BASE + BTN_COUNT) {
      return { kind: 'button', index: cc - BTN_CC_BASE, value, pressed: value > 0 };
    }
    if (cc === PLAY_CC) {
      return { kind: 'transport', index: 0, value, pressed: value > 0, transport: 'play' };
    }
    if (cc === RECORD_CC) {
      return { kind: 'transport', index: 0, value, pressed: value > 0, transport: 'record' };
    }
    if (cc === TRACK_LEFT_CC) {
      return { kind: 'transport', index: 0, value, pressed: value > 0, transport: 'trackLeft' };
    }
    if (cc === TRACK_RIGHT_CC) {
      return { kind: 'transport', index: 0, value, pressed: value > 0, transport: 'trackRight' };
    }
    return null;
  }
  return null;
}

/** Light the play button (white level 0..127) — control index = its CC. */
export function setPlayLed(level: number): void {
  setLed(PLAY_CC, level);
}

/** Light the Track ◀ / ▶ buttons (e.g. to show the active section). */
export function setTrackLeftLed(level: number): void {
  setLed(TRACK_LEFT_CC, level);
}
export function setTrackRightLed(level: number): void {
  setLed(TRACK_RIGHT_CC, level);
}

export function onXL3Event(cb: EventListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// ---------- lifecycle ----------

export async function connectXL3(inputPort: string, outputPort: string): Promise<boolean> {
  if (!TAURI) return false;
  if (state && state.inputPort === inputPort && state.outputPort === outputPort) return true;
  await disconnectXL3();
  state = { inputPort, outputPort, unlisten: null };
  try {
    await invoke('midi_subscribe_input', { portName: inputPort });
  } catch (err) {
    console.warn('[xl3] subscribe input failed:', err);
  }
  try {
    state.unlisten = await listen<{ port: string; bytes: number[] }>('midi://message', (event) => {
      if (!state || event.payload.port !== state.inputPort) return;
      const e = parseInput(event.payload.bytes);
      if (!e) return;
      for (const cb of listeners) cb(e);
    });
  } catch (err) {
    console.error('[xl3] listen failed:', err);
    state = null;
    return false;
  }
  // Enter DAW mode. The device echoes 9F 0C 7F back when it engages; we don't
  // strictly require the echo, but send a moment before the first writes so
  // the mode swap completes.
  sendBytes(DAW_MODE_ON);
  await new Promise((r) => setTimeout(r, 50));
  notifyConnectionChange();
  return true;
}

export async function disconnectXL3(): Promise<void> {
  if (!state) return;
  const prev = state;
  state = null;
  try {
    // Best-effort: dark the LEDs we might have lit, then leave DAW mode.
    await invoke('midi_send', {
      portName: prev.outputPort,
      bytes: DAW_MODE_OFF,
    });
  } catch {
    // ignore — device may be unplugged
  }
  if (prev.unlisten) prev.unlisten();
  notifyConnectionChange();
}

// HMR cleanup — drop the Tauri listener + return device to its prior mode.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void disconnectXL3();
    listeners.clear();
    connectionListeners.clear();
  });
}
