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

// bank select for a schema bank entry ({ msb?, lsb? }) then program change
function selectProgram(midi, ch, bank, prog) {
  if (bank?.msb != null) midi.cc(ch, 0, bank.msb);
  if (bank?.lsb != null) midi.cc(ch, 32, bank.lsb);
  midi.send([0xc0 | ch, prog & 127]);
}

export function makeDriver(schema, midi, getChannel) {
  if (schema.transport === "nrpn") return nrpnDriver(schema, midi, getChannel);
  if (schema.transport === "roland") return rolandDriver(schema, midi, getChannel);
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

    programChange(bi, prog) { selectProgram(midi, getChannel(), schema.programs.banks[bi], prog); },

    // read one stored slot without changing what the synth is playing
    async requestProgram(bi, prog) {
      const bank = schema.programs.banks[bi].sysexBank ?? bi;
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
    writeProgram(bi, prog, values) {
      if (sx.cmd?.programDump == null) throw new Error("this device can't store programs over MIDI");
      const bank = schema.programs.banks[bi].sysexBank ?? bi;
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

// Roland DT1/RQ1 (JV-1080; the D-110/U-110/S-330 speak the same shape).
// Addresses and sizes are 4 bytes of 7 bits; a param lives at block base +
// byte offset; checksum = (128 - sum(addr+data) % 128) % 128. Multi-byte
// values ("nibble") travel high 4 bits first.
function rolandDriver(schema, midi, getChannel) {
  const R = schema.roland;
  const mfr = R.manufacturerId, model = R.modelId, dev = R.defaultDeviceId ?? 16;
  const hdr = [0xf0, ...mfr, dev, ...model];
  const A = hdr.length + 1; // index of the first address byte in a message
  const toInt = (a) => a.reduce((n, b) => n * 128 + b, 0);
  const toAddr = (n) => [(n >> 21) & 127, (n >> 14) & 127, (n >> 7) & 127, n & 127];
  const sum = (bytes) => (128 - (bytes.reduce((t, b) => t + b, 0) % 128)) % 128;
  const isDT1 = (d) => d[0] === 0xf0 && hdr.every((b, i) => d[i] === b) && d[hdr.length] === R.commands.DT1;

  // the blocks that make up a patch (system/global blocks stay out of sends)
  const blocks = Object.entries(R.blocks).map(([name, b]) => ({ name, ...b, at: toInt(b.base) }));
  const paramsOf = new Map(blocks.map((b) => [b.name, schema.params.filter((p) => p.block === b.name)]));
  const patchBlocks = blocks.filter((b) => paramsOf.get(b.name).some((p) => !p.notInPatch));
  const size = (p) => p.size || 1;

  const encode = (p, v) => size(p) === 1 ? [v & 127] : Array.from({ length: size(p) }, (_, i) => (v >> (4 * (size(p) - 1 - i))) & 15);
  const decodeAt = (p, data, off) => size(p) === 1 ? data[off] : data.slice(off, off + size(p)).reduce((n, b) => (n << 4) | (b & 15), 0);

  const dt1 = (addrInt, data) => { const a = toAddr(addrInt); midi.send([...hdr, R.commands.DT1, ...a, ...data, sum([...a, ...data]), 0xf7]); };

  // RQ1 → collect the DT1 reply(s) covering [addr, addr+len)
  let inFlight = 0; // our own replies aren't front-panel edits
  function rq1(addrInt, len) {
    inFlight++;
    return new Promise((resolve, reject) => {
      const buf = new Array(len).fill(null), raw = [];
      let got = 0, idle = null;
      const done = () => {
        off(); clearTimeout(idle); clearTimeout(hard);
        setTimeout(() => { inFlight--; }, 0);
        if (!got) reject(new Error("no reply (timeout)"));
        else resolve({ data: buf.map((x) => x ?? 0), raw });
      };
      const off = midi.on((ev) => {
        if (ev.type !== "sysex" || !isDT1(ev.data)) return;
        const d = ev.data, a = toInt([...d.slice(A, A + 4)]), data = d.slice(A + 4, d.length - 2);
        if (a + data.length <= addrInt || a >= addrInt + len) return;
        raw.push(...d);
        data.forEach((b, i) => { const k = a - addrInt + i; if (k >= 0 && k < len && buf[k] == null) { buf[k] = b; got++; } });
        clearTimeout(idle);
        if (got >= len) done(); else idle = setTimeout(done, 300);
      });
      const hard = setTimeout(done, 2000);
      const a = toAddr(addrInt), s = toAddr(len);
      midi.send([...hdr, R.commands.RQ1, ...a, ...s, sum([...a, ...s]), 0xf7]);
    });
  }

  let lastData = {}; // block name → bytes last read, so unmodelled bytes survive a send
  const blockBytes = (b, values) => {
    const data = lastData[b.name] ? [...lastData[b.name]] : new Array(b.size).fill(0);
    for (const p of paramsOf.get(b.name)) if (values[p.key] != null) encode(p, values[p.key]).forEach((x, i) => { data[p.offset + i] = x; });
    return data;
  };
  const valuesFrom = (dataByBlock) => {
    const v = {};
    for (const b of patchBlocks) { const data = dataByBlock[b.name]; if (!data) continue;
      for (const p of paramsOf.get(b.name)) v[p.key] = decodeAt(p, data, p.offset); }
    return v;
  };
  // user memory: the temporary block's first two address bytes (03 00) → (11, n)
  const userAt = (b, prog) => toInt([R.userPatchFirstByte, prog, b.base[2], b.base[3]]);
  const needUser = (bi) => { if (!schema.programs.banks[bi]?.dump) throw new Error(`${schema.programs.banks[bi]?.label ?? "that bank"} is read-only (ROM)`); };

  return {
    sendParam(p, v) {
      const b = blocks.find((x) => x.name === p.block);
      dt1(b.at + p.offset, encode(p, v));
    },
    sendPatch(values) { for (const b of patchBlocks) dt1(b.at, blockBytes(b, values)); },

    async requestPatch() {
      const data = {}, syx = [];
      for (const b of patchBlocks) { const r = await rq1(b.at, b.size); data[b.name] = r.data; syx.push(...r.raw); }
      lastData = data;
      return { values: valuesFrom(data), syx };
    },

    programChange(bi, prog) { selectProgram(midi, getChannel(), schema.programs.banks[bi], prog); },

    async requestProgram(bi, prog) {
      needUser(bi);
      const data = {}, syx = [];
      for (const b of patchBlocks) { const r = await rq1(userAt(b, prog), b.size); data[b.name] = r.data; syx.push(...r.raw); }
      return { values: valuesFrom(data), data, syx };
    },

    writeProgram(bi, prog, values) {
      needUser(bi);
      const sent = {};
      for (const b of patchBlocks) { sent[b.name] = blockBytes(b, values); dt1(userAt(b, prog), sent[b.name]); }
      return sent;
    },

    sameProgram(a, b) {
      return patchBlocks.every((blk) => paramsOf.get(blk.name).every((p) =>
        decodeAt(p, a[blk.name], p.offset) === decodeAt(p, b[blk.name], p.offset)));
    },

    // front-panel edits come back as DT1 when the JV's Tx Exclusive is on
    decode(ev) {
      if (ev.type !== "sysex" || !isDT1(ev.data) || inFlight) return [];
      const d = ev.data, a = toInt([...d.slice(A, A + 4)]), data = d.slice(A + 4, d.length - 2);
      const out = [];
      for (const b of patchBlocks) {
        if (a + data.length <= b.at || a >= b.at + b.size) continue;
        for (const p of paramsOf.get(b.name)) {
          const k = b.at + p.offset - a;
          if (k >= 0 && k + size(p) <= data.length) out.push({ param: p, value: decodeAt(p, data, k) });
        }
      }
      return out;
    },
  };
}
