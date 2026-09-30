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

// prefs: { get(key), set(key, value) } — per-device settings a driver learns (Yamaha device #)
export function makeDriver(schema, midi, getChannel, prefs) {
  if (schema.transport === "nrpn") return nrpnDriver(schema, midi, getChannel);
  if (schema.transport === "roland") return rolandDriver(schema, midi, getChannel);
  if (schema.transport === "yamaha") return yamahaDriver(schema, midi, getChannel, prefs);
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
function rolandDriver(schema, midi, getChannel) {
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

  const width = (p) => (p.encoding === "d110pcm" ? 2 : p.size || 1);
  function read(p, data, off = p.offset) {
    if (p.encoding === "d110pcm") return ((data[off] >> 1) & 1) * 128 + data[off + 1];
    if (p.bits) return (data[off] >> p.bits.shift) & ((1 << p.bits.width) - 1);
    if ((p.size || 1) > 1) return data.slice(off, off + p.size).reduce((n, b) => (n << 4) | (b & 15), 0);
    return data[off];
  }
  function write(p, v, data) {
    const o = p.offset;
    if (p.encoding === "d110pcm") { data[o] = (data[o] & 1) | (((v >> 7) & 1) << 1); data[o + 1] = v & 127; return; }
    if (p.bits) { const m = ((1 << p.bits.width) - 1) << p.bits.shift; data[o] = (data[o] & ~m) | ((v << p.bits.shift) & m); return; }
    if ((p.size || 1) > 1) { for (let i = 0; i < p.size; i++) data[o + i] = (v >> (4 * (p.size - 1 - i))) & 15; return; }
    data[o] = v & 127;
  }

  const dt1 = (addrInt, data) => { const a = toBytes(addrInt, AB); midi.send([...hdr, R.commands.DT1, ...a, ...data, sum([...a, ...data]), 0xf7]); };

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
        if (got >= len) done(); else idle = setTimeout(done, 300);
      });
      const hard = setTimeout(done, 2500);
      const a = toBytes(addrInt, AB), s = toBytes(len, SB);
      midi.send([...hdr, R.commands.RQ1, ...a, ...s, sum([...a, ...s]), 0xf7]);
    });
  }

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

  // packages: several params the synth only accepts together (D-110 partial reserve)
  const pkgFor = (p) => Object.values(R.packages || {}).find((k) => k.block === p.block && p.offset >= k.offset && p.offset < k.offset + k.size);

  return {
    sendParam(p, v) {
      const b = blockOf.get(p.block), data = bytesOf(b);
      write(p, v, data);
      const pk = pkgFor(p);
      const [o, n] = pk ? [pk.offset, pk.size] : [p.offset, width(p)];
      dt1(b.at + o, data.slice(o, o + n));
    },
    sendPatch(values) { for (const b of patchBlocks) { mirror[b.name] = withValues(b, values); dt1(b.at, mirror[b.name]); } },

    async requestPatch() {
      const values = {}, syx = [];
      for (const b of patchBlocks) { const r = await rq1(b.at, b.size); mirror[b.name] = r.data; valuesFrom(b, r.data, values); syx.push(...r.raw); }
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
      const r = await rq1(s.at, Math.max(...ps.map((p) => p.offset)) + 1);
      return ps.map((p) => String.fromCharCode(r.data[p.offset] || 32)).join("").trim();
    },

    // just the name bytes of the edit buffer — quick, for scanning ROM banks by selecting each slot
    async requestName() {
      const b = patchBlocks[0];
      const ps = paramsOf.get(b.name).filter((p) => p.display === "ascii");
      if (!ps.length) return "";
      const len = Math.max(...ps.map((p) => p.offset)) + 1;
      const r = await rq1(b.at, len);
      return ps.map((p) => String.fromCharCode(r.data[p.offset] || 32)).join("").trim();
    },

    programChange(bi, prog) {
      const sel = bank(bi).select;
      if (sel?.type === "dt1") dt1(toInt(sel.address), sel.data.map((x) => (x === "prog" ? prog : x)));
      else selectProgram(midi, getChannel(), bank(bi), prog + (sel?.offset || 0));
    },

    async requestProgram(bi, prog) {
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
      for (const s of slotBlocks(bi, prog)) { if (!s.b) continue; sent[s.b.name] = withValues(s.b, values); dt1(s.at, sent[s.b.name]); }
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
