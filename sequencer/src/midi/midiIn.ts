// MIDI input — port enumeration + message parsing. Two backends:
//   - Browser: navigator.requestMIDIAccess (Web MIDI API).
//   - Tauri:   invoke into the midir-backed Rust bridge; messages arrive
//              via the `midi://message` Tauri event. WKWebView doesn't
//              expose Web MIDI so the in-app shell goes native.
// Both paths funnel through the same `listener` callback so midiMap.ts
// stays unchanged.

import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// `port` is the source device's display name. Carried on every message
// so per-feature routing (e.g. record-from-keyboard-only) can filter.
// CC mapping ignores it; only the recording path inspects it today.
export type MidiMessage =
  | { ch: number; msg: 'cc'; num: number; value: number; port: string }
  | { ch: number; msg: 'note'; num: number; value: number; port: string };

const TAURI = isTauri();

let access: MIDIAccess | null = null;
let listener: ((msg: MidiMessage) => void) | null = null;
let portListener: ((name: string) => void) | null = null;

// Tauri-mode state.
let tauriUnlisten: UnlistenFn | null = null;
let tauriInputNames: string[] = [];
let tauriPoll: number | null = null;
const inputsChangedListeners = new Set<() => void>();

export function onMIDIInputsChanged(cb: () => void): () => void {
  inputsChangedListeners.add(cb);
  return () => {
    inputsChangedListeners.delete(cb);
  };
}

function notifyInputsChanged(): void {
  for (const cb of inputsChangedListeners) cb();
}

function parseMessage(data: Uint8Array | number[], port: string): MidiMessage | null {
  if (data.length < 2) return null;
  const status = data[0];
  const ch = status & 0x0f;
  const type = status & 0xf0;
  if (type === 0xb0) {
    if (data.length < 3) return null;
    return { ch, msg: 'cc', num: data[1], value: data[2], port };
  }
  if (type === 0x90 && data.length >= 3 && data[2] > 0) {
    return { ch, msg: 'note', num: data[1], value: data[2], port };
  }
  return null;
}

function wireInput(input: MIDIInput): void {
  const port = input.name ?? '';
  input.onmidimessage = (e) => {
    const data = (e as MIDIMessageEvent).data;
    if (!data) return;
    const msg = parseMessage(data, port);
    if (msg && listener) listener(msg);
  };
}

interface MidiPorts {
  inputs: string[];
  outputs: string[];
}

async function refreshTauriInputs(): Promise<void> {
  try {
    const ports = await invoke<MidiPorts>('midi_list_ports');
    const next = ports.inputs;
    // Subscribe to any newly-connected port (Rust no-ops if already subscribed).
    for (const name of next) {
      if (!tauriInputNames.includes(name)) {
        try {
          await invoke('midi_subscribe_input', { portName: name });
          if (portListener) portListener(name);
        } catch (err) {
          console.warn(`[midiIn] subscribe ${name} failed:`, err);
        }
      }
    }
    // Evict stale Rust-side subscriptions for ports that disappeared. Without
    // this, the next replug of the same device hits the cached (now-dead)
    // connection entry and subscribe early-returns — events stop reaching JS.
    for (const name of tauriInputNames) {
      if (!next.includes(name)) {
        try {
          await invoke('midi_unsubscribe_input', { portName: name });
        } catch (err) {
          console.warn(`[midiIn] unsubscribe ${name} failed:`, err);
        }
      }
    }
    const changed =
      next.length !== tauriInputNames.length ||
      next.some((n, i) => n !== tauriInputNames[i]);
    if (changed) {
      tauriInputNames = next;
      notifyInputsChanged();
    }
  } catch (err) {
    console.warn('[midiIn] refresh inputs failed:', err);
  }
}

async function initTauri(): Promise<boolean> {
  try {
    await refreshTauriInputs();
    if (tauriUnlisten) tauriUnlisten();
    tauriUnlisten = await listen<{ port: string; bytes: number[] }>(
      'midi://message',
      (event) => {
        if (!listener) return;
        const msg = parseMessage(event.payload.bytes, event.payload.port);
        if (msg) listener(msg);
      }
    );
    if (tauriPoll === null) {
      // Hot-plug discovery — midir has no port-change event stream so we
      // poll. Match the output-side cadence (3 s).
      tauriPoll = window.setInterval(() => {
        void refreshTauriInputs();
      }, 3000);
    }
    return true;
  } catch (err) {
    console.error('[midiIn] Tauri init failed:', err);
    return false;
  }
}

export async function initMIDIIn(
  onMessage: (msg: MidiMessage) => void,
  onPortConnected?: (name: string) => void
): Promise<boolean> {
  listener = onMessage;
  portListener = onPortConnected ?? null;
  if (TAURI) return initTauri();
  const nav = navigator as Navigator & {
    requestMIDIAccess?: (opts?: { sysex?: boolean }) => Promise<MIDIAccess>;
  };
  if (typeof nav.requestMIDIAccess !== 'function') return false;
  try {
    access = await nav.requestMIDIAccess({ sysex: false });
  } catch {
    return false;
  }
  for (const input of access.inputs.values()) {
    wireInput(input);
    if (portListener && input.name) portListener(input.name);
  }
  notifyInputsChanged();
  access.onstatechange = (e) => {
    const port = (e as MIDIConnectionEvent).port;
    if (!port || port.type !== 'input') return;
    if (port.state === 'connected') {
      const input = port as MIDIInput;
      wireInput(input);
      if (portListener && input.name) portListener(input.name);
    }
    notifyInputsChanged();
  };
  return true;
}

export function getConnectedInputNames(): string[] {
  if (TAURI) return tauriInputNames.slice();
  if (!access) return [];
  const names: string[] = [];
  for (const input of access.inputs.values()) {
    if (input.name) names.push(input.name);
  }
  return names;
}

// HMR cleanup — without this, the Tauri hot-plug polling setInterval gets
// orphaned on module reload and a new one stacks on next init. Also clears
// the `midi://message` Tauri event listener, since a midiIn-only HMR cycle
// won't necessarily re-run App.tsx's effect that calls initMIDIIn() — without
// the unlisten here the handle is zeroed and the old listener leaks forever.
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (tauriPoll !== null) {
      window.clearInterval(tauriPoll);
      tauriPoll = null;
    }
    if (tauriUnlisten) {
      tauriUnlisten();
      tauriUnlisten = null;
    }
  });
}
