// edit.app (Tauri) bridge. WKWebView has no Web MIDI, so inside the app MIDI runs
// natively (midir, app/src-tauri/src/midi.rs) and this file dresses it up as a
// Web MIDI access object — midi.js and every driver stay exactly as on the site.
// Storage goes the same way: backups + pedal libraries land in Dropbox __RACK/.
// On the website none of this runs (no window.__TAURI__).

const T = typeof window !== "undefined" ? window.__TAURI__ : undefined;
export const APP = !!T?.core;
export const invoke = (cmd, args) => T.core.invoke(cmd, args);

// CoreMIDI hands over packets, not messages: several messages per callback, a long
// SysEx split across callbacks, realtime bytes (F8-FF) anywhere. Web MIDI delivers
// one complete message per event — rebuild that.
export function midiParser(emit) {
  let sysex = null, status = 0, need = 0, buf = [];
  const len = (st) => (st >= 0xf0 ? { 0xf1: 2, 0xf2: 3, 0xf3: 2 }[st] ?? 1 : (st & 0xe0) === 0xc0 ? 2 : 3);
  return (bytes) => {
    for (const b of bytes) {
      if (b >= 0xf8) { emit([b]); continue; }                       // realtime: never breaks a message
      if (b === 0xf0) { sysex = [b]; status = 0; continue; }
      if (sysex) {
        if (b === 0xf7) { sysex.push(b); emit(sysex); sysex = null; continue; }
        if (b < 0x80) { sysex.push(b); continue; }
        sysex = null;                                                // a status byte cut it short: drop it
      }
      if (b >= 0x80) {
        if (b === 0xf7) continue;
        status = b; need = len(b); buf = [b];
        if (need === 1) { emit(buf); status = b >= 0xf0 ? 0 : status; }
        continue;
      }
      if (!status) continue;                                         // stray data byte
      if (buf.length === 0) buf = [status];                          // running status
      buf.push(b);
      if (buf.length === need) { emit(buf); buf = []; if (status >= 0xf0) status = 0; }
    }
  };
}

// Web MIDI's output.send(bytes, at) schedules on performance.now(); midi.js paces the
// slow synths that way. One ordered queue per port keeps that timing and order.
function outQueue(port) {
  const q = []; let timer = null;
  const pump = () => {
    timer = null;
    while (q.length && q[0].at <= performance.now() + 0.5) {
      const { bytes } = q.shift();
      invoke("midi_send", { portName: port, bytes }).catch((e) => console.warn("midi_send", e));
    }
    if (q.length) timer = setTimeout(pump, Math.max(0, q[0].at - performance.now()));
  };
  return (bytes, at = 0) => {
    q.push({ bytes: Array.from(bytes), at: at || performance.now() });
    if (!timer) pump();
  };
}

export async function tauriMidiAccess() {
  const access = { inputs: new Map(), outputs: new Map(), onstatechange: null };
  const handlers = new Map(); // input port name → onmidimessage
  const parsers = new Map();
  const makeIn = (name) => ({
    id: name, name, type: "input",
    get onmidimessage() { return handlers.get(name) || null; },
    set onmidimessage(fn) {
      if (fn) { handlers.set(name, fn); parsers.set(name, midiParser((m) => handlers.get(name)?.({ data: Uint8Array.from(m) }))); invoke("midi_subscribe_input", { portName: name }).catch((e) => console.warn("subscribe", e)); }
      else { handlers.delete(name); invoke("midi_unsubscribe_input", { portName: name }).catch(() => {}); }
    },
  });
  const makeOut = (name) => ({ id: name, name, type: "output", send: outQueue(name) });

  await T.event.listen("midi://message", (e) => parsers.get(e.payload.port)?.(e.payload.bytes));

  // CoreMIDI has no change callback over the bridge: poll, like Sequence does
  const refresh = async () => {
    let ports;
    try { ports = await invoke("midi_list_ports"); } catch { return; }
    let changed = false;
    const sync = (map, names, make) => {
      for (const n of names) if (!map.has(n)) { map.set(n, make(n)); changed = true; }
      for (const n of [...map.keys()]) if (!names.includes(n)) { map.delete(n); changed = true; if (handlers.has(n)) invoke("midi_unsubscribe_input", { portName: n }).catch(() => {}); }
    };
    sync(access.inputs, ports.inputs, makeIn);
    sync(access.outputs, ports.outputs, makeOut);
    if (changed) access.onstatechange?.();
  };
  await refresh();
  setInterval(refresh, 2000);
  return access;
}
