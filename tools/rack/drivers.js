// Transport drivers. Each device schema names one ("nrpn", later "roland",
// "yamaha", "ensoniq"); the editor only ever talks to this interface:
//
//   sendParam(param, value)       one live edit
//   sendPatch(values)             whole patch → edit buffer
//   requestPatch() → values       read the edit buffer back
//   decode(ev) → [{param,value}]  front-panel moves arriving from the synth

// DSI "packed MS bit" format: every 7 data bytes travel as 8 — a leading byte
// holding the top bit of each of the next 7 (bit 0 = first byte).
export function dsiUnpack(packed) {
  const out = [];
  for (let i = 0; i < packed.length; i += 8) {
    const msbs = packed[i];
    for (let j = 0; j < 7 && i + 1 + j < packed.length; j++)
      out.push(packed[i + 1 + j] | (((msbs >> j) & 1) << 7));
  }
  return out;
}

export function dsiPack(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length; i += 7) {
    const chunk = bytes.slice(i, i + 7);
    let msbs = 0;
    chunk.forEach((b, j) => { msbs |= ((b >> 7) & 1) << j; });
    out.push(msbs, ...chunk.map((b) => b & 127));
  }
  return out;
}

export function makeDriver(schema, midi, getChannel) {
  if (schema.transport === "nrpn") return nrpnDriver(schema, midi, getChannel);
  throw new Error(`no driver for transport "${schema.transport}" yet`);
}

function nrpnDriver(schema, midi, getChannel) {
  const byNrpn = new Map(schema.params.map((p) => [p.nrpn, p]));
  const sx = schema.sysex || {};
  const mfr = sx.manufacturerId || [];
  const dev = sx.deviceId;
  const hdr = [0xf0, ...mfr, dev];
  const isFrom = (cmd) => (d) => mfr.every((b, i) => d[1 + i] === b) && d[1 + mfr.length] === dev && d[2 + mfr.length] === cmd;

  // program data (unpacked) ↔ values keyed by param.key; sysexIndex defaults to nrpn
  const idx = (p) => p.sysexIndex ?? p.nrpn;
  const toValues = (data) => Object.fromEntries(schema.params.filter((p) => idx(p) < data.length).map((p) => [p.key, data[idx(p)]]));
  // unmodelled bytes ride along from the last dump read, so a send never zeroes them
  let lastData = null;
  const toData = (values) => {
    const data = lastData ? [...lastData] : new Array(sx.programBytes || 0).fill(0);
    for (const p of schema.params) if (values[p.key] != null && idx(p) < data.length) data[idx(p)] = values[p.key];
    return data;
  };

  return {
    sendParam(p, v) { midi.nrpn(getChannel(), p.nrpn, v); },

    sendPatch(values) {
      // one edit-buffer dump when the layout is known; otherwise an NRPN burst
      if (sx.cmd?.editBufferDump != null && sx.programBytes) {
        midi.send([...hdr, sx.cmd.editBufferDump, ...dsiPack(toData(values)), 0xf7]);
      } else {
        for (const p of schema.params) if (values[p.key] != null) midi.nrpn(getChannel(), p.nrpn, values[p.key]);
      }
    },

    async requestPatch() {
      if (sx.cmd?.requestEditBuffer == null) throw new Error("this device can't send its edit buffer");
      const reply = midi.waitSysex(isFrom(sx.cmd.editBufferDump));
      midi.send([...hdr, sx.cmd.requestEditBuffer, 0xf7]);
      const d = await reply;
      const body = d.slice(3 + mfr.length, d.length - 1); // after header+cmd, before F7
      const data = dsiUnpack([...body]).slice(0, sx.programBytes);
      lastData = data;
      return { values: toValues(data), syx: [...d] };
    },

    programChange(bank, prog) {
      const pr = schema.programs || {};
      if (pr.bankCC != null) midi.cc(getChannel(), pr.bankCC, bank);
      midi.send([0xc0 | getChannel(), prog & 127]);
    },

    // read one stored slot without changing what the synth is playing
    async requestProgram(bank, prog) {
      if (sx.cmd?.requestProgram == null) throw new Error("this device can't send stored programs");
      const n = 3 + mfr.length; // F0 mfr dev cmd → bank at n, prog at n+1
      const reply = midi.waitSysex((d) => isFrom(sx.cmd.programDump)(d) && d[n] === bank && d[n + 1] === prog);
      midi.send([...hdr, sx.cmd.requestProgram, bank, prog, 0xf7]);
      const d = await reply;
      const data = dsiUnpack([...d.slice(n + 2, d.length - 1)]).slice(0, sx.programBytes);
      return { values: toValues(data), data, syx: [...d] };
    },

    // store into a memory slot (overwrites it) — returns the bytes sent so the
    // caller can read the slot back and compare
    writeProgram(bank, prog, values) {
      if (sx.cmd?.programDump == null) throw new Error("this device can't store programs over MIDI");
      const data = toData(values);
      midi.send([...hdr, sx.cmd.programDump, bank, prog, ...dsiPack(data), 0xf7]);
      return data;
    },

    // modelled params only — unused bytes may legitimately differ
    sameProgram(a, b) { return schema.params.every((p) => a[idx(p)] === b[idx(p)]); },

    decode(ev) {
      if (ev.type !== "nrpn" || ev.ch !== getChannel()) return [];
      const p = byNrpn.get(ev.param);
      return p ? [{ param: p, value: ev.value }] : [];
    },
  };
}
