// Web MIDI input — port enumeration, hot-plug, message parsing.
// All messages funnel through a single callback so the dispatcher in
// midiMap.ts can be the only consumer.

export type MidiMessage =
  | { ch: number; msg: 'cc'; num: number; value: number }
  | { ch: number; msg: 'note'; num: number; value: number };

let access: MIDIAccess | null = null;
let listener: ((msg: MidiMessage) => void) | null = null;
let portListener: ((name: string) => void) | null = null;

function parseMessage(data: Uint8Array): MidiMessage | null {
  if (data.length < 2) return null;
  const status = data[0];
  const ch = status & 0x0f;
  const type = status & 0xf0;
  if (type === 0xb0) {
    if (data.length < 3) return null;
    return { ch, msg: 'cc', num: data[1], value: data[2] };
  }
  if (type === 0x90 && data.length >= 3 && data[2] > 0) {
    return { ch, msg: 'note', num: data[1], value: data[2] };
  }
  // Note Off (0x80) and Note On with velocity 0 are ignored for v1 —
  // momentary actions are post-v1.
  return null;
}

function wireInput(input: MIDIInput): void {
  input.onmidimessage = (e) => {
    const data = (e as MIDIMessageEvent).data;
    if (!data) return;
    const msg = parseMessage(data);
    if (msg && listener) listener(msg);
  };
}

export async function initMIDIIn(
  onMessage: (msg: MidiMessage) => void,
  onPortConnected?: (name: string) => void
): Promise<boolean> {
  listener = onMessage;
  portListener = onPortConnected ?? null;
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
  access.onstatechange = (e) => {
    const port = (e as MIDIConnectionEvent).port;
    if (!port || port.type !== 'input' || port.state !== 'connected') return;
    const input = port as MIDIInput;
    wireInput(input);
    if (portListener && input.name) portListener(input.name);
  };
  return true;
}

export function getConnectedInputNames(): string[] {
  if (!access) return [];
  const names: string[] = [];
  for (const input of access.inputs.values()) {
    if (input.name) names.push(input.name);
  }
  return names;
}
