// Replays a loopback capture (src-tauri/examples/loopback.rs) through tauri.js's
// parser and checks every message came back whole, in order, with its pacing.
// node tools/rack/app/loopback-check.mjs capture.json
import fs from "node:fs";
import { midiParser } from "../tauri.js";

const cap = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const got = [];
let t = 0;
const parse = midiParser((m) => got.push({ t, bytes: m }));
for (const r of cap.recv) { t = r.t; parse(r.bytes); }

// what the app should see: midi.rs drops clock + active sense, everything else whole
const want = cap.sent
  .map((s) => ({ ...s, bytes: s.bytes.filter((b) => b !== 0xf8 && b !== 0xfe) }))
  .filter((s) => s.bytes.length);
const hex = (a) => a.slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join(" ") + (a.length > 8 ? ` …(${a.length})` : "");
let bad = 0;
for (let i = 0; i < Math.max(want.length, got.length); i++) {
  const w = want[i], g = got[i];
  if (!w || !g || w.bytes.length !== g.bytes.length || w.bytes.some((b, k) => b !== g.bytes[k])) {
    bad++;
    if (bad <= 10) console.log(`#${i} ${w?.label ?? "-"}: want ${w ? hex(w.bytes) : "nothing"} got ${g ? hex(g.bytes) : "nothing"}`);
  }
}
console.log(`${want.length} sent, ${got.length} parsed, ${bad} mismatched`);

const cbSizes = cap.recv.map((r) => r.bytes.length);
console.log(`callbacks: ${cap.recv.length}, sizes min ${Math.min(...cbSizes)} max ${Math.max(...cbSizes)}`);
const multi = cap.recv.filter((r) => r.bytes[0] !== 0xf0 && r.bytes.filter((b) => b >= 0x80).length > 1).length;
const cont = cap.recv.filter((r) => r.bytes[0] < 0x80).length;
console.log(`callbacks starting mid-SysEx: ${cont}, callbacks holding several messages: ${multi}`);

// pacing: 20 ms sends should arrive ~20 ms apart
const paced = got.filter((g, i) => want[i]?.label === "paced").map((g) => g.t / 1000);
const gaps = paced.slice(1).map((x, i) => x - paced[i]);
if (gaps.length) console.log(`paced gaps ms: min ${Math.min(...gaps).toFixed(1)} max ${Math.max(...gaps).toFixed(1)} mean ${(gaps.reduce((a, b) => a + b) / gaps.length).toFixed(1)}`);
// latency of the big dumps: send → last byte in, vs DIN wire time
for (let i = 0; i < want.length; i++) {
  if (!/^sysex\d/.test(want[i].label) || !got[i]) continue;
  const n = want[i].bytes.length;
  console.log(`${want[i].label}: ${((got[i].t - want[i].t) / 1000).toFixed(0)} ms in (wire ${(n / 3.125).toFixed(0)} ms)`);
}
process.exit(bad ? 1 : 0);
