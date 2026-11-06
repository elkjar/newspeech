// MIDI capture — during a multi (stems) take, records the performance as
// Standard MIDI Files beside the WAVs. The point is a redundant playback rig:
// drop the .mid files into a DAW, route each to a synth, and the parts still
// play "live" from the performance Sequence actually gave — mutation, Ghost
// fills, LFO/macro CC sweeps, program changes, keyboard-monitor playing — not
// the authored pattern.
//
// Two sources:
//   • External hardware — one file per destination (port + channel), from a
//     tap at the lowest layer of midiOut.ts (every send, scheduled or
//     immediate, passes through it), so nothing upstream knows about capture.
//   • Sample tracks — one file per track, named like its stem
//     (`m01_pad.mid` beside `m01_pad.wav`), fed by the dispatcher at each
//     native trigger: the played pitch (chord tones, arp tones), velocity,
//     and gate length, so the part can be revoiced on a synth.
//
// Times are performance.now() ms — scheduled sends carry their INTENDED time,
// not the setTimeout fire time, so jitter never lands in the file.

import { invoke } from '@tauri-apps/api/core';
import { useSequencerStore } from '../state/store';
import { sourceLabel } from '../instruments/library';
import { resolveDeviceId, setMidiSendTap } from './midiOut';
import { engineTimeToPerfMs } from './engineClock';

const PPQ = 960;
// Unpitched sample hits (drum one-shots) land on C1 — Drum Rack's first pad.
const UNPITCHED_NOTE = 36;

interface CapturedEvent {
  atMs: number; // performance.now() ms
  bytes: number[];
}

interface Destination {
  port: string;
  channel: number; // 0..15
  events: CapturedEvent[];
}

interface ChannelState {
  // Latest CC values (incl. bank select 0/32) + program, seeded into a new
  // take at tick 0 so a clip recalls the synth's state when it starts.
  cc: Map<number, number>;
  program: number | null;
}

// Per sample track: the stem's base name + the clip's channel (GM drums
// on 10, everything else on 1).
export interface SampleTrackFile {
  base: string;
  channel: number;
}

interface SampleNote {
  note: number;
  velocity: number; // 1..127
  onMs: number;
  offMs: number;
}

interface Capture {
  dir: string;
  startPerfMs: number;
  destinations: Map<string, Destination>;
  seed: Map<string, ChannelState>;
  sampleTracks: Map<string, SampleTrackFile>;
  sampleNotes: Map<string, SampleNote[]>;
  // Tempo changes during the take, in ms relative to start. [0] is the
  // starting tempo.
  tempos: { atMs: number; bpm: number }[];
  unsubscribeBpm: () => void;
}

// Running per-destination state, tracked whether or not a take is live.
const channelState = new Map<string, ChannelState>();
let capture: Capture | null = null;

const keyOf = (port: string, channel: number) => `${port}\u0000${channel}`;

// Called by midiOut for every outgoing message.
function noteMidiSent(port: string, bytes: number[], atMs: number): void {
  const status = bytes[0];
  // Channel voice messages only — realtime start/stop/clock and SysEx have
  // no place in a per-channel clip.
  if (status < 0x80 || status >= 0xf0) return;
  const channel = status & 0x0f;
  const type = status & 0xf0;
  const key = keyOf(port, channel);

  let st = channelState.get(key);
  if (!st) {
    st = { cc: new Map(), program: null };
    channelState.set(key, st);
  }
  if (type === 0xb0) st.cc.set(bytes[1], bytes[2]);
  else if (type === 0xc0) st.program = bytes[1];

  if (!capture) return;
  // A few ms of slack: first-downbeat notes can round to just before start.
  if (atMs < capture.startPerfMs - 5) return;
  let dest = capture.destinations.get(key);
  if (!dest) {
    dest = { port, channel, events: [] };
    capture.destinations.set(key, dest);
  }
  dest.events.push({ atMs: Math.max(atMs, capture.startPerfMs), bytes: bytes.slice() });
}

// Dispatcher hook: a sample-track trigger that actually fired. `note`
// undefined = an unpitched hit. Engine-clock seconds in.
export function captureSampleNote(
  trackId: string,
  note: number | undefined,
  velocity: number,
  whenSecs: number,
  durationSecs: number,
): void {
  if (!capture || !capture.sampleTracks.has(trackId)) return;
  const onMs = engineTimeToPerfMs(whenSecs);
  if (onMs < capture.startPerfMs - 5) return;
  let list = capture.sampleNotes.get(trackId);
  if (!list) {
    list = [];
    capture.sampleNotes.set(trackId, list);
  }
  list.push({
    note: Math.max(0, Math.min(127, Math.round(note ?? UNPITCHED_NOTE))),
    velocity: Math.max(1, Math.min(127, Math.round(velocity * 127))),
    onMs: Math.max(onMs, capture.startPerfMs),
    offMs: engineTimeToPerfMs(whenSecs + Math.max(0.02, durationSecs)),
  });
}

// Perform-punch edges flush queued native triggers from `whenSecs` on and
// re-dispatch them — drop the captured copies so they aren't doubled.
export function dropSampleNotesFrom(whenSecs: number): void {
  if (!capture) return;
  const cut = engineTimeToPerfMs(whenSecs);
  for (const [id, list] of capture.sampleNotes) {
    capture.sampleNotes.set(id, list.filter((n) => n.onMs < cut));
  }
}

export function beginMidiCapture(
  dir: string,
  startPerfMs: number,
  sampleTracks: Map<string, SampleTrackFile>,
): void {
  if (capture) capture.unsubscribeBpm();
  const seed = new Map<string, ChannelState>();
  for (const [k, st] of channelState) {
    seed.set(k, { cc: new Map(st.cc), program: st.program });
  }
  const tempos = [{ atMs: 0, bpm: useSequencerStore.getState().bpm }];
  const unsubscribeBpm = useSequencerStore.subscribe((s, prev) => {
    if (s.bpm === prev.bpm || !capture) return;
    tempos.push({ atMs: Math.max(0, performance.now() - capture.startPerfMs), bpm: s.bpm });
  });
  capture = {
    dir,
    startPerfMs,
    destinations: new Map(),
    seed,
    sampleTracks,
    sampleNotes: new Map(),
    tempos,
    unsubscribeBpm,
  };
}

// Close the take and write its files. Resolves to the number written.
export async function endMidiCapture(): Promise<number> {
  const c = capture;
  if (!c) return 0;
  capture = null;
  c.unsubscribeBpm();
  const endPerfMs = performance.now();
  const endMs = endPerfMs - c.startPerfMs;
  const files: { base: string; bytes: Uint8Array }[] = [];

  const names = destinationNames();
  const used = new Set<string>();
  for (const [key, dest] of c.destinations) {
    if (!dest.events.some((e) => (e.bytes[0] & 0xf0) === 0x90)) continue;
    let base = `midi_${names.get(key) ?? slug(dest.port)}_ch${String(dest.channel + 1).padStart(2, '0')}`;
    while (used.has(base)) base += '_';
    used.add(base);
    files.push({ base, bytes: writeSmf(base, dest, c.seed.get(key), c.startPerfMs, endMs, c.tempos) });
  }

  for (const [trackId, notes] of c.sampleNotes) {
    const file = c.sampleTracks.get(trackId);
    if (!file || notes.length === 0) continue;
    const ch = file.channel;
    // A same-pitch retrigger ends the previous note — overlapping same-pitch
    // notes are ambiguous in SMF and DAWs cut them unpredictably.
    const sorted = [...notes].sort((a, b) => a.onMs - b.onMs);
    const nextOn = new Map<number, number>();
    const offs = new Array<number>(sorted.length);
    for (let i = sorted.length - 1; i >= 0; i--) {
      const n = sorted[i];
      offs[i] = Math.min(n.offMs, nextOn.get(n.note) ?? Infinity, endPerfMs);
      nextOn.set(n.note, n.onMs);
    }
    const events: CapturedEvent[] = [];
    sorted.forEach((n, i) => {
      events.push({ atMs: n.onMs, bytes: [0x90 | ch, n.note, n.velocity] });
      events.push({ atMs: Math.max(n.onMs, offs[i]), bytes: [0x80 | ch, n.note, 0] });
    });
    const dest = { port: '', channel: ch, events };
    files.push({ base: file.base, bytes: writeSmf(file.base, dest, undefined, c.startPerfMs, endMs, c.tempos) });
  }

  let written = 0;
  for (const { base, bytes } of files) {
    try {
      await invoke('save_binary_file', {
        path: `${c.dir.replace(/\/$/, '')}/${base}.mid`,
        contents: Array.from(bytes),
      });
      written++;
    } catch (err) {
      console.warn('[midiCapture] write failed:', err);
    }
  }
  return written;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Name each destination after the instrument tracks that send to it, so the
// file reads as the synth it drives (`midi_jv_2080_ch03.mid`).
function destinationNames(): Map<string, string> {
  const s = useSequencerStore.getState();
  const labels = new Map<string, string[]>();
  for (const t of s.tracks) {
    if (t.source.kind !== 'instrument') continue;
    const port = resolveDeviceId(t.midi.portName, s.midiOutDeviceId);
    if (!port) continue;
    const key = keyOf(port, t.midi.channel & 0x0f);
    const label = slug(sourceLabel(t.source));
    const list = labels.get(key) ?? [];
    if (label && !list.includes(label)) list.push(label);
    labels.set(key, list);
  }
  const out = new Map<string, string>();
  for (const [k, list] of labels) if (list.length) out.set(k, list.join('+'));
  return out;
}

// ms-since-start → ticks, walking the take's tempo map.
function msToTicks(ms: number, tempos: { atMs: number; bpm: number }[]): number {
  let ticks = 0;
  for (let i = 0; i < tempos.length; i++) {
    const segStart = tempos[i].atMs;
    if (ms <= segStart) break;
    const segEnd = i + 1 < tempos.length ? Math.min(ms, tempos[i + 1].atMs) : ms;
    ticks += ((segEnd - segStart) / 60000) * tempos[i].bpm * PPQ;
  }
  return Math.round(ticks);
}

function vlq(n: number): number[] {
  const out = [n & 0x7f];
  n >>>= 7;
  while (n > 0) {
    out.unshift((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  return out;
}

// Type-0 SMF: name + 4/4 + tempo map + seeded state + the take's events.
function writeSmf(
  name: string,
  dest: Destination,
  seed: ChannelState | undefined,
  startPerfMs: number,
  endMs: number,
  tempos: { atMs: number; bpm: number }[],
): Uint8Array {
  // order: meta < seed < note-off < everything else < note-on, within a tick
  type Ev = { tick: number; order: number; seq: number; data: number[] };
  const evs: Ev[] = [];
  let seq = 0;
  const push = (tick: number, order: number, data: number[]) =>
    evs.push({ tick, order, seq: seq++, data });

  const nameBytes = Array.from(new TextEncoder().encode(name));
  push(0, 0, [0xff, 0x03, ...vlq(nameBytes.length), ...nameBytes]);
  push(0, 0, [0xff, 0x58, 0x04, 0x04, 0x02, 0x18, 0x08]);
  for (const t of tempos) {
    const us = Math.round(60_000_000 / t.bpm);
    push(msToTicks(t.atMs, tempos), 0, [0xff, 0x51, 0x03, (us >> 16) & 0xff, (us >> 8) & 0xff, us & 0xff]);
  }

  const ch = dest.channel;
  if (seed) {
    for (const cc of [0, 32]) {
      const v = seed.cc.get(cc);
      if (v !== undefined) push(0, 1, [0xb0 | ch, cc, v]);
    }
    if (seed.program !== null) push(0, 1, [0xc0 | ch, seed.program]);
    for (const [cc, v] of seed.cc) {
      if (cc !== 0 && cc !== 32) push(0, 1, [0xb0 | ch, cc, v]);
    }
  }

  // Note-ons still open at the end (offs cancelled by the stop) get closed
  // at the end of the take.
  const open = new Map<number, number>();
  let lastTick = 0;
  for (const e of dest.events) {
    const tick = msToTicks(e.atMs - startPerfMs, tempos);
    lastTick = Math.max(lastTick, tick);
    const type = e.bytes[0] & 0xf0;
    const isOn = type === 0x90 && e.bytes[2] > 0;
    const isOff = type === 0x80 || (type === 0x90 && e.bytes[2] === 0);
    if (isOn) open.set(e.bytes[1], (open.get(e.bytes[1]) ?? 0) + 1);
    if (isOff) {
      const n = open.get(e.bytes[1]) ?? 0;
      if (n <= 1) open.delete(e.bytes[1]);
      else open.set(e.bytes[1], n - 1);
    }
    push(tick, isOff ? 2 : isOn ? 4 : 3, e.bytes);
  }
  const endTick = Math.max(lastTick, msToTicks(endMs, tempos));
  for (const [note, n] of open) {
    for (let i = 0; i < n; i++) push(endTick, 2, [0x80 | ch, note, 0]);
  }
  push(endTick, 5, [0xff, 0x2f, 0x00]);

  evs.sort((a, b) => a.tick - b.tick || a.order - b.order || a.seq - b.seq);
  const track: number[] = [];
  let prev = 0;
  for (const e of evs) {
    track.push(...vlq(e.tick - prev), ...e.data);
    prev = e.tick;
  }
  const len = track.length;
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, (PPQ >> 8) & 0xff, PPQ & 0xff,
    0x4d, 0x54, 0x72, 0x6b, (len >>> 24) & 0xff, (len >>> 16) & 0xff, (len >>> 8) & 0xff, len & 0xff,
    ...track,
  ]);
}

setMidiSendTap(noteMidiSent);

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    setMidiSendTap(null);
    if (capture) capture.unsubscribeBpm();
    capture = null;
  });
}
