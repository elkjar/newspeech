// ct5-modes.js — quantize-mode patcher + WebUSB DfuSe flasher for the
// Montreal Assembly Count to 5, firmware 0.971 (board rev k/l/m).
//
// The firmware keeps the quantize mode as one int at RAM 0x2001df60:
//   0 none, 1 chromatic, 2 whole tone, 3 diminished, 4 augmented, 5 fifths + octaves.
// main() sets it to 0 at 0x0800ccba (`movs r2, #0`), and the Q-switch handler
// steps it +1 / -1 with wrap (blocks at 0x0800d086 and 0x0800d0ba, 24 bytes each).
// The patch sets the boot value and rewrites each 24-byte block as a lookup
// into a 6-byte "next mode" table stored inside the block:
//
//   ldr   r2, =0x2001df60   ; existing literal at 0x0800d104
//   ldr   r3, [r2]
//   cmp   r3, #5            ; clamp out-of-range values to 0
//   it    hi
//   movhi r3, #0
//   adr   r1, table
//   ldrb  r3, [r1, r3]
//   str   r3, [r2]
//   b     <end of block>
//   table: 6 bytes
//
// Works in the browser (window.CT5) and in node (module.exports).
(function (root) {
  "use strict";

  const STOCK_SHA256 = "32deeb1ea19f72bb6f3932cc365b4f3bae71d2cb9ab9e790b5c7a62efc8f249d";
  const STOCK_NAME = "application_release_0_971_k_l_m.dfu";
  const FLASH_BASE = 0x08000000;
  const HDR = 11 + 274 + 8; // DfuSe prefix + target prefix + element header

  const MODES = ["none", "chromatic", "whole tone", "diminished", "augmented", "fifths + octaves"];

  const SITES = {
    boot: { addr: 0x0800ccba, stock: "0022" },
    up:   { addr: 0x0800d086, stock: "1f4b1b6801331d4a13601c4b1b68052b02dd1a4b00221a60", ldr: 0x4a1f },
    down: { addr: 0x0800d0ba, stock: "124b1b68013b104a13600f4b1b68002b02da0d4b05221a60", ldr: 0x4a12 },
  };

  const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, "0")).join("");
  const off = (addr) => HDR + addr - FLASH_BASE;

  // CRC32 as used by the DFU suffix (no final inversion = ~standard crc32)
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function dfuCrc(u8, len) {
    let c = 0xffffffff;
    for (let i = 0; i < len; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
    return c >>> 0;
  }

  async function sha256(u8) {
    const subtle = (root.crypto && root.crypto.subtle) || require("crypto").webcrypto.subtle;
    return hex(new Uint8Array(await subtle.digest("SHA-256", u8)));
  }

  // Check a file is the stock 0.971 k/l/m .dfu. Returns { ok, reason }.
  async function checkStock(u8) {
    if (u8.length < HDR + 16 || String.fromCharCode(...u8.subarray(0, 5)) !== "DfuSe")
      return { ok: false, reason: "not a DfuSe .dfu file" };
    if ((await sha256(u8)) !== STOCK_SHA256)
      return { ok: false, reason: `not the stock ${STOCK_NAME} (checksum differs)` };
    return { ok: true };
  }

  // The flash image inside the .dfu (one element at 0x08000000).
  function image(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const addr = dv.getUint32(HDR - 8, true);
    const size = dv.getUint32(HDR - 4, true);
    if (addr !== FLASH_BASE) throw new Error("unexpected load address");
    return u8.slice(HDR, HDR + size);
  }

  // next-mode tables for a set of enabled modes (array of indices 0..5)
  function cycleTables(enabled) {
    const on = [...new Set(enabled)].filter((m) => m >= 0 && m <= 5).sort((a, b) => a - b);
    if (!on.length) throw new Error("enable at least one mode");
    const up = [], down = [];
    for (let m = 0; m < 6; m++) {
      up.push(on.find((e) => e > m) ?? on[0]);
      down.push([...on].reverse().find((e) => e < m) ?? on[on.length - 1]);
    }
    return { up, down };
  }

  function block(ldr, table) {
    const h = [ldr, 0x6813, 0x2b05, 0xbf88, 0x2300, 0xa101, 0x5ccb, 0x6013, 0xe002];
    const out = new Uint8Array(24);
    h.forEach((w, i) => { out[i * 2] = w & 0xff; out[i * 2 + 1] = w >> 8; });
    out.set(table, 18);
    return out;
  }

  // Patch a stock .dfu. opts = { enabled: [modes], boot: mode }. Returns a new Uint8Array.
  function patch(stock, opts) {
    const { enabled, boot } = opts;
    if (!(boot >= 0 && boot <= 5)) throw new Error("boot mode out of range");
    if (!enabled.includes(boot)) throw new Error("boot mode must be one of the enabled modes");
    const d = new Uint8Array(stock);
    for (const [k, s] of Object.entries(SITES)) {
      const o = off(s.addr), n = s.stock.length / 2;
      if (hex(d.subarray(o, o + n)) !== s.stock) throw new Error(`unexpected bytes at ${k} site`);
    }
    const { up, down } = cycleTables(enabled);
    d[off(SITES.boot.addr)] = boot; // movs r2, #boot
    d.set(block(SITES.up.ldr, up), off(SITES.up.addr));
    d.set(block(SITES.down.ldr, down), off(SITES.down.addr));
    const crc = dfuCrc(d, d.length - 4);
    new DataView(d.buffer).setUint32(d.length - 4, crc, true);
    return d;
  }

  function fileName(opts) {
    const tag = [...opts.enabled].sort().join("") + "-b" + opts.boot;
    return STOCK_NAME.replace(/\.dfu$/, `_q${tag}.dfu`);
  }

  // ---------------------------------------------------------------- WebUSB DfuSe
  // STM32 ROM bootloader (0483:df11), alt 0 = internal flash.
  const REQ = { DNLOAD: 1, UPLOAD: 2, GETSTATUS: 3, CLRSTATUS: 4, ABORT: 6 };
  const ST = { IDLE: 2, DNBUSY: 4, DNLOAD_IDLE: 5, UPLOAD_IDLE: 9, ERROR: 10 };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg" → [{start,size}]
  function parseLayout(name) {
    const m = /\/0x([0-9a-f]+)\/(.+)$/i.exec(name || "");
    if (!m) return null;
    let a = parseInt(m[1], 16);
    const sectors = [];
    for (const part of m[2].split(",")) {
      const p = /(\d+)\*(\d+)([KM ]?)/i.exec(part);
      if (!p) return null;
      const size = +p[2] * (p[3].toUpperCase() === "K" ? 1024 : p[3].toUpperCase() === "M" ? 1048576 : 1);
      for (let i = 0; i < +p[1]; i++) { sectors.push({ start: a, size }); a += size; }
    }
    return sectors;
  }
  const F4_1M = "@Internal Flash  /0x08000000/04*016Kg,01*064Kg,07*128Kg";

  class DfuSe {
    constructor(device) {
      this.dev = device;
      this.intf = 0;
      this.xfer = 2048;
      this.layout = null;
    }
    static async request() {
      return navigator.usb.requestDevice({ filters: [{ vendorId: 0x0483, productId: 0xdf11 }] });
    }
    async open() {
      const d = this.dev;
      if (!d.opened) await d.open();
      if (d.configuration === null) await d.selectConfiguration(1);
      await d.claimInterface(this.intf);
      await d.selectAlternateInterface(this.intf, 0);
      const alt = d.configuration.interfaces
        .find((i) => i.interfaceNumber === this.intf)
        .alternates.find((a) => a.alternateSetting === 0);
      this.altName = (alt && alt.interfaceName) || "";
      this.layout = parseLayout(this.altName);
      if (!this.layout) {
        // interface names aren't always exposed; this layout is the Count to 5's STM32F4 (1 MB)
        this.layout = parseLayout(F4_1M);
      } else if (this.altName.replace(/\s+/g, " ") !== F4_1M.replace(/\s+/g, " ")) {
        throw new Error(`unexpected flash layout: ${this.altName}`);
      }
      await this.idle();
    }
    async close() {
      try { await this.dev.releaseInterface(this.intf); } catch (e) {}
      try { await this.dev.close(); } catch (e) {}
    }
    out(request, value, data) {
      return this.dev.controlTransferOut(
        { requestType: "class", recipient: "interface", request, value, index: this.intf },
        data || new Uint8Array(0));
    }
    async in(request, value, length) {
      const r = await this.dev.controlTransferIn(
        { requestType: "class", recipient: "interface", request, value, index: this.intf }, length);
      if (r.status !== "ok") throw new Error(`USB transfer ${r.status}`);
      return new Uint8Array(r.data.buffer, r.data.byteOffset, r.data.byteLength);
    }
    async status() {
      const b = await this.in(REQ.GETSTATUS, 0, 6);
      return { status: b[0], poll: b[1] | (b[2] << 8) | (b[3] << 16), state: b[4] };
    }
    async idle() {
      let s = await this.status();
      if (s.state === ST.ERROR) { await this.out(REQ.CLRSTATUS, 0); s = await this.status(); }
      if (s.state !== ST.IDLE) { await this.out(REQ.ABORT, 0); s = await this.status(); }
      if (s.state === ST.ERROR) { await this.out(REQ.CLRSTATUS, 0); s = await this.status(); }
      if (s.state !== ST.IDLE) throw new Error(`device not idle (state ${s.state})`);
    }
    // after a DNLOAD: poll GETSTATUS until the operation finishes
    async settle() {
      let s = await this.status();
      while (s.state === ST.DNBUSY) {
        await sleep(Math.max(s.poll, 5));
        s = await this.status();
      }
      if (s.status !== 0 || s.state !== ST.DNLOAD_IDLE)
        throw new Error(`device error (status ${s.status}, state ${s.state})`);
    }
    async command(bytes) {
      await this.out(REQ.DNLOAD, 0, new Uint8Array(bytes));
      await this.settle();
    }
    addrBytes(a) { return [a & 0xff, (a >>> 8) & 0xff, (a >>> 16) & 0xff, (a >>> 24) & 0xff]; }
    setAddress(a) { return this.command([0x21, ...this.addrBytes(a)]); }
    eraseSector(a) { return this.command([0x41, ...this.addrBytes(a)]); }

    sectorsFor(start, length) {
      const end = start + length;
      const s = this.layout.filter((x) => x.start < end && x.start + x.size > start);
      if (!s.length || s[0].start > start || s[s.length - 1].start + s[s.length - 1].size < end)
        throw new Error("range is outside flash");
      return s;
    }

    async read(start, length, onProgress) {
      await this.idle();
      await this.setAddress(start);
      await this.out(REQ.ABORT, 0);
      const out = new Uint8Array(length);
      let got = 0, block = 2;
      while (got < length) {
        const n = Math.min(this.xfer, length - got);
        const chunk = await this.in(REQ.UPLOAD, block++, this.xfer);
        out.set(chunk.subarray(0, n), got);
        got += n;
        if (onProgress) onProgress(got / length);
      }
      await this.out(REQ.ABORT, 0);
      await this.idle();
      return out;
    }

    async erase(start, length, onProgress) {
      await this.idle();
      const sectors = this.sectorsFor(start, length);
      for (let i = 0; i < sectors.length; i++) {
        await this.eraseSector(sectors[i].start);
        if (onProgress) onProgress((i + 1) / sectors.length);
      }
    }

    async write(start, data, onProgress) {
      await this.idle();
      for (let o = 0; o < data.length; o += this.xfer) {
        await this.setAddress(start + o);
        await this.out(REQ.DNLOAD, 2, data.subarray(o, o + this.xfer));
        await this.settle();
        if (onProgress) onProgress(Math.min(1, (o + this.xfer) / data.length));
      }
      await this.idle();
    }
  }

  const api = {
    MODES, STOCK_NAME, STOCK_SHA256, FLASH_BASE,
    checkStock, image, patch, cycleTables, fileName, dfuCrc, parseLayout, DfuSe,
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.CT5 = api;
})(typeof window !== "undefined" ? window : globalThis);
