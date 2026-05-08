import { getAudioContext } from './audioContext';

export interface MIDIOutputInfo {
  id: string;
  name: string;
}

type Status = 'unsupported' | 'idle' | 'requesting' | 'ready' | 'denied';

let access: MIDIAccess | null = null;
let outputs: MIDIOutputInfo[] = [];
let status: Status =
  typeof navigator !== 'undefined' &&
  typeof (navigator as Navigator & { requestMIDIAccess?: unknown }).requestMIDIAccess === 'function'
    ? 'idle'
    : 'unsupported';
const listeners = new Set<() => void>();

function refreshOutputs() {
  if (!access) {
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

export async function initMIDIOut(): Promise<boolean> {
  if (status === 'unsupported' || status === 'denied') return false;
  if (status === 'ready') return true;
  status = 'requesting';
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
const CC_BANK_MSB = 0;
const CC_BANK_LSB = 32;

function audioToPerfMs(audioTime: number): number {
  const ctx = getAudioContext();
  return performance.now() + (audioTime - ctx.currentTime) * 1000;
}

export function sendMIDINote(
  deviceId: string,
  channel: number,
  note: number,
  velocity: number,
  when: number,
  durationS: number
) {
  if (!access) return;
  const out = access.outputs.get(deviceId);
  if (!out) return;
  const ch = ((channel | 0) & 0x0f);
  const n = Math.max(0, Math.min(127, note | 0));
  const v = Math.max(1, Math.min(127, Math.round(velocity * 127)));
  const onMs = audioToPerfMs(when);
  const offMs = audioToPerfMs(when + Math.max(0.02, durationS));
  out.send([NOTE_ON | ch, n, v], onMs);
  out.send([NOTE_OFF | ch, n, 0], offMs);
}

export function sendMIDIProgram(deviceId: string, channel: number, program: number) {
  if (!access) return;
  const out = access.outputs.get(deviceId);
  if (!out) return;
  const ch = ((channel | 0) & 0x0f);
  const p = Math.max(0, Math.min(127, program | 0));
  out.send([PROGRAM_CHANGE | ch, p]);
}

export function sendPatchSelect(
  deviceId: string,
  channel: number,
  bankMSB: number | null,
  bankLSB: number | null,
  program: number | null
) {
  if (!access) return;
  const out = access.outputs.get(deviceId);
  if (!out) return;
  const ch = ((channel | 0) & 0x0f);
  if (bankMSB !== null) {
    out.send([CONTROL_CHANGE | ch, CC_BANK_MSB, Math.max(0, Math.min(127, bankMSB | 0))]);
  }
  if (bankLSB !== null) {
    out.send([CONTROL_CHANGE | ch, CC_BANK_LSB, Math.max(0, Math.min(127, bankLSB | 0))]);
  }
  if (program !== null) {
    out.send([PROGRAM_CHANGE | ch, Math.max(0, Math.min(127, program | 0))]);
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
  if (!access) return;
  access.outputs.forEach((out) => {
    for (let ch = 0; ch < 16; ch++) {
      out.send([ALL_NOTES_OFF_CC | ch, 123, 0]);
    }
  });
}
