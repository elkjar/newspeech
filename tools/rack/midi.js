// Web MIDI plumbing: port picking (persisted), a paced output queue so old
// units don't choke, and an NRPN/SysEx input parser.

const LS = "rack.";
const lsGet = (k, d) => { try { return localStorage.getItem(LS + k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(LS + k, v); } catch {} };

export class Midi {
  constructor() {
    this.access = null;
    this.input = null;
    this.output = null;
    this.gapMs = 2;           // min spacing between outgoing messages (per device)
    this.nextSlot = 0;        // performance.now() time the next message may go out
    this.listeners = new Set();
    this.sysexWaiters = [];
    this.nrpnState = {};      // per channel: { pMsb, pLsb, vMsb, timer }
  }

  async init() {
    this.access = await navigator.requestMIDIAccess({ sysex: true });
    this.access.onstatechange = () => this.onPorts?.();
  }

  inputs() { return [...this.access.inputs.values()]; }
  outputs() { return [...this.access.outputs.values()]; }

  // ports are remembered per device id so each synth keeps its cable
  usePorts(deviceId, inId, outId) {
    if (this.input) this.input.onmidimessage = null;
    this.input = this.access.inputs.get(inId) || null;
    this.output = this.access.outputs.get(outId) || null;
    if (this.input) this.input.onmidimessage = (e) => this.receive(e.data);
    lsSet(`${deviceId}.in`, inId || "");
    lsSet(`${deviceId}.out`, outId || "");
  }
  savedPorts(deviceId) { return { in: lsGet(`${deviceId}.in`, ""), out: lsGet(`${deviceId}.out`, "") }; }

  send(bytes) {
    if (!this.output) return false;
    const now = performance.now();
    const at = Math.max(now, this.nextSlot);
    // sysex takes ~0.32 ms/byte on the wire at 31250 baud — space by length too
    this.nextSlot = at + this.gapMs + bytes.length * 0.32;
    this.output.send(bytes, at);
    return true;
  }

  // how long until everything queued has gone out
  drainMs() { return Math.max(0, this.nextSlot - performance.now()); }

  cc(ch, num, val) { this.send([0xb0 | ch, num & 127, val & 127]); }
  noteOn(ch, note, vel = 100) { this.send([0x90 | ch, note & 127, vel & 127]); }
  noteOff(ch, note) { this.send([0x80 | ch, note & 127, 0]); }

  nrpn(ch, param, value) {
    this.cc(ch, 99, param >> 7);
    this.cc(ch, 98, param & 127);
    this.cc(ch, 6, value >> 7);
    this.cc(ch, 38, value & 127);
  }

  on(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(ev) { for (const fn of this.listeners) fn(ev); }

  // resolve with the next sysex message matching `match(bytes)`
  waitSysex(match, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const w = { match, resolve };
      this.sysexWaiters.push(w);
      setTimeout(() => {
        const i = this.sysexWaiters.indexOf(w);
        if (i >= 0) { this.sysexWaiters.splice(i, 1); reject(new Error("no reply (timeout)")); }
      }, timeoutMs);
    });
  }

  receive(data) {
    const st = data[0];
    if (st === 0xf0) {
      const i = this.sysexWaiters.findIndex((w) => w.match(data));
      if (i >= 0) this.sysexWaiters.splice(i, 1)[0].resolve(data);
      this.emit({ type: "sysex", data });
      return;
    }
    if (st >= 0xf8) return; // clock / active sensing
    const kind = st & 0xf0, ch = st & 0x0f;
    if (kind === 0xb0) return this.receiveCC(ch, data[1], data[2]);
    if (kind === 0x90 || kind === 0x80) this.emit({ type: "note", ch, note: data[1], vel: kind === 0x90 ? data[2] : 0 });
    if (kind === 0xc0) this.emit({ type: "program", ch, program: data[1] });
  }

  receiveCC(ch, num, val) {
    const s = (this.nrpnState[ch] ||= {});
    const flush = () => {
      clearTimeout(s.timer); s.timer = null;
      if (s.pMsb == null || s.pLsb == null || s.vMsb == null) return;
      this.emit({ type: "nrpn", ch, param: (s.pMsb << 7) | s.pLsb, value: (s.vMsb << 7) | (s.vLsb ?? 0) });
      s.vMsb = s.vLsb = null;
    };
    if (num === 99) { s.pMsb = val; s.vMsb = s.vLsb = null; return; }
    if (num === 98) { s.pLsb = val; s.vMsb = s.vLsb = null; return; }
    if (num === 6) {
      s.vMsb = val; s.vLsb = null;
      // most senders follow with CC38; flush without it if it never comes
      clearTimeout(s.timer); s.timer = setTimeout(flush, 8);
      return;
    }
    if (num === 38) { s.vLsb = val; return flush(); }
    this.emit({ type: "cc", ch, num, val });
  }
}
