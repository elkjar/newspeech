import { getAudioContext } from './audioContext';
import { invoke, isTauri } from '@tauri-apps/api/core';

export interface MIDIOutputInfo {
  id: string;
  name: string;
}

type Status = 'unsupported' | 'idle' | 'requesting' | 'ready' | 'denied';

const TAURI = isTauri();

let access: MIDIAccess | null = null;
let outputs: MIDIOutputInfo[] = [];
let status: Status = TAURI
  ? 'idle'
  : typeof navigator !== 'undefined' &&
      typeof (navigator as Navigator & { requestMIDIAccess?: unknown }).requestMIDIAccess === 'function'
    ? 'idle'
    : 'unsupported';
const listeners = new Set<() => void>();

function refreshOutputs() {
  if (TAURI) {
    // outputs list is mutated directly in the Tauri refresher
  } else if (!access) {
    outputs = [];
  } else {
    const next: MIDIOutputInfo[] = [];
    access.outputs.forEach((out) => {
      next.push({ id: out.id, name: out.name ?? out.id });
    });
    outputs = next;
  }
  for (const cb of listeners) cb();
}

interface MidiPorts {
  inputs: string[];
  outputs: string[];
}

let tauriPoll: number | null = null;

async function refreshTauriOutputs(): Promise<void> {
  try {
    const ports = await invoke<MidiPorts>('midi_list_ports');
    // Port name doubles as id in Tauri mode — names are stable across replug.
    const next: MIDIOutputInfo[] = ports.outputs.map((n) => ({ id: n, name: n }));
    const changed =
      next.length !== outputs.length ||
      next.some((o, i) => o.id !== outputs[i]?.id);
    if (changed) {
      outputs = next;
      for (const cb of listeners) cb();
    }
  } catch (err) {
    console.warn('[midiOut] refresh failed:', err);
  }
}

export async function initMIDIOut(): Promise<boolean> {
  if (status === 'unsupported' || status === 'denied') return false;
  if (status === 'ready') return true;
  status = 'requesting';
  if (TAURI) {
    await refreshTauriOutputs();
    status = 'ready';
    if (tauriPoll === null) {
      // Hot-plug discovery — midir has no event stream so we poll. 3 s is
      // unobtrusive and replug is rare during a session.
      tauriPoll = window.setInterval(() => {
        void refreshTauriOutputs();
      }, 3000);
    }
    return true;
  }
  try {
    access = await (
      navigator as Navigator & { requestMIDIAccess: () => Promise<MIDIAccess> }
    ).requestMIDIAccess();
    status = 'ready';
    refreshOutputs();
    access.onstatechange = () => refreshOutputs();
    return true;
  } catch {
    status = 'denied';
    refreshOutputs();
    return false;
  }
}

export function midiOutStatus(): Status {
  return status;
}

export function getMIDIOutputs(): MIDIOutputInfo[] {
  return outputs;
}

export function onMIDIOutputsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

const NOTE_ON = 0x90;
const NOTE_OFF = 0x80;
const CONTROL_CHANGE = 0xb0;
const PROGRAM_CHANGE = 0xc0;
const ALL_NOTES_OFF_CC = 0xb0;
// System realtime messages — single byte, no channel, broadcast on the whole
// port. Used by the clock-out master (Sequence drives the rig clock).
const MIDI_CLOCK = 0xf8;
const MIDI_START = 0xfa;
const MIDI_CONTINUE = 0xfb;
const MIDI_STOP = 0xfc;
const CC_BANK_MSB = 0;
const CC_BANK_LSB = 32;

function audioToPerfMs(audioTime: number): number {
  const ctx = getAudioContext();
  return performance.now() + (audioTime - ctx.currentTime) * 1000;
}

function tauriSend(portName: string, bytes: number[]) {
  invoke('midi_send', { portName, bytes }).catch((err) => {
    console.warn(`[midiOut] send to ${portName} failed:`, err);
  });
}

function scheduleTauri(portName: string, bytes: number[], whenPerfMs: number) {
  const delay = Math.max(0, whenPerfMs - performance.now());
  if (delay <= 0) {
    tauriSend(portName, bytes);
  } else {
    window.setTimeout(() => tauriSend(portName, bytes), delay);
  }
}

export function sendMIDINote(
  deviceId: string,
  channel: number,
  note: number,
  velocity: number,
  when: number,
  durationS: number
) {
  const ch = ((channel | 0) & 0x0f);
  const n = Math.max(0, Math.min(127, note | 0));
  const v = Math.max(1, Math.min(127, Math.round(velocity * 127)));
  const onMs = audioToPerfMs(when);
  const offMs = audioToPerfMs(when + Math.max(0.02, durationS));
  if (TAURI) {
    scheduleTauri(deviceId, [NOTE_ON | ch, n, v], onMs);
    scheduleTauri(deviceId, [NOTE_OFF | ch, n, 0], offMs);
    return;
  }
  if (!access) return;
  const out = access.outputs.get(deviceId);
  if (!out) return;
  out.send([NOTE_ON | ch, n, v], onMs);
  out.send([NOTE_OFF | ch, n, 0], offMs);
}

// Immediate note-on / note-off pair for LIVE play (keyboard monitor). Unlike
// sendMIDINote, the off isn't scheduled — duration is unknown at press time, so
// the caller sends the off when the key is released. Sent now (no audio-clock
// scheduling): live play wants the lowest latency, not sample-accurate timing.
export function sendMIDINoteOn(
  deviceId: string,
  channel: number,
  note: number,
  velocity: number
) {
  const ch = (channel | 0) & 0x0f;
  const n = Math.max(0, Math.min(127, note | 0));
  const v = Math.max(1, Math.min(127, Math.round(velocity * 127)));
  if (TAURI) {
    tauriSend(deviceId, [NOTE_ON | ch, n, v]);
    return;
  }
  if (!access) return;
  const out = access.outputs.get(deviceId);
  if (!out) return;
  out.send([NOTE_ON | ch, n, v]);
}

export function sendMIDINoteOff(deviceId: string, channel: number, note: number) {
  const ch = (channel | 0) & 0x0f;
  const n = Math.max(0, Math.min(127, note | 0));
  if (TAURI) {
    tauriSend(deviceId, [NOTE_OFF | ch, n, 0]);
    return;
  }
  if (!access) return;
  const out = access.outputs.get(deviceId);
  if (!out) return;
  out.send([NOTE_OFF | ch, n, 0]);
}

export function sendMIDIProgram(deviceId: string, channel: number, program: number) {
  const ch = ((channel | 0) & 0x0f);
  const p = Math.max(0, Math.min(127, program | 0));
  if (TAURI) {
    tauriSend(deviceId, [PROGRAM_CHANGE | ch, p]);
    return;
  }
  if (!access) return;
  const out = access.outputs.get(deviceId);
  if (!out) return;
  out.send([PROGRAM_CHANGE | ch, p]);
}

// Send a Control Change immediately (no scheduling — these are knob-driven
// param updates, not note-timed events). value is the raw 0..127 CC value.
export function sendMIDIControlChange(
  deviceId: string,
  channel: number,
  cc: number,
  value: number
) {
  const ch = (channel | 0) & 0x0f;
  const n = Math.max(0, Math.min(127, cc | 0));
  const v = Math.max(0, Math.min(127, value | 0));
  if (TAURI) {
    tauriSend(deviceId, [CONTROL_CHANGE | ch, n, v]);
    return;
  }
  if (!access) return;
  const out = access.outputs.get(deviceId);
  if (!out) return;
  out.send([CONTROL_CHANGE | ch, n, v]);
}

export function sendPatchSelect(
  deviceId: string,
  channel: number,
  bankMSB: number | null,
  bankLSB: number | null,
  program: number | null
) {
  const ch = ((channel | 0) & 0x0f);
  const send = (bytes: number[]) => {
    if (TAURI) {
      tauriSend(deviceId, bytes);
    } else if (access) {
      const out = access.outputs.get(deviceId);
      if (out) out.send(bytes);
    }
  };
  if (bankMSB !== null) {
    send([CONTROL_CHANGE | ch, CC_BANK_MSB, Math.max(0, Math.min(127, bankMSB | 0))]);
  }
  if (bankLSB !== null) {
    send([CONTROL_CHANGE | ch, CC_BANK_LSB, Math.max(0, Math.min(127, bankLSB | 0))]);
  }
  if (program !== null) {
    send([PROGRAM_CHANGE | ch, Math.max(0, Math.min(127, program | 0))]);
  }
}

export function resolveDeviceId(portName: string | null, fallbackId: string | null): string | null {
  if (portName) {
    const needle = portName.toLowerCase();
    const match = outputs.find((o) => o.name.toLowerCase().includes(needle));
    if (match) return match.id;
  }
  return fallbackId;
}

export function midiPanic() {
  if (TAURI) {
    invoke('midi_panic').catch((err) => console.warn('[midiOut] panic failed:', err));
    return;
  }
  if (!access) return;
  access.outputs.forEach((out) => {
    for (let ch = 0; ch < 16; ch++) {
      out.send([ALL_NOTES_OFF_CC | ch, 123, 0]);
    }
  });
}

// Schedule a single 24-PPQN clock pulse (0xF8) at audioContext time `when`.
// Goes through the same audio-clock → perf-time path as note timing so the
// pulse stream stays evenly spaced — jitter here shows up as audible wobble on
// the downstream gear locked to it.
export function sendMIDIClockPulse(deviceId: string, when: number) {
  const ms = audioToPerfMs(when);
  if (TAURI) {
    scheduleTauri(deviceId, [MIDI_CLOCK], ms);
    return;
  }
  if (!access) return;
  const out = access.outputs.get(deviceId);
  if (out) out.send([MIDI_CLOCK], ms);
}

// Transport realtime messages, sent immediately (no scheduling) — they bracket
// the pulse stream on the play/stop action. Start resets followers to bar 1;
// Continue resumes without resetting.
function sendRealtimeNow(deviceId: string, byte: number) {
  if (TAURI) {
    tauriSend(deviceId, [byte]);
    return;
  }
  if (!access) return;
  const out = access.outputs.get(deviceId);
  if (out) out.send([byte]);
}

export function sendMIDIStart(deviceId: string) {
  sendRealtimeNow(deviceId, MIDI_START);
}

export function sendMIDIStop(deviceId: string) {
  sendRealtimeNow(deviceId, MIDI_STOP);
}

export function sendMIDIContinue(deviceId: string) {
  sendRealtimeNow(deviceId, MIDI_CONTINUE);
}

// HMR cleanup — without this, the Tauri hot-plug polling setInterval gets
// orphaned on module reload and a new one stacks on next init.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (tauriPoll !== null) {
      window.clearInterval(tauriPoll);
      tauriPoll = null;
    }
  });
}
