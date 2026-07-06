// MIDI input — port enumeration + message parsing, Tauri-only: invoke into
// the midir-backed Rust bridge; messages arrive via the `midi://message`
// Tauri event (WKWebView doesn't expose Web MIDI). The old browser backend
// (navigator.requestMIDIAccess) was removed 2026-07-06 — the app is
// native-only. Everything funnels through the same `listener` callback so
// midiMap.ts stays unchanged.

import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// `port` is the source device's display name. Carried on every message
// so per-feature routing (e.g. record-from-keyboard-only) can filter.
// CC mapping ignores it; only the recording path inspects it today.
// `noteoff` is consumed only by the recorder (held-note → tie capture); CC
// bindings never match it, so it's harmless if it falls through.
// `realtime` carries a single system-realtime status byte (clock 0xF8,
// start 0xFA, continue 0xFB, stop 0xFC) — channel-less, 1-byte. Consumed
// only by the external-clock follower (clockFollow.ts), filtered by port.
export type MidiMessage =
  | { ch: number; msg: 'cc'; num: number; value: number; port: string }
  | { ch: number; msg: 'note'; num: number; value: number; port: string }
  | { ch: number; msg: 'noteoff'; num: number; port: string }
  | { msg: 'realtime'; status: number; port: string }
  // Native clock tick: a throttled, counter-tagged 0xF8 stream (see midi.rs).
  // `count` is the cumulative pulse count, `micros` the hardware timestamp.
  | { msg: 'clock-tick'; count: number; micros: number; port: string };

let listener: ((msg: MidiMessage) => void) | null = null;
let portListener: ((name: string) => void) | null = null;

// Tauri-mode state.
let tauriUnlisten: UnlistenFn | null = null;
let tauriClockUnlisten: UnlistenFn | null = null;
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
  // System realtime is a single byte (status >= 0xF8) and would otherwise be
  // dropped by the length guard below. Only the ones the clock follower cares
  // about (clock / start / continue / stop) are surfaced; active-sense (0xFE)
  // and the rest fall through to null.
  const rt = data[0];
  if (rt === 0xf8 || rt === 0xfa || rt === 0xfb || rt === 0xfc) {
    return { msg: 'realtime', status: rt, port };
  }
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
  // Note-off: explicit 0x80, or the running-status idiom of note-on with
  // velocity 0 (what many keyboards actually send on key release).
  if (type === 0x80 && data.length >= 2) {
    return { ch, msg: 'noteoff', num: data[1], port };
  }
  if (type === 0x90 && data.length >= 3 && data[2] === 0) {
    return { ch, msg: 'noteoff', num: data[1], port };
  }
  return null;
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
    // Throttled, counter-tagged clock stream (see midi.rs) — kept off the raw
    // message channel so the ~48/sec pulse rate can't starve it. Forwarded as a
    // clock-tick message so it funnels through the same dispatcher/listener.
    if (tauriClockUnlisten) tauriClockUnlisten();
    tauriClockUnlisten = await listen<{ port: string; count: number; micros: number }>(
      'midi://clock',
      (event) => {
        if (!listener) return;
        const { port, count, micros } = event.payload;
        listener({ msg: 'clock-tick', count, micros, port });
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
  return initTauri();
}

export function getConnectedInputNames(): string[] {
  return tauriInputNames.slice();
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
    if (tauriClockUnlisten) {
      tauriClockUnlisten();
      tauriClockUnlisten = null;
    }
  });
}
