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

// which schema transports have a driver yet (the rack shows others as "driver coming")
export const TRANSPORTS = ["nrpn", "roland", "yamaha", "ensoniq", "emax"];

// prefs: { get(key), set(key, value) } — per-device settings a driver learns (Yamaha device #)
export function makeDriver(schema, midi, getChannel, prefs) {
  if (schema.transport === "nrpn") return nrpnDriver(schema, midi, getChannel);
  if (schema.transport === "roland") return rolandDriver(schema, midi, getChannel, prefs);
  if (schema.transport === "yamaha") return yamahaDriver(schema, midi, getChannel, prefs);
  if (schema.transport === "ensoniq") return ensoniqDriver(schema, midi, getChannel, prefs);
  if (schema.transport === "emax") return emaxDriver(schema, midi, getChannel, prefs);
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

    // quick "are you there?" for the rack screen
    async probe() {
      const reply = midi.waitSysex(isFrom(sx.cmd.editBufferDump), 900);
      midi.send([...hdr, sx.cmd.requestEditBuffer, 0xf7]);
      await reply; return true;
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

// Roland DT1/RQ1 — JV-1080 (4-byte addresses) and the LA family (D-110:
// 3-byte). Addresses and sizes are 7 bits per byte; a param lives at block
// base + byte offset; checksum = (128 - sum(addr+data) % 128) % 128.
// Value encodings: plain byte · "nibble" (JV multi-byte, high 4 bits first) ·
// bits {shift,width} (several params share a byte) · "d110pcm" (PCM bank bit
// + wave number over 2 bytes). A live mirror of every block keeps shared
// bytes and unmodelled bytes intact whatever gets sent.
function rolandDriver(schema, midi, getChannel, prefs) {
  const R = schema.roland;
  const mfr = R.manufacturerId, model = R.modelId, dev = R.defaultDeviceId ?? 16;
  const AB = R.addressBytes ?? 4, SB = R.sizeBytes ?? AB;
  const hdr = [0xf0, ...mfr, dev, ...model];
  const A = hdr.length + 1; // index of the first address byte in a message
  const toInt = (a) => a.reduce((n, b) => n * 128 + b, 0);
  const toBytes = (n, count) => Array.from({ length: count }, (_, i) => (n >> (7 * (count - 1 - i))) & 127);
  const sum = (bytes) => (128 - (bytes.reduce((t, b) => t + b, 0) % 128)) % 128;
  const isDT1 = (d) => d[0] === 0xf0 && hdr.every((b, i) => d[i] === b) && d[hdr.length] === R.commands.DT1;
  const bank = (bi) => schema.programs.banks[bi];

  const blocks = Object.entries(R.blocks).map(([name, b]) => ({ name, ...b, at: toInt(b.base) }));
  const blockOf = new Map(blocks.map((b) => [b.name, b]));
  const paramsOf = new Map(blocks.map((b) => [b.name, schema.params.filter((p) => p.block === b.name)]));
  const patchBlocks = blocks.filter((b) => paramsOf.get(b.name).some((p) => !p.notInPatch));
  const contextBlocks = blocks.filter((b) => !patchBlocks.includes(b));

  const width = (p) => (p.encoding === "d110pcm" || p.encoding === "nibbleLE" ? 2 : p.size || 1);
  const twos = (p, raw) => { const bits = 4 * (p.size || 1); return raw >= 1 << (bits - 1) ? raw - (1 << bits) : raw; };
  function read(p, data, off = p.offset) {
    if (p.encoding === "twos") return twos(p, data.slice(off, off + (p.size || 1)).reduce((n, b) => (n << 4) | (b & 15), 0));
    if (p.encoding === "nibbleLE") return (data[off] & 15) | ((data[off + 1] & 15) << 4); // U-110: low nibble first
    if (p.encoding === "d110pcm") return ((data[off] >> 1) & 1) * 128 + data[off + 1];
    if (p.bits) return (data[off] >> p.bits.shift) & ((1 << p.bits.width) - 1);
    if ((p.size || 1) > 1) return data.slice(off, off + p.size).reduce((n, b) => (n << 4) | (b & 15), 0);
    return data[off];
  }
  function write(p, v, data) {
    const o = p.offset;
    if (p.encoding === "twos") { const n = p.size || 1, w = v & ((1 << (4 * n)) - 1); for (let i = 0; i < n; i++) data[o + i] = (w >> (4 * (n - 1 - i))) & 15; return; }
    if (p.encoding === "nibbleLE") { data[o] = v & 15; data[o + 1] = (v >> 4) & 15; return; }
    if (p.encoding === "d110pcm") { data[o] = (data[o] & 1) | (((v >> 7) & 1) << 1); data[o + 1] = v & 127; return; }
    if (p.bits) { const m = ((1 << p.bits.width) - 1) << p.bits.shift; data[o] = (data[o] & ~m) | ((v << p.bits.shift) & m); return; }
    if ((p.size || 1) > 1) { for (let i = 0; i < p.size; i++) data[o + i] = (v >> (4 * (p.size - 1 - i))) & 15; return; }
    data[o] = v & 127;
  }

  const dt1 = (addrInt, data) => {
    const max = R.maxDT1 || 256; // U-110 takes 128-byte packets
    for (let k = 0; k < data.length; k += max) {
      const a = toBytes(addrInt + k, AB), chunk = data.slice(k, k + max);
      midi.send([...hdr, R.commands.DT1, ...a, ...chunk, sum([...a, ...chunk]), 0xf7]);
    }
  };

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
        const d = ev.data, a = toInt([...d.slice(A, A + AB)]), data = d.slice(A + AB, d.length - 2);
        if (a + data.length <= addrInt || a >= addrInt + len) return;
        raw.push(...d);
        data.forEach((b, i) => { const k = a - addrInt + i; if (k >= 0 && k < len && buf[k] == null) { buf[k] = b; got++; } });
        clearTimeout(idle);
        if (got >= len) done(); else idle = setTimeout(done, len > 2048 ? 800 : 300);
      });
      const hard = setTimeout(done, 2500 + len * 0.45); // a whole bank takes seconds at 31.25 kbaud
      const a = toBytes(addrInt, AB), s = toBytes(len, SB);
      midi.send([...hdr, R.commands.RQ1, ...a, ...s, sum([...a, ...s]), 0xf7]);
    });
  }

  let bankCache = null;
  queueMicrotask(() => { try { const sl = JSON.parse(prefs?.get("slot") || "null"); if (sl) moveTo(sl.bi, sl.prog); } catch {} });
  // S-330: no edit buffer. A bank with select.type "slot" moves its block to the
  // chosen memory slot (nothing is sent); edits then land on that tone directly.
  const moveTo = (bi, prog) => {
    const bk = bank(bi), sel = bk?.select, mem = R.userMemory?.[bk?.memory];
    if (sel?.type !== "slot" || !mem) return false;
    const b = blockOf.get(sel.block);
    b.at = toInt(mem.base) + prog * mem.stride;
    delete mirror[b.name]; readOnce.delete(b.name);
    prefs?.set("slot", JSON.stringify({ bi, prog }));
    return true;
  };
  const readOnce = new Set(); // blocks read from the unit this session (see requireReadBeforeWrite)
  const mirror = {}; // block name → current bytes on the synth, as best we know
  const bytesOf = (b) => (mirror[b.name] ??= new Array(b.size).fill(0));
  const withValues = (b, values) => {
    const data = [...bytesOf(b)];
    for (const p of paramsOf.get(b.name)) if (values[p.key] != null) write(p, values[p.key], data);
    return data;
  };
  const valuesFrom = (b, data, into = {}) => { for (const p of paramsOf.get(b.name)) into[p.key] = read(p, data); return into; };

  // stored memory: JV = the temp block's first two address bytes → (11, n);
  // LA = base + n × stride, one block per slot
  const memOf = (bi) => R.userMemory?.[bank(bi).memory];
  function slotBlocks(bi, prog) {
    const mem = memOf(bi);
    if (mem) return [{ b: patchBlocks.find((x) => x.size === mem.size) || null, at: toInt(mem.base) + prog * mem.stride, size: mem.size }];
    return patchBlocks.map((b) => ({ b, at: toInt([R.userPatchFirstByte, prog, ...b.base.slice(2)]), size: b.size }));
  }
  const needDump = (bi) => { if (!bank(bi)?.dump) throw new Error(`${bank(bi)?.label ?? "that bank"} can't be read over MIDI`); };
  const nameFrom = (data) => String.fromCharCode(...data.slice(0, 10).map((c) => (c >= 32 && c < 127 ? c : 32))).trim();

  // a param the unit needs kept equal to others (S-330 loopLength = end - loop)
  const DL = R.derivedLoop, byKeyR = new Map(schema.params.map((p) => [p.key, p]));
  function fixDerived(b, data) {
    if (!DL) return null;
    const L = byKeyR.get(DL.length), E = byKeyR.get(DL.end), P = byKeyR.get(DL.loop);
    if (!L || L.block !== b.name) return null;
    write(L, Math.max(0, read(E, data) - read(P, data)), data);
    return L;
  }

  // packages: several params the synth only accepts together (D-110 partial reserve)
  const pkgFor = (p) => Object.values(R.packages || {}).find((k) => k.block === p.block && p.offset >= k.offset && p.offset < k.offset + k.size);

  return {
    sendParam(p, v) {
      const b = blockOf.get(p.block), data = bytesOf(b);
      write(p, v, data);
      if (DL && (p.key === DL.end || p.key === DL.loop)) {
        const L = fixDerived(b, data);
        if (L) { dt1(b.at + p.offset, data.slice(p.offset, p.offset + width(p))); return dt1(b.at + L.offset, data.slice(L.offset, L.offset + width(L))); }
      }
      if (p.live) return dt1(toInt(p.live), [v & 127]);
      if (p.display === "ascii" && R.liveName) {
        const first = Math.min(...paramsOf.get(b.name).filter((q) => q.display === "ascii").map((q) => q.offset));
        return dt1(toInt(R.liveName.address), data.slice(first, first + R.liveName.size));
      }
      const pk = pkgFor(p);
      const [o, n] = pk ? [pk.offset, pk.size] : [p.offset, width(p)];
      dt1(b.at + o, data.slice(o, o + n));
    },
    sendPatch(values) {
      for (const b of patchBlocks) {
        // never write a whole block we haven't read — the S-330's tones hold wave pointers
        if (R.requireReadBeforeWrite && !readOnce.has(b.name)) throw new Error("read the tone from the unit first (get)");
        mirror[b.name] = withValues(b, values); fixDerived(b, mirror[b.name]); dt1(b.at, mirror[b.name]);
      }
    },

    async requestPatch() {
      const values = {}, syx = [];
      for (const b of patchBlocks) { const r = await rq1(b.at, b.size); mirror[b.name] = r.data; readOnce.add(b.name); valuesFrom(b, r.data, values); syx.push(...r.raw); }
      // context (part setup, system): shown and editable, never sent as part of a patch
      for (const b of contextBlocks) { try { const r = await rq1(b.at, b.size); mirror[b.name] = r.data; valuesFrom(b, r.data, values); } catch {} }
      return { values, syx };
    },

    async probe() { await this.requestName(); return true; },

    // just the name bytes of a stored slot (JV user patch, D-110 tone) — quick name lists
    async requestSlotName(bi, prog) {
      needDump(bi);
      const s = slotBlocks(bi, prog)[0];
      const ps = s.b ? paramsOf.get(s.b.name).filter((p) => p.display === "ascii") : [];
      if (!ps.length) return (await this.requestProgram(bi, prog)).name || "";
      const r = await rq1(s.at, Math.max(...ps.map((p) => p.offset + width(p))));
      return ps.map((p) => String.fromCharCode(read(p, r.data) || 32)).join("").trim();
    },

    // just the name bytes of the edit buffer — quick, for scanning ROM banks by selecting each slot
    async requestName() {
      const b = patchBlocks[0];
      const ps = paramsOf.get(b.name).filter((p) => p.display === "ascii");
      if (!ps.length) return "";
      const r = await rq1(b.at, Math.max(...ps.map((p) => p.offset + width(p))));
      return ps.map((p) => String.fromCharCode(read(p, r.data) || 32)).join("").trim();
    },

    programChange(bi, prog) {
      if (moveTo(bi, prog)) return; // S-330: just retarget, nothing sent
      const sel = bank(bi).select;
      if (sel?.type === "dt1") dt1(toInt(sel.address), sel.data.map((x) => (x === "prog" ? prog : x)));
      else selectProgram(midi, getChannel(), bank(bi), prog + (sel?.offset || 0));
    },

    // whole bank in one request (bank.bankDump) — sliced into slots; cached for
    // a few seconds so store's read-first + read-back don't each take 6 s
    async requestBank(bi) {
      const bk = bank(bi), bd = bk.bankDump;
      if (!bd) throw new Error(`${bk.label} has no bank dump`);
      if (bankCache?.bi === bi && Date.now() - bankCache.at < 5000) return bankCache.slots;
      const r = await rq1(toInt(bd.address), toInt(bd.size));
      const blk = patchBlocks[0], slots = [];
      for (let n = 0; n < bk.count; n++) {
        const data = r.data.slice(n * bd.slotBytes, (n + 1) * bd.slotBytes), values = valuesFrom(blk, data, {});
        const name = paramsOf.get(blk.name).filter((p) => p.display === "ascii").map((p) => String.fromCharCode(read(p, data) || 32)).join("").trim();
        slots.push({ values, data: { [blk.name]: data }, name, syx: [] });
      }
      if (slots[0]) slots[0].syx = r.raw; // the raw dump rides on slot 0 for backups
      bankCache = { bi, at: Date.now(), slots };
      return slots;
    },
    forgetBank() { bankCache = null; },

    async requestProgram(bi, prog) {
      if (!bank(bi)?.dump && bank(bi)?.bankDump) { const s = (await this.requestBank(bi))[prog]; return { ...s }; }
      needDump(bi);
      const data = {}, syx = [], values = {};
      let name = "";
      for (const s of slotBlocks(bi, prog)) {
        const r = await rq1(s.at, s.size);
        syx.push(...r.raw);
        if (s.b) { data[s.b.name] = r.data; valuesFrom(s.b, r.data, values); }
        else name ||= nameFrom(r.data); // patches/timbres: raw, backup only
      }
      return { values, data, syx, name: name || undefined };
    },

    writeProgram(bi, prog, values) {
      if (!bank(bi)?.write) throw new Error(`${bank(bi)?.label ?? "that bank"} is read-only`);
      const sent = {};
      for (const s of slotBlocks(bi, prog)) {
        if (!s.b) continue;
        if (R.requireReadBeforeWrite && !readOnce.has(s.b.name)) throw new Error("read the tone from the unit first (get)");
        sent[s.b.name] = withValues(s.b, values); fixDerived(s.b, sent[s.b.name]); dt1(s.at, sent[s.b.name]);
      }
      return sent;
    },

    sameProgram(a, b) {
      return patchBlocks.filter((blk) => a[blk.name] && b[blk.name]).every((blk) =>
        paramsOf.get(blk.name).every((p) => read(p, a[blk.name]) === read(p, b[blk.name])));
    },

    // front-panel edits (JV with Tx Exclusive on); the D-110 doesn't send these
    decode(ev) {
      if (ev.type !== "sysex" || !isDT1(ev.data) || inFlight) return [];
      const d = ev.data, a = toInt([...d.slice(A, A + AB)]), data = d.slice(A + AB, d.length - 2);
      const out = [];
      for (const b of blocks) {
        if (a + data.length <= b.at || a >= b.at + b.size) continue;
        const m = bytesOf(b);
        data.forEach((x, i) => { const k = a - b.at + i; if (k >= 0 && k < b.size) m[k] = x; });
        for (const p of paramsOf.get(b.name)) {
          const k = b.at + p.offset - a;
          if (k >= 0 && k + width(p) <= data.length) out.push({ param: p, value: read(p, m) });
        }
      }
      return out;
    },
  };
}

// Yamaha SY/TG55 (AWM2). Param change F0 43 1n 35 G S H P V1 V2 F7; voice
// dumps F0 43 0n 7A bc bc 'LM  8103VC' +14×00 memType memNum data sum F7,
// data = 37 common bytes + 9×N element bytes + 112×N element blocks for
// N = 1/2/4 elements. Params index a canonical 4-element image (dumpOffset),
// so a 1- or 2-element voice keeps the other elements' bytes in the mirror.
function yamahaDriver(schema, midi, getChannel, prefs) {
  const Y = schema.yamaha;
  let n = Number(prefs?.get("dev") ?? (Y.defaultDeviceNumber ?? 1) - 1);
  const ascii = (str) => [...str].map((c) => c.charCodeAt(0));
  const ELEMENTS = { 5: 1, 6: 2, 7: 4 };
  const IMG = 37 + 9 * 4 + 112 * 4; // 521
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bank = (bi) => schema.programs.banks[bi];

  const request = (type, memType, memNum, dev = n) =>
    midi.send([0xf0, 0x43, 0x20 | dev, 0x7a, ...ascii("LM  8103" + type), ...new Array(14).fill(0), memType, memNum, 0xf7]);
  // a dump of `type`, checksum-verified; replies are labelled 7F/00 so match on type only
  const parse = (d) => { // F0 43 0n 7A bcHi bcLo <bc bytes from 'L'> sum F7
    if (d[0] !== 0xf0 || d[1] !== 0x43 || d[2] >> 4 !== 0 || d[3] !== 0x7a) return null;
    const bc = (d[4] << 7) | d[5], body = [...d.slice(6, 6 + bc)];
    if (body.length !== bc || (body.reduce((t, x) => t + x, 0) + d[6 + bc]) % 128) return null;
    return { dev: d[2] & 15, type: String.fromCharCode(body[8], body[9]), memType: body[24], memNum: body[25], data: body.slice(26), raw: [...d] };
  };
  async function fetchDump(type, memType, memNum, timeout = 1500) {
    const reply = midi.waitSysex((d) => parse(d)?.type === type, timeout);
    request(type, memType, memNum);
    const dump = parse(await reply);
    await sleep(120); // Yamaha: > 100 ms between dumps either way
    return dump;
  }
  // no reply on our device #? sweep 1–16 once and keep the one that answers
  async function fetchDumpFindingDevice(type, memType, memNum) {
    try { return await fetchDump(type, memType, memNum); } catch (e) {
      for (let d = 0; d < 16; d++) {
        if (d === n) continue;
        const reply = midi.waitSysex((x) => parse(x)?.type === type, 400);
        request(type, memType, memNum, d);
        try { const dump = parse(await reply); n = dump.dev; prefs?.set("dev", n); await sleep(120); return dump; } catch {}
      }
      throw new Error("no reply on any device number — check Device# isn't off and Bulk/voice mode");
    }
  }

  // dump data ⇄ canonical 4-element image
  const toImage = (data, base) => {
    const N = ELEMENTS[data[0]]; if (!N) return null; // drum set (mode 10): not a voice
    const img = base ? [...base] : new Array(IMG).fill(0);
    for (let i = 0; i < 37; i++) img[i] = data[i];
    for (let e = 0; e < N; e++) {
      for (let i = 0; i < 9; i++) img[37 + 9 * e + i] = data[37 + 9 * e + i];
      for (let i = 0; i < 112; i++) img[73 + 112 * e + i] = data[37 + 9 * N + 112 * e + i];
    }
    return img;
  };
  const toData = (img) => {
    const N = ELEMENTS[img[0]] || 4, out = img.slice(0, 37);
    for (let e = 0; e < N; e++) out.push(...img.slice(37 + 9 * e, 46 + 9 * e));
    for (let e = 0; e < N; e++) out.push(...img.slice(73 + 112 * e, 185 + 112 * e));
    return out;
  };
  const dumpMsg = (img, memType, memNum) => {
    const body = [...ascii("LM  8103VC"), ...new Array(14).fill(0), memType, memNum, ...toData(img)];
    const sum = (128 - (body.reduce((t, x) => t + x, 0) % 128)) % 128;
    return [0xf0, 0x43, n, 0x7a, (body.length >> 7) & 127, body.length & 127, ...body, sum, 0xf7];
  };

  const signBit = (p) => 1 << p.signBit;
  const toWire = (p, v) => p.encoding === "signMag" ? (v < 0 ? signBit(p) | -v : v) : v;
  const fromWire = (p, w) => p.encoding === "signMag" ? (w & signBit(p) ? -(w & (signBit(p) - 1)) : w) : w;
  const inImage = (p) => p.dumpOffset != null;
  const read = (p, img) => fromWire(p, (p.size || 1) > 1 ? (img[p.dumpOffset] << 7) | img[p.dumpOffset + 1] : img[p.dumpOffset]);
  const write = (p, v, img) => {
    const w = toWire(p, v);
    if ((p.size || 1) > 1) { img[p.dumpOffset] = (w >> 7) & 127; img[p.dumpOffset + 1] = w & 127; } else img[p.dumpOffset] = w & 127;
  };
  const valuesOf = (img) => Object.fromEntries(schema.params.filter(inImage).map((p) => [p.key, read(p, img)]));
  const imageWith = (values) => { const img = [...mirror]; for (const p of schema.params) if (inImage(p) && values[p.key] != null) write(p, values[p.key], img); return img; };

  let mirror = new Array(IMG).fill(0);
  let enable = 0x0f; // element enable bits: sendable, not readable
  const nameOf = (data) => String.fromCharCode(...data.slice(1, 11).map((c) => (c >= 32 && c < 127 ? c : 32))).trim();

  return {
    sendParam(p, v) {
      let wire;
      if (p.bits) { enable = (enable & ~(1 << p.bits.shift)) | ((v & 1) << p.bits.shift); wire = enable; }
      else { if (inImage(p)) write(p, v, mirror); wire = toWire(p, v); }
      const sub = p.element == null ? p.pcSub : p.pcSub | (p.element << 4);
      midi.send([0xf0, 0x43, 0x10 | n, 0x35, p.pcGroup, sub, p.pcHigh || 0, p.pcParam, (wire >> 7) & 127, wire & 127, 0xf7]);
    },
    sendPatch(values) { mirror = imageWith(values); midi.send(dumpMsg(mirror, 0x7f, 0)); },

    async probe() { await fetchDump("VC", 0x7f, 0, 900); return true; },

    async requestPatch() {
      const dump = await fetchDumpFindingDevice("VC", 0x7f, 0);
      const img = toImage(dump.data, mirror);
      if (!img) throw new Error("the edit buffer holds a drum set — pick a voice");
      mirror = img;
      const values = valuesOf(img);
      for (const p of schema.params) if (p.bits) values[p.key] = (enable >> p.bits.shift) & 1;
      return { values, syx: dump.raw };
    },

    // program change only. The TG55's edit buffer does NOT follow program changes
    // (it keeps the last voice edited or dumped in), so after selecting a program
    // the editor reads the voice from its memory slot instead — see adoptSlot.
    programChange(bi, prog) {
      const sel = bank(bi).select, ch = getChannel();
      midi.send([0xc0 | ch, sel.prefix & 127]);
      midi.send([0xc0 | ch, (prog + (sel.offset || 0)) & 127]);
    },

    // the voice now playing, read from its slot (read-only — no "Bulk received");
    // it becomes the mirror, so knob edits land on the voice that's sounding
    async adoptSlot(bi, prog) {
      const b = bank(bi);
      if (!b.dump || b.sysex?.type !== "VC" || b.drumSlots?.includes(prog)) return null;
      const dump = await fetchDumpFindingDevice("VC", b.sysex.memoryType, prog);
      const img = toImage(dump.data, mirror);
      if (!img) return null;
      mirror = img;
      const values = valuesOf(img);
      for (const p of schema.params) if (p.bits) values[p.key] = (enable >> p.bits.shift) & 1;
      return { values };
    },

    async requestProgram(bi, prog) {
      const b = bank(bi);
      if (!b.dump) throw new Error(`${b.label} can't be read over MIDI`);
      const dump = await fetchDumpFindingDevice(b.sysex.type, b.sysex.memoryType, prog);
      const name = b.sysex.type === "VC" ? nameOf(dump.data) : String.fromCharCode(...dump.data.slice(0, 10).map((c) => (c >= 32 && c < 127 ? c : 32))).trim();
      const img = b.sysex.type === "VC" ? toImage(dump.data) : null; // drum sets + multis: raw only
      return { values: img ? valuesOf(img) : {}, data: img, syx: dump.raw, name: name || undefined };
    },

    writeProgram(bi, prog, values) {
      const b = bank(bi);
      if (!b.write || b.sysex.type !== "VC" || b.drumSlots?.includes(prog)) throw new Error(`can't store a voice in ${b.label} ${prog + 1}`);
      const img = imageWith(values);
      midi.send(dumpMsg(img, b.sysex.memoryType, prog));
      return img;
    },

    // common + the elements the voice actually uses
    sameProgram(a, b) {
      if (!a || !b) return false;
      const N = ELEMENTS[a[0]] || 4;
      return schema.params.filter((p) => inImage(p) && (p.element == null || p.element < N)).every((p) => read(p, a) === read(p, b));
    },

    decode() { return []; }, // the TG55 doesn't transmit front-panel edits
  };
}

// Ensoniq ESQ-1. F0 0F 02 0n <type> … F7, n = the unit's base channel; a program
// is 102 bytes sent as nybbles, low first; no checksums, no addresses. The unit
// takes a program dump only on a Program Select page and then sits on WRITE
// PROGRAM, so sending means: press INTERNAL, dump, press EXIT (virtual keypad,
// type 0E). Live edits: page button, then CC98/CC99 select + CC6 data — only
// while that parameter's page is on screen. It crashes under dense MIDI, so
// everything is paced (gapMs 30) and whole patches are never sent as NRPNs.
function ensoniqDriver(schema, midi, getChannel, prefs) {
  const E = schema.ensoniq, T = E.messageTypes, K = E.keypad.downCodes, UP = E.keypad.upOffset;
  const hdr = () => [0xf0, 0x0f, 0x02, getChannel() & 15];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bank = (bi) => schema.programs.banks[bi];
  const N = E.programBytes; // 102
  const pack = (bytes) => bytes.flatMap((b) => [b & 15, (b >> 4) & 15]);
  const unpack = (d, from) => { const out = []; for (let i = from; i + 1 < d.length - 1; i += 2) out.push((d[i] & 15) | ((d[i + 1] & 15) << 4)); return out; };
  const isType = (t) => (d) => d[0] === 0xf0 && d[1] === 0x0f && d[2] === 0x02 && d[4] === t;
  const keypad = (...codes) => midi.send([...hdr(), T.virtualKeypad, ...codes.flatMap((c) => [c, c + UP]), 0xf7]);

  const mask = (w) => (1 << w) - 1;
  function read(p, img) {
    const o = p.offset;
    if (p.encoding === "fields") return p.fields.reduce((v, f) => v | (((img[f.offset] >> f.shift) & mask(f.width)) << f.at), 0);
    if (p.encoding === "splitMode") { const S = (img[98] >> 7) & 1, D = (img[96] >> 7) & 1; return S ? (D ? 2 : 1) : 0; }
    if (p.encoding === "pitchOct") return Math.floor((img[o] & 0x7f) / 12) - 3;
    if (p.encoding === "pitchSemi") return (img[o] & 0x7f) % 12;
    if (!p.bits) return img[o];
    const raw = (img[o] >> p.bits.shift) & mask(p.bits.width);
    return p.encoding === "signed" && raw >= 1 << (p.bits.width - 1) ? raw - (1 << p.bits.width) : raw;
  }
  function write(p, v, img) {
    const o = p.offset;
    if (p.encoding === "fields") { for (const f of p.fields) img[f.offset] = (img[f.offset] & ~(mask(f.width) << f.shift)) | (((v >> f.at) & mask(f.width)) << f.shift); return; }
    if (p.encoding === "splitMode") { img[98] = (img[98] & 0x7f) | (v > 0 ? 0x80 : 0); if (v > 0) img[96] = (img[96] & 0x7f) | (v === 2 ? 0x80 : 0); return; }
    if (p.encoding === "pitchOct" || p.encoding === "pitchSemi") {
      const pitch = img[o] & 0x7f, oct = Math.floor(pitch / 12) - 3, semi = pitch % 12;
      const next = p.encoding === "pitchOct" ? (v + 3) * 12 + semi : (oct + 3) * 12 + v;
      img[o] = (img[o] & 0x80) | Math.max(0, Math.min(96, next)); return;
    }
    if (!p.bits) { img[o] = v & 255; return; }
    const m = mask(p.bits.width) << p.bits.shift;
    img[o] = (img[o] & ~m) | (((v & mask(p.bits.width)) << p.bits.shift) & m);
  }
  const valuesOf = (img) => Object.fromEntries(schema.params.map((p) => [p.key, read(p, img)]));
  const nameOf = (img) => String.fromCharCode(...img.slice(0, 6).map((c) => (c >= 32 && c < 127 ? c : 32))).trim();
  let mirror = new Array(N).fill(0), haveMirror = false;
  const withValues = (values, base = mirror) => { const img = [...base]; for (const p of schema.params) if (values[p.key] != null) write(p, values[p.key], img); return img; };

  async function fetchEdit(timeout = 1000) {
    const reply = midi.waitSysex(isType(T.singleProgramDump), timeout);
    midi.send([...hdr(), T.currentProgramDumpRequest, 0xf7]);
    const d = await reply;
    return { img: unpack(d, 5).slice(0, N), raw: [...d] };
  }
  // all 40 internal programs (~2.6 s on the wire); cached briefly so a name scan or
  // store's read-first/read-back is one request, and kept for the bank write
  let bankCache = null, lastBank = null;
  async function fetchBank() {
    if (bankCache && Date.now() - bankCache.at < 5000) return bankCache;
    const reply = midi.waitSysex(isType(T.allProgramDump), 6000);
    midi.send([...hdr(), T.allProgramDumpRequest, 0xf7]);
    const d = await reply, all = unpack(d, 5);
    bankCache = { at: Date.now(), raw: [...d], slots: Array.from({ length: 40 }, (_, i) => all.slice(i * N, (i + 1) * N)) };
    lastBank = bankCache;
    await sleep(300);
    return bankCache;
  }

  // send the mirror into the edit buffer: INTERNAL (program-select page) → dump → EXIT
  let sending = null;
  async function pushEdit(img) {
    keypad(K.INTERNAL); await sleep(150);
    midi.send([...hdr(), T.singleProgramDump, ...pack(img), 0xf7]); await sleep(250);
    keypad(K["SOFTKEY 5"]); await sleep(300);
    page = null;
  }
  // at most one whole-program send per ~400 ms, trailing edge
  let dumpTimer = null;
  const queueDump = () => { clearTimeout(dumpTimer); dumpTimer = setTimeout(() => { sending = pushEdit([...mirror]); }, 400); };

  let page = null, lastNrpn = null;
  const liveMode = () => prefs?.get("live") || "nrpn";

  return {
    async probe() { await fetchEdit(900); return true; },

    async requestPatch() {
      const { img, raw } = await fetchEdit();
      mirror = img; haveMirror = true;
      return { values: valuesOf(img), syx: raw };
    },

    sendPatch(values) {
      if (!haveMirror) throw new Error("read the program from the ESQ-1 first (get)");
      mirror = withValues(values); clearTimeout(dumpTimer); sending = pushEdit([...mirror]);
    },

    async sendParam(p, v) {
      write(p, v, mirror);
      if (p.liveEdit !== "nrpn" || p.nrpn == null || liveMode() !== "nrpn") return haveMirror && queueDump();
      if (p.page && page !== p.page) { keypad(p.page); page = p.page; lastNrpn = null; await sleep(60); }
      const ch = getChannel();
      if (lastNrpn !== p.nrpn) { midi.cc(ch, 98, p.nrpn & 127); midi.cc(ch, 99, p.nrpn >> 7); lastNrpn = p.nrpn; }
      const n = p.max - p.min + 1, i = v - p.min;
      midi.cc(ch, 6, Math.max(0, Math.min(127, Math.round(((i + 0.5) * 128) / n - 0.5))));
    },

    programChange(bi, prog) { midi.send([0xc0 | getChannel(), (prog + (bank(bi).select?.offset || 0)) & 127]); page = null; },

    async requestProgram(bi, prog) {
      if (!bank(bi)?.dump) throw new Error(`${bank(bi)?.label ?? "that bank"} can't be read over MIDI`);
      const b = await fetchBank(), img = b.slots[prog];
      // the raw all-program dump rides on slot 0 so a backup is one restorable message
      return { values: valuesOf(img), data: img, syx: prog === 0 ? b.raw : [], name: nameOf(img) || undefined };
    },
    async requestSlotName(bi, prog) { return nameOf((await fetchBank()).slots[prog]); },
    forgetBank() { bankCache = null; },

    // safest store (manual-documented, no keypad chords): read-modify-write the whole bank
    async writeProgram(bi, prog, values) {
      if (!bank(bi)?.write) throw new Error(`${bank(bi)?.label ?? "that bank"} is read-only`);
      if (!haveMirror) throw new Error("read the program from the ESQ-1 first (get)");
      const b = lastBank || (await fetchBank());
      const slots = b.slots.map((x) => [...x]);
      slots[prog] = withValues(values);
      keypad(K.INTERNAL); await sleep(150);
      midi.send([...hdr(), T.allProgramDump, ...pack(slots.flat()), 0xf7]);
      await sleep(midi.drainMs() + 3000);
      bankCache = null; page = null;
      return slots[prog];
    },

    sameProgram(a, b) { return !!a && !!b && schema.params.every((p) => read(p, a) === read(p, b)); },

    // front-panel moves: CC98/99 select + CC6 data; an unsolicited program dump
    decode(ev) {
      if (ev.type === "sysex" && isType(T.singleProgramDump)(ev.data)) {
        mirror = unpack(ev.data, 5).slice(0, N); haveMirror = true;
        return schema.params.map((p) => ({ param: p, value: read(p, mirror) }));
      }
      if (ev.type !== "nrpn" || ev.ch !== getChannel()) return [];
      const p = schema.params.find((q) => q.nrpn === ev.param); if (!p) return [];
      const n = p.max - p.min + 1, v = p.min + Math.min(n - 1, Math.floor(((ev.value >> 7) * n) / 128));
      write(p, v, mirror);
      return [{ param: p, value: v }];
    },
  };
}

// E-mu Emax I (Rev 3). F0 18 02 <cmd> … F7 — no channel, no device ID, no bulk
// dump: every parameter is read and written one at a time, one message in
// flight, and each change is answered with READY (F0 18 02 38 F7). No edit
// buffer: the current preset is edited in RAM (save to disk on the panel).
// Voices are addressed by KEY: the edit target is editLo..editHi (local params).
// Voice assignments (key ranges) are read-only here — the Emax doesn't
// range-check them and a bad write clobbers neighbouring voices.
function emaxDriver(schema, midi, getChannel, prefs) {
  const H = [0xf0, 0x18, 0x02];
  const P = (m) => schema.params.filter((p) => p.msg === m);
  const bank = (bi) => schema.programs.banks[bi];
  const byKey = new Map(schema.params.map((p) => [p.key, p]));
  let edit = { lo: Number(prefs?.get("editLo") ?? byKey.get("editLo")?.default ?? 39), hi: Number(prefs?.get("editHi") ?? byKey.get("editHi")?.default ?? 39) };
  let q = Promise.resolve(), first = true;
  const serial = (fn) => (q = q.then(fn, fn));
  const isCmd = (cmd, pred) => (d) => d[0] === 0xf0 && d[1] === 0x18 && d[2] === 0x02 && d[3] === cmd && (!pred || pred(d));
  const ask = (bytes, cmd, pred, t = 300) => serial(async () => {
    const r = midi.waitSysex(isCmd(cmd, pred), first ? 1000 : t); first = false;
    midi.send([...H, ...bytes, 0xf7]); return [...(await r)];
  });
  const change = (bytes, t = 500) => serial(async () => {
    const r = midi.waitSysex(isCmd(0x38), t).catch(() => null);
    midi.send([...H, ...bytes, 0xf7]); await r;
  });
  const b3 = (a, i) => a[i] | (a[i + 1] << 7) | (a[i + 2] << 14);
  const to3 = (v) => [v & 127, (v >> 7) & 127, (v >> 14) & 31];
  // #33 reply body after key, level: rate(1) length(3) susStart(3) susEnd(3) relStart(3) relEnd(3) flags(1)
  const SF = { rate: [0, 1], length: [1, 3], susStart: [4, 3], susEnd: [7, 3], relStart: [10, 3], relEnd: [13, 3], flags: [16, 1] };
  const bitOf = (p, raw) => (p.bit != null ? (raw >> p.bit) & 1 : p.bits ? (raw >> p.bits.shift) & ((1 << p.bits.width) - 1) : raw);
  const setBit = (p, raw, v) => {
    if (p.bit != null) return (raw & ~(1 << p.bit)) | ((v & 1) << p.bit);
    if (p.bits) { const m = ((1 << p.bits.width) - 1) << p.bits.shift; return (raw & ~m) | ((v << p.bits.shift) & m); }
    return v;
  };

  const m = { misc: null, maps: [null, null], sample: [null, null], xfade: null, preset: {}, voice: [{}, {}] };
  let current = 0, haveRead = false, last = {};

  const presetNums = (p) => (p.parts ? p.parts.map((x) => x.num) : [p.num]);
  const presetValue = (p, byNum) => p.parts ? p.parts.reduce((v, x) => v | ((byNum[x.num] ?? 0) << x.at), 0) : byNum[p.num];
  async function readPresetParams(pp) {
    const byNum = {};
    const nums = [...new Set(P("preset").flatMap(presetNums))];
    for (const n of nums) byNum[n] = (await ask([0x01, pp, n], 0x31, (d) => d[5] === n))[6];
    return byNum;
  }
  const valuesFromPreset = (byNum, into = {}) => { for (const p of P("preset")) into[p.key] = presetValue(p, byNum); return into; };

  async function readAll() {
    const values = {};
    const mi = await ask([0x02], 0x32); m.misc = mi.slice(4, mi.length - 1); current = m.misc[0];
    for (const p of P("misc")) values[p.key] = p.field === "tune" ? m.misc[1] : bitOf(p, m.misc[2]);
    for (const L of [0, 1]) { const d = await ask([0x05 + L], 0x35 + L); m.maps[L] = d.slice(4, 4 + 88); }
    values.editLo = edit.lo; values.editHi = edit.hi;
    for (const L of [0, 1]) {
      const vn = m.maps[L][edit.lo];
      const mp = P("map").find((p) => p.level === L); if (mp) values[mp.key] = vn;
      // the run of keys around the edit key that play the same voice
      let lo = edit.lo, hi = edit.lo;
      while (lo > 0 && m.maps[L][lo - 1] === vn) lo--; while (hi < 87 && m.maps[L][hi + 1] === vn) hi++;
      for (const p of P("assign").filter((p) => p.level === L)) values[p.key] = /Lo/.test(p.key) ? lo : hi;
      if (vn === 0x7f) { m.sample[L] = null; continue; } // no voice on this layer
      for (const p of P("voice").filter((p) => p.level === L)) {
        const v = (await ask([0x00, edit.lo, L, p.num], 0x30, (d) => d[4] === edit.lo && d[5] === L && d[6] === p.num))[7];
        m.voice[L][p.num] = v; values[p.key] = v;
      }
      const sd = await ask([0x03, edit.lo, L], 0x33, (d) => d[4] === edit.lo && d[5] === L);
      m.sample[L] = sd.slice(6, sd.length - 1);
      for (const p of P("sample").filter((p) => p.level === L)) {
        const [o, n] = SF[p.field]; const raw = n === 3 ? b3(m.sample[L], o) : m.sample[L][o];
        values[p.key] = p.field === "flags" ? bitOf(p, raw) : raw;
      }
    }
    const xf = await ask([0x04, edit.lo], 0x34, (d) => d[4] === edit.lo);
    m.xfade = xf.slice(5, xf.length - 1);
    for (const p of P("xfade")) values[p.key] = p.field === "mode" ? m.xfade[0] & 7 : p.field === "dir" ? (m.xfade[0] >> 3) & 1 : p.field === "posStart" ? m.xfade[1] : m.xfade[2];
    m.preset = await readPresetParams(0x7f);
    valuesFromPreset(m.preset, values);
    haveRead = true; last = { ...values };
    return values;
  }

  async function send(p, v) {
    if (p.readOnly || p.msg === "map" || p.msg === "assign") return;
    if (p.msg === "local") { edit[p.key === "editLo" ? "lo" : "hi"] = v; if (edit.hi < edit.lo) edit.hi = edit.lo; prefs?.set("editLo", edit.lo); prefs?.set("editHi", edit.hi); return; }
    if (p.msg === "voice") { m.voice[p.level][p.num] = v; return change([0x1a, edit.lo, Math.max(edit.lo, edit.hi), p.level, p.num, v & 127]); }
    if (p.msg === "preset") {
      if (p.parts) { for (const x of p.parts) { const pv = (v >> x.at) & ((1 << x.width) - 1); m.preset[x.num] = pv; await change([0x1b, 0x7f, x.num, pv]); } return; }
      m.preset[p.num] = v; return change([0x1b, 0x7f, p.num, v & 127]);
    }
    if (p.msg === "sample") {
      const sm = m.sample[p.level]; if (!sm) return;
      const [o, n] = SF[p.field];
      if (n === 3) to3(v).forEach((b, i) => { sm[o + i] = b; }); else sm[o] = p.field === "flags" ? setBit(p, sm[o], v) : v & 127;
      return change([0x1c, edit.lo, p.level, sm[0], ...sm.slice(4, 16), sm[16]]);
    }
    if (p.msg === "xfade" && m.xfade) {
      if (p.field === "mode") m.xfade[0] = (m.xfade[0] & ~7) | (v & 7); else if (p.field === "dir") m.xfade[0] = (m.xfade[0] & ~8) | ((v & 1) << 3); else return;
      return change([0x14, edit.lo, Math.max(edit.lo, edit.hi), (m.xfade[0] >> 3) & 1, m.xfade[0] & 7]);
    }
    if (p.msg === "misc" && m.misc) {
      if (p.field === "tune") m.misc[1] = v & 31; else m.misc[2] = setBit(p, m.misc[2], v);
      return change([0x22, m.misc[1], m.misc[2]]);
    }
  }

  return {
    async probe() { await ask([0x08], 0x38, null, 1000); return true; },
    async requestPatch() { const values = await readAll(); return { values, syx: [] }; },
    sendParam(p, v) { last[p.key] = v; send(p, v); },
    async sendPatch(values) {
      if (!haveRead) throw new Error("read the Emax first (get)");
      for (const p of schema.params) if (values[p.key] != null && values[p.key] !== last[p.key]) { last[p.key] = values[p.key]; await send(p, values[p.key]); }
    },
    async programChange(bi, prog) { await change([0x1e, prog & 127]); current = prog; },

    // preset-level params of any preset, without selecting it
    async requestProgram(bi, prog) {
      const n0 = (await ask([0x01, prog, 0], 0x31, (d) => d[5] === 0))[6];
      if (!n0) return { values: {}, data: {}, syx: [], name: "(empty)" };
      const byNum = await readPresetParams(prog), values = valuesFromPreset(byNum);
      const name = P("preset").filter((p) => p.display === "ascii").map((p) => String.fromCharCode(values[p.key] || 32)).join("").trim();
      // a restorable record: the preset-level writes (voices/samples live only on disk)
      const syx = Object.entries(byNum).flatMap(([n, v]) => [...H, 0x1b, prog, Number(n), v, 0xf7]);
      return { values, data: byNum, syx, name: name || undefined };
    },
    async requestSlotName(bi, prog) {
      const names = P("preset").filter((p) => p.display === "ascii");
      let s = "";
      for (const p of names) { const c = (await ask([0x01, prog, p.num], 0x31, (d) => d[5] === p.num))[6]; if (!c && p === names[0]) return "(empty)"; s += String.fromCharCode(c || 32); }
      return s.trim();
    },

    // RAM only: the current preset is edited in place; another slot gets a copy of
    // the current preset (Execute Copy Preset) with the preset-level values applied
    async writeProgram(bi, prog, values) {
      if (!haveRead) throw new Error("read the Emax first (get)");
      if (prog === current) { await this.sendPatch(values); return { ...m.preset }; }
      await change([0x17, current, prog]);
      const out = await readPresetParams(prog);
      for (const p of P("preset")) {
        const v = values[p.key]; if (v == null) continue;
        if (p.parts) for (const x of p.parts) { const pv = (v >> x.at) & ((1 << x.width) - 1); if (out[x.num] !== pv) { out[x.num] = pv; await change([0x1b, prog, x.num, pv]); } }
        else if (out[p.num] !== v) { out[p.num] = v; await change([0x1b, prog, p.num, v & 127]); }
      }
      return out;
    },
    sameProgram(a, b) { return !!a && !!b && P("preset").every((p) => presetNums(p).every((n) => a[n] === b[n])); },
    decode() { return []; }, // the Emax doesn't transmit panel edits (program changes are followed by the editor)
  };
}
