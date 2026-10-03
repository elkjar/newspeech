import { Midi } from "./midi.js";
import { makeDriver, TRANSPORTS } from "./drivers.js";
import { createKnob } from "./knob.js";

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v != null && v !== false) el.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k != null) el.append(k);
  return el;
};
const LS = "rack.";
const lsGet = (k, d) => { try { return localStorage.getItem(LS + k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(LS + k, v); } catch {} };

const NOTE = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const KEYS = { a: 0, w: 1, s: 2, e: 3, d: 4, f: 5, t: 6, g: 7, y: 8, h: 9, u: 10, j: 11, k: 12 };

const midi = new Midi();
let schema = null, layout = null, driver = null, byKey = new Map();
let values = {};          // live patch
let saved = {};           // last loaded/saved — the A/B reference + changed markers
let compareSnapshot = null;
let undo = [], redo = [];
let pending = new Map();  // coalesced live sends
let heldNote = null, octave = 4;
let mutAmt = Number(lsGet("mutate", "15"));
const mutateAmount = () => mutAmt / 100;
let cur = { bank: 0, prog: 0 }, scanning = false;

// every on-screen control registers the param keys it shows; setValue fans out
const registry = new Map(); // key → Set<{ update(v), flash?(), changed?(on) }>
const register = (key, ctl) => { (registry.get(key) || registry.set(key, new Set()).get(key)).add(ctl); return () => registry.get(key)?.delete(ctl); };

// per-synth MIDI channel; a schema can set its factory default (D-110 part 1 = ch 2)
const channel = () => Number(lsGet(`${schema.id}.ch`, String(schema.defaultChannel ?? 1))) - 1;
const status = (msg, err = false) => { const s = $("#status"); s.textContent = msg; s.classList.toggle("err", err); };

// ---------- formatting ----------
const isName = (p) => p.display === "char" || p.display === "ascii";
function fmt(p, v) {
  if (v == null) return "—";
  if (p.options) return p.options[v - p.min] ?? v;
  if (p.display === "note") return NOTE[v % 12] + (Math.floor(v / 12) + (schema.noteOctaveBase ?? 0));
  if (p.display === "wave") return waveName(p, v);
  if (isName(p)) return String.fromCharCode(v);
  if (p.display === "paramIndex") return schema.params.find((q) => (q.sysexIndex ?? q.nrpn) === v)?.name ?? "—";
  if (p.display === "seqStep") return v === 126 ? "reset" : v === 127 ? "rest" : String(v);
  const n = v + (p.valueOffset || 0);
  return p.display === "bipolar" && n > 0 ? "+" + n : String(n);
}

// JV-style wave numbers: the name depends on the tone's wave group + bank id
function waveName(p, v) {
  const wl = p.waveLookup, num = String(v + (p.valueOffset || 0)).padStart(3, "0");
  if (!wl || values[wl.groupKey] !== 0) return "#" + num;       // PCM / EXP: number only
  const bank = values[wl.groupIdKey] === 1 ? "INT-A" : values[wl.groupIdKey] === 2 ? "INT-B" : null;
  const name = bank && schema.waves?.[bank]?.[v];
  return name ? `${bank.slice(-1)}${num} ${name}` : "#" + num;
}
const clamp = (p, v) => Math.max(p.min, Math.min(p.max, Math.round(v)));

// ---------- state ----------
const snapshot = () => ({ ...values });
function commitUndo(before) {
  if (JSON.stringify(before) === JSON.stringify(values)) return;
  undo.push(before); if (undo.length > 300) undo.shift(); redo = [];
}
let gestureBefore = null;
const begin = () => { gestureBefore ??= snapshot(); };
const end = () => { if (gestureBefore) commitUndo(gestureBefore); gestureBefore = null; };

function setValue(p, v, { send = true, from = "ui" } = {}) {
  v = clamp(p, v);
  values[p.key] = v;
  const changed = saved[p.key] != null && saved[p.key] !== v;
  for (const c of registry.get(p.key) || []) {
    c.update(v);
    c.changed?.(changed);
    if (from === "synth") c.flash?.();
  }
  if (isName(p)) renderName();
  if (from !== "load" && !isName(p)) showLast(p, v);
  if (send) { pending.set(p.key, p); schedule(); }
  // driver-state params (Emax edit key) retarget the editor: read what's there now
  if (send && p.msg === "local") { clearTimeout(rereadTimer); rereadTimer = setTimeout(getFromSynth, 400); }
}
let rereadTimer = null;

let raf = 0;
function schedule() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    // slow units (JV: 20 ms between messages) — hold the latest values until the
    // queue drains instead of piling up a backlog behind a knob drag
    if (midi.drainMs() > (schema.gapMs ?? 2) * 2) return schedule();
    for (const [k, p] of pending) driver.sendParam(p, values[k]);
    pending.clear();
  });
}

function applyAll(next, { send = true } = {}) {
  for (const p of schema.params) if (next[p.key] != null) setValue(p, next[p.key], { send: false, from: "load" });
  if (send) driver.sendPatch(values);
}

// knob labels show the value on hover/drag, so nothing else echoes it
function showLast() {}

// ---------- name ----------
const nameParams = () => schema.params.filter(isName);
const nameString = () => nameParams().map((p) => String.fromCharCode(values[p.key] ?? 32)).join("").trimEnd();
function renderName() { const el = $("#pname"); if (el && document.activeElement !== el) el.value = nameString(); }
function setName(str) {
  nameParams().forEach((p, i) => {
    const c = (str[i] ?? " ").charCodeAt(0);
    setValue(p, c >= 32 && c <= 126 ? c : 32);
  });
}

// ---------- variation ----------
function randomize(params, amount = 1) {
  const before = snapshot();
  for (const p of params) {
    if (isName(p) || p.norandom || p.notInPatch || p.display === "paramIndex") continue;
    const span = p.max - p.min;
    let v;
    if (amount >= 1) v = p.min + Math.random() * (span + 1);
    else if (p.options || span <= 1) { if (Math.random() > amount * 0.5) continue; v = p.min + Math.random() * (span + 1); }
    else v = (values[p.key] ?? p.min) + (Math.random() * 2 - 1) * span * amount * 0.5;
    setValue(p, Math.floor(v >= p.max ? p.max : v), { send: false, from: "load" });
  }
  driver.sendPatch(values);
  commitUndo(before);
}

// ---------- faceplate ----------
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? `{${k}}`);

// if the device ships no layout, derive a plain one from its groups
function autoLayout() {
  const groups = schema.groups || [...new Set(schema.params.map((p) => p.group))].map((id) => ({ id, name: id }));
  return { rows: [{ id: "all", groups: groups
    .map((g) => ({ title: g.name, controls: schema.params.filter((p) => p.group === g.id && !isName(p)).map((p) => ({ k: p.key, label: p.name })) }))
    .filter((s) => s.controls.length) }] };
}

const sharedSelects = new Map(); // shared id → Set<(label) => void>

function renderFaceplate() {
  registry.clear();
  sharedSelects.clear();
  const root = $("#face"); root.replaceChildren();
  for (const row of layout.rows) {
    const rowEl = h("div", { class: `frow frow-${row.id}` });
    for (const g of row.groups) rowEl.append(renderGroup(g));
    root.append(rowEl);
  }
}

// a bordered group: legend in the border, one cell per control, label under each
function renderGroup(g) {
  const cells = h("div", { class: "cells" });
  const el = h("fieldset", { class: "grp" }, h("legend", {}, g.title), cells);

  const opts = g.select?.options || [{ label: "", vars: {} }];
  // select.shared links every group with the same id (the JV's tone 1–4)
  const shared = g.select?.shared;
  const selKey = shared ? `${schema.id}.sel.@${shared}` : `${schema.id}.sel.${g.title}`;
  let current = lsGet(selKey, opts[0].label);
  if (current !== g.select?.all && !opts.some((o) => o.label === current)) current = opts[0].label;
  let unbind = [];

  // the params a template key resolves to for the current select (several when "all")
  const resolve = (tpl) => {
    const chosen = current === g.select?.all ? opts : [opts.find((o) => o.label === current)];
    return [...new Set(chosen.map((o) => fill(tpl, o.vars)))].map((k) => byKey.get(k)).filter(Boolean);
  };
  const stepKeys = (c) => Array.from({ length: c.count }, (_, i) => c.k.replace("{i}", i + 1));
  const groupParams = () => g.controls.flatMap((c) => !c.k && !c.keys ? [] : c.keys ? c.keys.flatMap(resolve)
    : c.count ? stepKeys(c).flatMap(resolve) : resolve(c.k));

  el.append(h("div", { class: "grptools" },
    h("button", { title: "randomize this group (the copy selected)", onclick: () => randomize(groupParams()) }, "rand"),
    h("button", { title: "nudge this group by the mutate amount", onclick: () => randomize(groupParams(), mutateAmount()) }, "mut")));

  function build() {
    unbind.forEach((u) => u()); unbind = [];
    cells.replaceChildren();
    for (const c of g.controls) {
      if (c.only && !c.only.includes(current)) { cells.append(offCell(c)); continue; }
      if (c.as === "select") { cells.append(selectCell()); continue; }
      if (c.as === "env") { cells.append(envCell(c, c.keys.map((k) => resolve(k)[0]).filter(Boolean))); continue; }
      if (c.as === "steps") { cells.append(stepsCell(c, stepKeys(c).map((k) => resolve(k)[0]).filter(Boolean))); continue; }
      const ps = resolve(c.k);
      if (ps.length) cells.append(control(c, ps));
    }
  }

  // a control that doesn't apply to the current copy: dimmed in place (the
  // plugins' THRESH/WAVE pattern), or the hard-wired destination as text
  function offCell(c) {
    const opt = opts.find((o) => o.label === current);
    const fixed = c.fixed && opt ? fill(c.fixed, opt.vars) : "";
    if (fixed) return h("div", { class: "cell fixedcell", title: `${opt.label} envelope is wired to ${fixed}` },
      h("div", { class: "fixed" }, "→ " + fixed), h("span", { class: "clabel" }, c.label));
    const mark = c.as === "toggle" ? h("span", { class: "dot" })
      : h("span", { class: "ghostknob" });
    return h("div", { class: `cell off ${c.as === "toggle" ? "dotcell" : "kcell"}` }, mark, h("span", { class: "clabel" }, c.label));
  }

  function selectCell() {
    const labels = [...opts.map((o) => o.label), ...(g.select.all ? [g.select.all] : [])];
    const btns = labels.map((l) => h("button", { class: l === current ? "on" : "", onclick: () => {
      lsSet(selKey, l);
      if (shared) for (const fn of sharedSelects.get(shared) || []) fn(l);
      else { current = l; build(); }
    } }, l));
    return h("div", { class: "cell segcell selcell" }, h("div", { class: "seg" }, btns), h("span", { class: "clabel" }, g.select.label));
  }

  function control(c, ps) {
    const p = ps[0];
    const write = (v) => { begin(); for (const q of ps) setValue(q, v); };
    const reset = () => { if (saved[p.key] != null) { begin(); for (const q of ps) setValue(q, saved[q.key]); end(); } };
    const as = c.as || (p.options?.length === 2 ? "toggle" : "knob");
    const hover = () => showLast(p, values[p.key]);

    if (as === "toggle") {
      const dot = h("button", { class: "dot", "aria-label": p.name, onclick: () => { begin(); write(values[p.key] === p.max ? p.min : p.max); end(); }, onpointerenter: hover });
      const cell = h("div", { class: "cell dotcell", title: p.name }, dot, h("span", { class: "clabel" }, c.label));
      return bindAll(ps, { update: (v) => dot.classList.toggle("on", v === p.max), changed: (on) => cell.classList.toggle("changed", on), flash: () => flash(cell) }, cell);
    }
    if (as === "seg") {
      const labels = c.labels || p.options;
      const btns = labels.map((l, i) => h("button", { title: p.options?.[i], onclick: () => { begin(); write(p.min + i); end(); }, onpointerenter: hover }, l));
      const cell = h("div", { class: "cell segcell" }, h("div", { class: "seg" }, btns), h("span", { class: "clabel" }, c.label));
      return bindAll(ps, { update: (v) => btns.forEach((b, i) => b.classList.toggle("on", p.min + i === v)), changed: (on) => cell.classList.toggle("changed", on), flash: () => flash(cell) }, cell);
    }
    if (as === "pick") {
      const optionList = () => (p.options || Array.from({ length: p.max - p.min + 1 }, (_, i) => fmt(p, p.min + i))).map((o, i) => new Option(o, p.min + i));
      const sel = h("select", { class: "box", onchange: (e) => { begin(); write(Number(e.target.value)); end(); }, onpointerenter: hover }, optionList());
      const cell = h("label", { class: "cell pickcell", title: p.name }, sel, h("span", { class: "clabel" }, c.label));
      // wave names change with the tone's wave group / bank — rebuild the list when they do
      if (p.waveLookup) for (const k of [p.waveLookup.groupKey, p.waveLookup.groupIdKey])
        unbind.push(register(k, { update: () => { sel.replaceChildren(...optionList()); sel.value = values[p.key]; } }));
      return bindAll(ps, { update: (v) => { sel.value = v; }, changed: (on) => cell.classList.toggle("changed", on), flash: () => flash(cell) }, cell);
    }
    const k = createKnob({ label: c.label, fmt, onBegin: begin, onChange: write, onEnd: end, onReset: reset, onHover: showLast });
    k.setParam(p);
    return bindAll(ps, { update: k.set, changed: k.setChanged, flash: k.flash }, k.el);
  }

  // register each shown param (display follows the first); update now
  function bindAll(ps, ctl, el) {
    ps.forEach((q, i) => unbind.push(register(q.key, i === 0 ? ctl : { update() {}, flash: ctl.flash })));
    ctl.update(values[ps[0].key]);
    ctl.changed?.(saved[ps[0].key] != null && saved[ps[0].key] !== values[ps[0].key]);
    return el;
  }

  // envelope shape drawn from DADSR — the knobs beside it are the handles
  function envCell(c, ps) {
    const W = 150, H = 46;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`); svg.setAttribute("class", "envgraph");
    const base = document.createElementNS(svg.namespaceURI, "line");
    Object.entries({ x1: 0, x2: W, y1: H - 2, y2: H - 2, class: "base" }).forEach(([k, v]) => base.setAttribute(k, v));
    const path = document.createElementNS(svg.namespaceURI, "path");
    svg.append(base, path);
    const draw = () => {
      const [d, a, dc, s, r] = ps.map((p) => (values[p.key] - p.min) / (p.max - p.min || 1));
      const seg = (W - 8) / 4.4, y0 = H - 2, top = 3, sy = y0 - s * (y0 - top);
      let x = 1;
      const pts = [[x, y0]];
      x += d * seg; pts.push([x, y0]);
      x += a * seg + 1; pts.push([x, top]);
      x += dc * seg + 1; pts.push([x, sy]);
      x += seg * 0.4; pts.push([x, sy]);
      x += r * seg + 1; pts.push([x, y0]);
      path.setAttribute("d", "M" + pts.map((q) => q.map((n) => n.toFixed(1)).join(",")).join(" L"));
    };
    ps.forEach((p) => unbind.push(register(p.key, { update: draw })));
    draw();
    return h("div", { class: "cell widecell" }, svg, h("span", { class: "clabel" }, c.label));
  }

  // 16 steps as bars; drag across to draw, alt-click = rest (track 1) / reset (2–4)
  function stepsCell(c, ps) {
    const grid = h("div", { class: "steps" });
    for (const p of ps) {
      const bar = h("i");
      const step = h("div", { class: "step" }, bar);
      const update = (v) => {
        step.classList.toggle("rest", v >= 126);
        bar.style.height = v >= 126 ? "0%" : (v / 125) * 100 + "%";
        step.dataset.mark = v === 127 ? "rest" : v === 126 ? "rst" : "";
      };
      unbind.push(register(p.key, { update, flash: () => flash(step) }));
      update(values[p.key]);
      grid.append(step);
    }
    const at = (e) => {
      const r = grid.getBoundingClientRect();
      const i = Math.max(0, Math.min(ps.length - 1, Math.floor(((e.clientX - r.left) / r.width) * ps.length)));
      const v = Math.round(Math.max(0, Math.min(1, 1 - (e.clientY - r.top) / r.height)) * 125);
      return { p: ps[i], v };
    };
    grid.addEventListener("pointerdown", (e) => {
      e.preventDefault(); grid.setPointerCapture(e.pointerId); begin();
      const first = at(e);
      if (e.altKey) { setValue(first.p, first.p.max); end(); return; }
      setValue(first.p, first.v);
      const move = (ev) => { const { p, v } = at(ev); setValue(p, v); };
      const up = () => { grid.removeEventListener("pointermove", move); grid.removeEventListener("pointerup", up); end(); };
      grid.addEventListener("pointermove", move); grid.addEventListener("pointerup", up);
    });
    return h("div", { class: "cell widecell stepscell" }, grid, h("span", { class: "clabel" }, c.label));
  }

  if (shared) (sharedSelects.get(shared) || sharedSelects.set(shared, new Set()).get(shared)).add((l) => { current = l; build(); });
  build();
  return el;
}

function flash(el) { el.classList.remove("rx"); void el.offsetWidth; el.classList.add("rx"); }

// ---------- hardware ----------
async function getFromSynth() {
  try {
    status("asking the synth for its edit buffer…");
    const { values: v } = await driver.requestPatch();
    const before = snapshot();
    saved = { ...v };
    applyAll(v, { send: false });
    commitUndo(before);
    status(`read edit buffer${nameParams().length ? ` — “${nameString()}”` : ""}`);
  } catch (e) { status(e.message + " — check both MIDI cables, the channel, and sysex on the synth", true); }
}

// test notes go to the editor channel, unless the schema names a param holding a part's receive
// channel (U-110: ch 16 is control-only, part 1 listens on its own RCV CH)
const noteChannel = () => { const k = schema.noteChannelParam; return k && values[k] != null ? values[k] : channel(); };
let heldCh = 0;
function noteOn(n) { if (heldNote != null) midi.noteOff(heldCh, heldNote); heldNote = n; heldCh = noteChannel(); midi.noteOn(heldCh, n, 100); $("#hold").classList.add("on"); }
function noteOff() { if (heldNote != null) midi.noteOff(heldCh, heldNote); heldNote = null; $("#hold").classList.remove("on"); }

// ---------- setup ----------
function fillPorts() {
  if (!midi.access) return;
  const want = midi.savedPorts(schema.id);
  const fillSel = (sel, ports, id) => {
    sel.replaceChildren(h("option", { value: "" }, "—"), ...ports.map((p) => h("option", { value: p.id }, p.name)));
    sel.value = ports.some((p) => p.id === id) ? id : "";
  };
  fillSel($("#in"), midi.inputs(), want.in);
  fillSel($("#out"), midi.outputs(), want.out);
  usePorts();
  if (!midi.inputs().length && !midi.outputs().length) status("no MIDI ports — is the interface plugged in?", true);
}

async function selectDevice(id) {
  schema = await (await fetch(`devices/${id}.json`)).json();
  const lr = await fetch(`devices/${id}.layout.json`);
  byKey = new Map(schema.params.map((p) => [p.key, p]));
  layout = lr.ok ? await lr.json() : autoLayout();
  lsSet("device", id);
  midi.gapMs = schema.gapMs ?? 2;
  driver = makeDriver(schema, midi, channel, { get: (k) => lsGet(`${schema.id}.${k}`, null), set: (k, v) => lsSet(`${schema.id}.${k}`, v) });
  // until GET reads the synth: bipolar params sit at centre, the rest at min
  values = Object.fromEntries(schema.params.map((p) => [p.key, p.default ?? (p.display === "bipolar" ? clamp(p, -(p.valueOffset || 0)) : p.min)]));
  saved = {}; undo = []; redo = [];
  $("#ch").value = channel() + 1;
  $("#pname").hidden = !nameParams().length;
  document.body.classList.toggle("noread", driver.canRead === false);
  $("#pname").maxLength = nameParams().length || 16;
  $("#synthname").textContent = schema.name;
  fillPorts();
  renderProgramControls();
  renderFaceplate();
  renderName();
  refreshBackups();
  $("#backup .plabel").textContent = driver.captureBank ? "capture bank" : "create backup";
  $("#setup-steps").replaceChildren(...(schema.setup || []).map((s) => h("li", {}, s)));
}

async function boot() {
  let midiErr = null;
  try { await midi.init(); } catch (e) { midiErr = e; }
  midi.onPorts = () => schema && fillPorts();
  midi.on((ev) => {
    if (!driver) return;
    $("#rx").classList.remove("blink"); void $("#rx").offsetWidth; $("#rx").classList.add("blink");
    // synth changed program on its front panel → pull the new sound in
    if (ev.ch === channel() && banks().length && followProgram(ev)) return;
    for (const { param, value } of driver.decode(ev)) setValue(param, value, { send: false, from: "synth" });
  });

  // skip files that don't parse yet (a device being written right now).
  // no api → the static site build: its devices.json stands in
  try { const r = await fetch("api/devices"); if (r.ok && r.headers.get("content-type")?.includes("json")) { devices = await r.json(); LOCAL = true; } } catch {}
  if (!LOCAL) devices = await (await fetch("devices.json")).json();
  devices = devices.filter((d) => !d.error);
  $("#in").onchange = $("#out").onchange = usePorts;
  $("#back").onclick = disconnect;
  $("#recheck").onclick = () => renderRack({ force: true });
  $("#connect-go").onclick = () => runConnect();
  $("#connect-retry").onclick = () => runConnect();
  $("#connect-skip").onclick = () => { skipNames = true; };
  $("#reconnect").onclick = () => { closeSetup(); startConnect(schema.id, { auto: false }); };
  $("#ch").onchange = (e) => { lsSet(`${schema.id}.ch`, e.target.value); telemetry(); };
  const mk = createKnob({ label: "amount", fmt: (p, v) => v + "%", onBegin() {}, onEnd() {},
    onChange: (v) => { mutAmt = v; lsSet("mutate", v); }, onHover: (p, v) => showLast(p, v) });
  mk.setParam({ key: "mutate", name: "Mutate Amount", min: 2, max: 60 });
  mk.set(mutAmt);
  $("#mutknob").replaceWith(mk.el);
  barcode();
  $("#get").onclick = getFromSynth;
  $("#send").onclick = () => { driver.sendPatch(values); status("sent whole patch to edit buffer"); };
  $("#hold").onclick = () => heldNote != null ? noteOff() : noteOn(12 * octave + 12);
  $("#undo").onclick = doUndo;
  $("#redo").onclick = doRedo;
  $("#ab").onclick = toggleCompare;
  $("#mutate").onclick = () => randomize(schema.params, mutateAmount());
  $("#random").onclick = () => randomize(schema.params);
  $("#prev").onclick = () => stepProgram(-1);
  $("#next").onclick = () => stepProgram(1);
  $("#progpick").onchange = (e) => {
    const v = Number(e.target.value);
    if (v < 0) { e.target.value = cur.prog; return readBankNames(cur.bank); }
    goProgram(cur.bank, v);
  };
  $("#setup-close").onclick = closeSetup;
  $("#setup").onclick = (e) => { if (e.target === $("#setup")) closeSetup(); };
  $("#backup").onclick = createBackup;
  $("#store").onclick = openStore;
  $("#st-cancel").onclick = () => $("#storedlg").close();
  $("#st-go").onclick = doStore;
  $("#st-prog").onchange = () => { stTarget.prog = Math.max(0, Math.min(banks()[stTarget.bank].count - 1, Number($("#st-prog").value) - 1)); readTarget(); };
  $("#libtoggle").onclick = openSetup;
  $("#pname").oninput = (e) => setName(e.target.value);


  await renderRack();
  status(midiErr ? "Web MIDI unavailable (" + midiErr.message + ") — use Chrome and allow MIDI + SysEx" : "pick a synth", !!midiErr);
}

// ---------- programs on the synth ----------
// schema.programs.banks: [{ label, msb?, lsb?, count, dump?, write? }] — dump =
// readable over sysex (backups, names, store's read-first), write = storable
const pad3 = (n) => String(n + 1).padStart(3, "0");
const slotKey = (b, p) => `${b}-${p}`;
const banks = () => schema.programs?.banks || [];
// banks you can play/step through (patch/timbre memories on the D-110 are backup-only)
const navBanks = () => banks().map((b, bi) => ({ ...b, bi })).filter((b) => !b.backupOnly && lsGet(`${schema.id}.absent.${b.bi}`, "") !== "1");
const bankName = (bi) => { const l = banks()[bi]?.label ?? String(bi + 1); return /^\d+$/.test(l) ? `bank ${l}` : l; };
const slotName = (bi, p) => `${bankName(bi)} · ${pad3(p)}`;
function names() { try { return JSON.parse(lsGet(`${schema.id}.names`, "{}")); } catch { return {}; } }

// when each bank's names were last read from the synth; older than this → re-read on connect
const NAMES_STALE_MS = 72 * 3600 * 1000;
const namesStamp = (bi) => { lsSet(`${schema.id}.namesAt.${bi}`, String(Date.now())); };
function namesAge(bi) {
  let at = Number(lsGet(`${schema.id}.namesAt.${bi}`, "0"));
  // names saved before timestamps existed: count them as fresh from now
  if (!at) { const b = banks()[bi], known = names();
    if (b && Array.from({ length: b.count }, (_, p) => known[slotKey(bi, p)]).some(Boolean)) { namesStamp(bi); at = Date.now(); } }
  return at ? Date.now() - at : Infinity;
}
function ageText(ms) {
  if (!isFinite(ms)) return "not read yet";
  const m = ms / 60000;
  return m < 2 ? "just read" : m < 90 ? `${Math.round(m)} min old` : m < 48 * 60 ? `${Math.round(m / 60)} h old` : `${Math.round(m / 1440)} d old`;
}

function renderProgramControls() {
  const bs = navBanks();
  $("#progcell").hidden = !bs.length;
  $("#storecell").hidden = !bs.some((b) => b.write) || !driver.writeProgram;
  if (!bs.length) return;
  try { cur = JSON.parse(lsGet(`${schema.id}.prog`, "")) || cur; } catch { cur = { bank: 0, prog: 0 }; }
  if (!bs.some((b) => b.bi === cur.bank)) cur = { bank: bs[0].bi, prog: 0 };
  // a few banks → buttons (Mopho 1/2/3); many → a dropdown (JV user/presets/cards/exp)
  // short names (Mopho 1/2/3) → buttons; long or many (JV, TG-55) → a dropdown
  $("#banks").replaceChildren(bs.length <= 3 && bs.every((b) => b.label.length <= 3)
    ? h("div", { class: "seg" }, bs.map((b) => h("button", { "data-b": b.bi, onclick: () => goProgram(b.bi, cur.prog) }, b.label)))
    : h("select", { class: "box bankpick", onchange: (e) => goProgram(Number(e.target.value), cur.prog) }, bs.map((b) => new Option(b.label, b.bi))));
  showCurrent();
  renderProgramList();
}

function setCurrent(bank, prog) {
  cur = { bank, prog };
  lsSet(`${schema.id}.prog`, JSON.stringify(cur));
  showCurrent();
}

function showCurrent() {
  document.querySelectorAll("#banks button").forEach((b) => b.classList.toggle("on", Number(b.dataset.b) === cur.bank));
  const pick = $("#banks select"); if (pick) pick.value = cur.bank;
  renderProgPick();
  document.querySelectorAll("#programs button").forEach((b) => b.classList.toggle("on", b.dataset.k === slotKey(cur.bank, cur.prog)));
}

// the program dropdown: every slot in the current bank, by name where known
let pickBank = null;
function renderProgPick() {
  const sel = $("#progpick"), b = banks()[cur.bank]; if (!sel || !b) return;
  const known = names();
  const label = (p) => `${pad3(p)} ${known[slotKey(cur.bank, p)] ?? "—"}`;
  if (pickBank !== cur.bank || sel.options.length !== b.count + 1) {
    sel.replaceChildren(...Array.from({ length: b.count }, (_, p) => new Option(label(p), p)),
      new Option(scanningNames ? "reading names…" : `↻ read names (${ageText(namesAge(cur.bank))})`, -1));
    pickBank = cur.bank;
  } else for (let p = 0; p < b.count; p++) sel.options[p].textContent = label(p);
  sel.value = cur.prog;
  sel.title = known[slotKey(cur.bank, cur.prog)] || "programs in this bank";
}

// names for one bank. Readable banks come straight from memory (no sound
// change; Roland reads just the name bytes); ROM banks are stepped through —
// select each slot, read the edit buffer's name — and never change, so that
// scan runs once and is kept. A bank whose every slot reads the same name
// isn't really there (JV expansion slot with no board) and gets hidden.
let scanningNames = false, skipNames = false;
async function readNames(bi, onEach = () => {}) {
  const b = banks()[bi], known = names(), direct = b.dump;
  if (!b.dump && b.bankDump && driver.requestBank) { // U-110: all 64 in one read
    if (!scanningNames || skipNames) return false;
    const slots = await driver.requestBank(bi);
    slots.forEach((sl, p) => { known[slotKey(bi, p)] = sl.name || "(unnamed)"; });
    lsSet(`${schema.id}.names`, JSON.stringify(known)); namesStamp(bi); onEach(b.count);
    return true;
  }
  const got = [];
  for (let p = 0; p < b.count; p++) {
    if (!scanningNames || skipNames) return false;
    let name;
    if (direct) {
      if (driver.requestSlotName) name = await driver.requestSlotName(bi, p);
      else { const r = await driver.requestProgram(bi, p); name = r.name ?? nameParams().map((q) => String.fromCharCode(r.values[q.key] ?? 32)).join("").trim(); }
    } else {
      await driver.programChange(bi, p);
      await new Promise((r) => setTimeout(r, midi.drainMs() + 120));
      if (driver.requestName) name = await driver.requestName();
      else { const { values: v } = await driver.requestPatch(); name = nameParams().map((q) => String.fromCharCode(v[q.key] ?? 32)).join("").trim(); }
    }
    got.push(name);
    known[slotKey(bi, p)] = name || "(unnamed)";
    if (p % 8 === 7) lsSet(`${schema.id}.names`, JSON.stringify(known));
    onEach(p + 1);
  }
  lsSet(`${schema.id}.names`, JSON.stringify(known));
  namesStamp(bi);
  if (!direct) {
    lsSet(`${schema.id}.romScanned.${bi}`, "1");
    if (b.count > 8 && got[0] && got.every((x) => x === got[0])) lsSet(`${schema.id}.absent.${bi}`, "1");
  }
  return true;
}

// the "↻ read names" entry in the program dropdown: just this bank
async function readBankNames(bi) {
  if (scanningNames) { scanningNames = false; return; }
  const b = banks()[bi]; if (!b) return;
  if (!b.dump && JSON.stringify(saved) !== JSON.stringify(values) &&
      !confirm(`Reading ${b.label} names steps the synth through every slot — your unsaved edit will be replaced. Carry on?`)) return;
  const back = { ...cur };
  scanningNames = true; skipNames = false; pickBank = null; renderProgPick();
  try { await readNames(bi, (n) => { if (n % 8 === 0) status(`reading ${b.label} names… ${n}/${b.count}`); }); }
  catch (e) { status(`stopped reading names: ${e.message}`, true); }
  scanningNames = false; pickBank = null;
  if (!b.dump) goProgram(back.bank, back.prog);
  renderProgramList(); renderProgPick();
  status(`read ${b.label} names`);
}

// ---------- rack → connect → edit ----------
let devices = [], view = "rack";
// line drawing of each unit (devices/<id>.svg), inlined so it takes the page colour
const artCache = new Map();
async function art(id) {
  if (!artCache.has(id)) artCache.set(id, fetch(`devices/${id}.svg`).then((r) => (r.ok ? r.text() : "")).catch(() => ""));
  const el = h("div", { class: "art" }); el.innerHTML = await artCache.get(id);
  const svg = el.querySelector("svg"); if (svg) { const hi = svg.cloneNode(true); hi.classList.add("hi"); el.append(hi); } // for the checking sweep
  return el;
}
function setView(v) { view = v; document.body.className = `state-${v}`; }

function rackOrder() {
  let order = []; try { order = JSON.parse(lsGet("rackOrder", "[]")); } catch {}
  const pos = (id) => { const i = order.indexOf(id); return i < 0 ? 1e3 + devices.findIndex((d) => d.id === id) : i; };
  return [...devices].sort((a, b) => pos(a.id) - pos(b.id));
}

async function renderRack({ force = false } = {}) {
  setView("rack");
  $("#synthname").textContent = "";
  const cards = await Promise.all(rackOrder().map(async (d) => {
    const ports = midi.access ? midi.savedPorts(d.id) : {};
    const outName = midi.access && midi.access.outputs.get(ports.out)?.name;
    const inName = midi.access && midi.access.inputs.get(ports.in)?.name;
    let last = "no backup yet";
    try {
      const { backups } = await listBackups(d.id);
      if (backups[0]) last = "backed up " + new Date(backups[0].at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
    } catch {}
    const supported = TRANSPORTS.includes(d.transport);
    const state = h("div", { class: "rstate" }, !supported ? "driver coming" : outName && inName ? h("span", { class: "dots" }, "checking") : "ports not set");
    const go = h("button", { class: "btn", onclick: (e) => { e.stopPropagation(); startConnect(d.id); } }, "connect");
    const card = h("fieldset", { class: `grp rackcard${!supported ? " pending" : outName && inName ? " waiting" : ""}`, draggable: "true", "data-id": d.id, onclick: () => (card.classList.contains("online") || card.classList.contains("untested")) && startConnect(d.id) },
      h("legend", {}, h("span", { class: "rdot" }), d.name),
      await art(d.id),
      h("div", { class: "rinfo" }, state,
        outName ? `${outName} · ch ${lsGet(`${d.id}.ch`, "") || "—"}` : `ch ${lsGet(`${d.id}.ch`, "") || "—"}`, h("br"), last),
      h("div", { class: "rgo" }, go));
    return { d, card, state, ready: supported && !!(outName && inName), ports, supported };
  }));
  $("#rackcards").replaceChildren(...cards.map((c) => c.card));
  cards.forEach((c) => dragCard(c.card));
  probeRack(cards, { force });
}

// drag a card onto another to reorder; the order is kept
let dragging = null;
function dragCard(card) {
  card.addEventListener("dragstart", (e) => { dragging = card; card.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", card.dataset.id); });
  card.addEventListener("dragend", () => {
    card.classList.remove("dragging"); dragging = null;
    lsSet("rackOrder", JSON.stringify([...document.querySelectorAll("#rackcards .rackcard")].map((c) => c.dataset.id)));
  });
  card.addEventListener("dragover", (e) => {
    if (!dragging || dragging === card) return;
    e.preventDefault();
    const r = card.getBoundingClientRect();
    const after = e.clientX > r.left + r.width / 2;
    card.parentNode.insertBefore(dragging, after ? card.nextSibling : card);
  });
}

// last answer from each synth, so coming back to the rack doesn't re-ask;
// older than this (or ↻ check again) and it asks again
const PROBE_FRESH_MS = 15 * 60 * 1000;
function probeCache() { try { return JSON.parse(lsGet("probe", "{}")); } catch { return {}; } }
function rememberProbe(id, ok) { const c = probeCache(); c[id] = { ok: !!ok, at: Date.now() }; lsSet("probe", JSON.stringify(c)); }

function showProbe(c, ok) {
  c.card.classList.remove("waiting", "probing");
  c.card.classList.toggle("online", !!ok); c.card.classList.toggle("offline", !ok);
  c.state.hidden = true; // the dot says it; "ports not set" stays when there's nothing to try
}

// ask each synth on its saved ports whether it's there — one at a time, so
// synths sharing a port (JV / D-110 / TG-55 on 8) don't talk over each other
let probing = 0;
async function probeRack(cards, { force = false } = {}) {
  const run = ++probing;
  const cache = probeCache();
  cards = cards.filter((c) => c.supported);
  const fresh = (c) => !force && cache[c.d.id] && Date.now() - cache[c.d.id].at < PROBE_FRESH_MS && cache[c.d.id].ok !== "untested";
  for (const c of cards) if (c.ready && fresh(c)) showProbe(c, cache[c.d.id].ok);
  const all = cards;
  const summary = () => { const n = all.filter((c) => c.card.classList.contains("online")).length;
    status(`${n} of ${all.length} connected${n ? " — click one to open it" : ""}`); };
  cards = cards.filter((c) => !c.ready || !fresh(c));
  const toCheck = cards.filter((c) => c.ready).length;
  if (!toCheck) { cards.forEach((c) => !c.ready && c.card.classList.add("offline")); return summary(); }
  if (toCheck) status("checking which synths are connected…");
  let online = 0;
  for (const c of cards) {
    if (run !== probing || view !== "rack") return;
    if (!c.ready) { c.card.classList.add("offline"); continue; }
    c.card.classList.add("probing");
    let ok = false;
    try {
      const sch = await (await fetch(`devices/${c.d.id}.json`)).json();
      midi.gapMs = sch.gapMs ?? 2;
      midi.usePorts(c.d.id, c.ports.in, c.ports.out);
      const ch = () => Number(lsGet(`${c.d.id}.ch`, String(sch.defaultChannel ?? 1))) - 1;
      const drv = makeDriver(sch, midi, ch, { get: (k) => lsGet(`${c.d.id}.${k}`, null), set: (k, v) => lsSet(`${c.d.id}.${k}`, v) });
      if (!drv.probe) { c.card.classList.remove("waiting", "probing"); c.card.classList.add("untested"); c.state.hidden = true; continue; }
      ok = await drv.probe().catch(() => false);
    } catch { ok = false; }
    if (run !== probing) return;
    rememberProbe(c.d.id, ok);
    showProbe(c, ok);
    if (ok) online++;
  }
  if (run === probing) summary();
}

async function startConnect(id, { auto = true } = {}) {
  probing++; // stop any rack checks in flight
  await selectDevice(id);
  setView("connect");
  $("#connect-title").textContent = `connect · ${schema.name}`;
  $("#connect-art").replaceWith(Object.assign(await art(id), { id: "connect-art" }));
  $("#csteps").replaceChildren(); $("#ctrouble").hidden = true; $("#connect-retry").hidden = true; $("#connect-skip").hidden = true;
  $("#cprogress").classList.add("idle");
  $("#ctrouble-steps").replaceChildren(...(schema.setup || []).map((x) => h("li", {}, x)));
  const ready = $("#in").value && $("#out").value;
  status(ready ? "connecting…" : "pick the synth's MIDI in + out and its channel, then connect");
  if (ready && auto) runConnect();
}

function step(text) {
  const li = h("li", { class: "run" }, text); $("#csteps").append(li);
  return { ok: (t) => { li.className = "ok"; if (t) li.textContent = t; }, err: (t) => { li.className = "err"; if (t) li.textContent = t; } };
}
function progress(done, total, label) {
  const bar = $("#cprogress"); bar.classList.toggle("idle", !total);
  bar.querySelector(".pfill").style.width = total ? (done / total) * 100 + "%" : "0";
  bar.querySelector(".plabel").textContent = label || "";
}

let connecting = false;
async function runConnect() {
  if (connecting) return; connecting = true;
  $("#csteps").replaceChildren(); $("#ctrouble").hidden = true; $("#connect-retry").hidden = true; progress(0, 0);
  try {
    if (!$("#out").value || !$("#in").value) { status("pick both MIDI ports first", true); return; }
    usePorts(); lsSet(`${schema.id}.ch`, $("#ch").value);
    if (driver.canRead === false) {
      step(`the ${schema.name} can't be asked anything — live controls, preset select and bank capture`).ok();
      pickBank = null; renderProgramControls(); setView("edit");
      status(`${schema.name} · live controls`); return;
    }
    // 1 — is it there?
    const s1 = step(`talking to the ${schema.name}…`);
    try {
      const { values: v } = await driver.requestPatch();
      saved = { ...v }; applyAll(v, { send: false });
      rememberProbe(schema.id, true);
      s1.ok(`${schema.name} is answering${nameParams().length ? ` — “${nameString()}” in the edit buffer` : ""}`);
    } catch (e) {
      rememberProbe(schema.id, false);
      s1.err(`no answer from the ${schema.name} (${e.message})`);
      $("#ctrouble").hidden = false; $("#connect-retry").hidden = false;
      status("check the cables and the synth's settings, then retry", true);
      return;
    }
    // 2 — program names: readable banks every time, ROM banks once ever
    // readable banks: when missing or > 72 h old. ROM banks: once — and a skipped
    // or stopped scan isn't retried for 72 h either (↻ in the dropdown forces one)
    const romTriedAge = (bi) => Date.now() - Number(lsGet(`${schema.id}.romTried.${bi}`, "0"));
    // units with no patch names (EX-8000) have nothing to read
    const todo = !nameParams().length ? [] : navBanks().filter((b) => b.dump || b.bankDump ? namesAge(b.bi) > NAMES_STALE_MS
      : (b.select || b.msb != null || b.lsb != null) && lsGet(`${schema.id}.romScanned.${b.bi}`, "") !== "1" && romTriedAge(b.bi) > NAMES_STALE_MS);
    const total = todo.reduce((t, b) => t + b.count, 0);
    if (total) {
      const haveNames = Object.keys(names()).length > 0;
      $("#connect-skip").hidden = !haveNames; skipNames = false; scanningNames = true;
      const rom = todo.filter((b) => !b.dump && !b.bankDump);
      const s2 = step(`reading program names — ${todo.map((b) => b.label).join(", ")}` + (rom.length ? " (ROM banks are read once: the synth steps through them, then comes back)" : ""));
      const back = { ...cur };
      let done = 0;
      const finished = new Set();
      try {
        for (const b of todo) {
          const ok = await readNames(b.bi, (n) => progress(done + n, total, `${b.label} · ${n} / ${b.count}`));
          done += b.count;
          if (!ok) break;
          finished.add(b.bi);
        }
        s2.ok(skipNames ? "program names — skipped, using the saved ones" : `program names — ${done} read`);
      } catch (e) { s2.err(`program names stopped: ${e.message} — carrying on with what's saved`); }
      // whatever was skipped or stopped waits 72 h before the next automatic try
      for (const b of todo) if (!finished.has(b.bi)) {
        if (b.dump || b.bankDump) namesStamp(b.bi); else lsSet(`${schema.id}.romTried.${b.bi}`, String(Date.now()));
      }
      scanningNames = false; $("#connect-skip").hidden = true;
      if (rom.length) { driver.programChange(back.bank, back.prog); await new Promise((r) => setTimeout(r, midi.drainMs() + 150));
        try { const { values: v } = await driver.requestPatch(); saved = { ...v }; applyAll(v, { send: false }); } catch {} }
    }
    progress(0, 0);
    // 3 — in
    pickBank = null; renderProgramControls(); renderName();
    setView("edit");
    status(`connected · ${nameString() ? `“${nameString()}”` : schema.name}`);
  } finally { connecting = false; }
}

function disconnect() {
  probing++;
  scanningNames = false; skipNames = true;
  noteOff();
  closeSetup();
  renderRack();
  status("pick a synth");
}

function goProgram(bank, prog) {
  if (gestureBefore == null && Object.keys(saved).length && JSON.stringify(saved) !== JSON.stringify(values))
    status("left unsaved edits behind — undo brings them back", true);
  prog = Math.min(prog, (banks()[bank]?.count ?? 128) - 1);
  setCurrent(bank, prog);
  Promise.resolve(driver.programChange(bank, prog))
    .catch((e) => status(e.message, true))
    .then(() => setTimeout(async () => {
      // synths whose edit buffer doesn't follow program changes (TG-55): read the
      // selected voice from its memory slot; everything else: read the edit buffer
      const got = driver.adoptSlot && await driver.adoptSlot(bank, prog).catch(() => null);
      if (!got) return getFromSynth();
      const before = snapshot();
      saved = { ...got.values }; applyAll(got.values, { send: false }); commitUndo(before);
      status(`${slotName(bank, prog)}${nameString() ? ` — “${nameString()}”` : ""}`);
    }, midi.drainMs() + 150));
}

// ◂ ▸ walk straight through the banks: last program of one → first of the next
function stepProgram(dir) {
  const bs = navBanks(); if (!bs.length) return;
  let i = Math.max(0, bs.findIndex((b) => b.bi === cur.bank)), prog = cur.prog + dir;
  if (prog >= bs[i].count) { i = (i + 1) % bs.length; prog = 0; }
  if (prog < 0) { i = (i - 1 + bs.length) % bs.length; prog = bs[i].count - 1; }
  goProgram(bs[i].bi, prog);
}

// the synth announced a bank/program change from its own panel: CC0/CC32 latch, PC lands
let latched = {};
function followProgram(ev) {
  if (ev.type === "cc" && (ev.num === 0 || ev.num === 32)) { latched[ev.num] = ev.val; return true; }
  if (ev.type !== "program") return false;
  const bs = banks();
  let bi = bs.findIndex((b) => !b.backupOnly && (b.msb == null || b.msb === (latched[0] ?? b.msb)) && (b.lsb == null || b.lsb === (latched[32] ?? b.lsb)));
  if (latched[0] == null && latched[32] == null) bi = cur.bank; // no bank select sent: same bank
  setCurrent(bi < 0 ? cur.bank : bi, ev.program); latched = {};
  getFromSynth();
  return true;
}

function renderProgramList() {
  const known = names(), ul = $("#programs");
  ul.replaceChildren();
  if (!Object.keys(known).length) { ul.append(h("li", { class: "dim" }, "create a backup to read the slot names")); return; }
  banks().forEach((b, bi) => {
    if (!b.dump || b.backupOnly) return;
    if (!Array.from({ length: b.count }, (_, p) => known[slotKey(bi, p)]).some(Boolean)) return;
    ul.append(h("li", { class: "bankhead" }, bankName(bi)));
    for (let p = 0; p < b.count; p++) {
      const k = slotKey(bi, p);
      ul.append(h("li", {}, h("button", { "data-k": k, onclick: () => goProgram(bi, p) },
        h("span", { class: "dim" }, pad3(p) + " "), known[k] ?? "…")));
    }
  });
  showCurrent();
}

// ---------- backups ----------
// read every slot (one program dump each — the sound doesn't change) into one
// .syx + a name index in Dropbox; the names also fill the program list
async function createBackup() {
  if (driver.captureBank) return captureBackup();
  if (scanning) { scanning = false; return; }
  const readable = banks().map((b, bi) => ({ ...b, bi })).filter((b) => (b.dump || b.bankDump) && b.write);
  if (!readable.length) return status("this synth can't send its programs over MIDI", true);
  scanning = true;
  const btn = $("#backup"), fillEl = btn.querySelector(".pfill"), label = btn.querySelector(".plabel");
  btn.classList.add("running");
  const progress = (n) => { fillEl.style.width = (n / total) * 100 + "%"; label.textContent = `backing up ${n} / ${total} · click to stop`; };
  const known = names(), slots = [], syx = [];
  const slots_push = (label, p, name) => slots.push({ bank: label, program: p + 1, name: name || "(unnamed)" });
  const total = readable.reduce((t, b) => t + b.count, 0);
  let n = 0, failed = 0;
  progress(0);
  for (const { bi, label, count, dump, bankDump } of readable) for (let p = 0; p < count && scanning; p++) {
    try {
      if (!dump && bankDump && driver.requestBank) { // whole bank at once (U-110)
        const slots = await driver.requestBank(bi);
        slots.forEach((sl, q) => { known[slotKey(bi, q)] = sl.name || "(unnamed)"; slots_push(label, q, sl.name); });
        syx.push(...slots[0].syx); n += count; progress(n); break;
      }
      const got = await driver.requestProgram(bi, p);
      const name = got.name ?? (nameParams().map((q) => String.fromCharCode(got.values[q.key] ?? 32)).join("").trim() || "(unnamed)");
      known[slotKey(bi, p)] = name;
      slots.push({ bank: label, program: p + 1, name });
      syx.push(...got.syx);
    } catch { failed++; if (failed > 3 && n < 5) scanning = false; }
    n++;
    progress(n);
    if (n % 8 === 0) status(`backing up… ${n}/${total}`);
  }
  const finished = n === total;
  scanning = false;
  btn.classList.remove("running");
  label.textContent = "create backup";
  // leave the bar full for a beat on success, then reset
  setTimeout(() => { if (!scanning) fillEl.style.width = "0"; }, finished ? 1500 : 0);
  lsSet(`${schema.id}.names`, JSON.stringify(known));
  if (finished) readable.forEach((b) => namesStamp(b.bi));
  renderProgramList();
  if (!slots.length) return status("the synth isn't answering program requests — check MIDI in + sysex", true);
  if (!finished) return status(`backup stopped at ${n}/${total} — nothing written`, true);
  const at = new Date();
  const stamp = `${schema.name} ${localStamp(at)}`;
  let file;
  try { file = await saveBackup(schema.id, { stamp, at: at.toISOString(), slots, failed, syx }); }
  catch (e) { return status(e.message, true); }
  status(`backed up ${slots.length} programs${failed ? ` (${failed} didn't answer)` : ""} → ${file}`, !!failed);
  refreshBackups();
}

// units that only send their bank when told to on their own panel (G-Force):
// listen, validate every packet, save it like any other backup
let capturing = false;
async function captureBackup() {
  if (capturing) return;
  capturing = true;
  const btn = $("#backup"), fillEl = btn.querySelector(".pfill"), label = btn.querySelector(".plabel");
  btn.classList.add("running"); label.textContent = "waiting — start Utility › User bank to MIDI on the unit";
  try {
    const got = await driver.captureBank((n, of) => { fillEl.style.width = (n / of) * 100 + "%"; label.textContent = `receiving ${n} / ${of}`; });
    const user = banks().findIndex((b) => b.label === "user"), known = names();
    got.names.forEach((nm, i) => { if (user >= 0) known[slotKey(user, i)] = nm || "(unnamed)"; });
    lsSet(`${schema.id}.names`, JSON.stringify(known)); if (user >= 0) namesStamp(user);
    const at = new Date();
    const file = await saveBackup(schema.id, { stamp: `${schema.name} ${localStamp(at)}`, at: at.toISOString(), slots: got.names.map((n, i) => ({ bank: "user", program: i + 1, name: n })), failed: 0, syx: got.syx });
    status(`captured ${got.names.length} presets → ${file}`);
    refreshBackups(); renderProgramList(); pickBank = null; renderProgPick();
  } catch (e) { status(e.message, true); }
  capturing = false; btn.classList.remove("running"); label.textContent = "capture bank";
  setTimeout(() => { fillEl.style.width = "0"; }, 1500);
}

// local date + time for filenames: 2026-09-30 1042
function localStamp(d = new Date()) {
  const p2 = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}${p2(d.getMinutes())}`;
}

// ---------- backups ----------
// run locally (server.mjs) they're written into the Dropbox rack folder. on
// the site there's no server: they download, and this browser keeps a list
let LOCAL = false;
const backupLog = (id) => { try { return JSON.parse(lsGet(`${id}.backups`, "[]")); } catch { return []; } };
function download(name, bytes, type = "application/octet-stream") {
  const a = h("a", { href: URL.createObjectURL(new Blob([bytes], { type })), download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}
const fileSafe = (s) => String(s).replace(/[^\w .\-()+#]/g, "_").trim().slice(0, 80) || "untitled";

async function listBackups(id) {
  if (LOCAL) return (await fetch(`api/backups/${id}`)).json();
  return { dir: "on the web, backups download to this computer — the list is what this browser saved", backups: backupLog(id) };
}

// whole memory: every slot's dump in one .syx (any sysex tool can send it back)
async function saveBackup(id, body) {
  if (LOCAL) {
    const r = await fetch(`api/backups/${id}`, { method: "PUT", body: JSON.stringify(body) });
    if (!r.ok) throw new Error("writing the backup failed: " + (await r.text()));
    return (await r.json()).file;
  }
  const file = fileSafe(body.stamp) + ".syx";
  download(file, new Uint8Array(body.syx));
  lsSet(`${id}.backups`, JSON.stringify([{ file, at: body.at, count: body.slots.length, failed: body.failed }, ...backupLog(id)].slice(0, 20)));
  return file + " (downloaded)";
}

// one slot, just before store overwrites it
async function saveSlotBackup(id, name, body) {
  if (LOCAL) {
    const r = await fetch(`api/backup/${id}/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify(body) });
    if (!r.ok) throw new Error("backup failed: " + (await r.text()));
    return;
  }
  if (body.syx?.length) download(fileSafe(name) + ".syx", new Uint8Array(body.syx));
  else download(fileSafe(name) + ".json", JSON.stringify(body, null, 2), "application/json");
}

async function refreshBackups() {
  const { dir, backups } = await listBackups(schema.id);
  $("#backupdir").textContent = dir;
  $("#backups").replaceChildren(...(backups.length ? backups.map((b) =>
    h("li", {}, b.file, h("span", { class: "dim" }, ` · ${b.count} programs${b.failed ? ` · ${b.failed} missing` : ""}`)))
    : [h("li", { class: "dim" }, "no backups yet")]));
}

// ---------- store to a slot ----------
// overwrites a program on the synth: read the slot first (shows what's being
// replaced + becomes a slot backup in backups/slots/), write, then read it back
let stTarget = null, stOld = null, stSeq = 0;

function openStore() {
  const writable = navBanks().filter((b) => b.write);
  stTarget = writable.some((b) => b.bi === cur.bank) ? { ...cur } : { bank: writable[0].bi, prog: cur.prog };
  // read-only banks show too, disabled — so it's clear why they can't be picked
  $("#st-banks").replaceChildren(...navBanks().map((b) => b.write
    ? h("button", { "data-b": b.bi, onclick: () => { stTarget.bank = b.bi; readTarget(); } }, b.label)
    : h("button", { disabled: true, class: "rom", title: `${b.label} is ROM — it can't be written. Store edits into a writable bank.` }, `${b.label} · rom`)));
  $("#storedlg").showModal();
  readTarget();
}

async function readTarget() {
  const my = ++stSeq;
  document.querySelectorAll("#st-banks button").forEach((b) => b.classList.toggle("on", Number(b.dataset.b) === stTarget.bank));
  $("#st-prog").value = stTarget.prog + 1;
  $("#st-go").disabled = true; stOld = null;
  $("#st-prog").max = banks()[stTarget.bank].count;
  const where = slotName(stTarget.bank, stTarget.prog);
  $("#st-msg").textContent = `reading what's in ${where}…`;
  try {
    const old = await driver.requestProgram(stTarget.bank, stTarget.prog);
    if (my !== stSeq) return;
    stOld = old;
    const oldName = nameParams().map((q) => String.fromCharCode(old.values[q.key] ?? 32)).join("").trim() || "(unnamed)";
    stOld.name = oldName;
    $("#st-msg").innerHTML = "";
    $("#st-msg").append("Write ", h("b", {}, `“${nameString() || "untitled"}”`), ` into ${where}, replacing `, h("b", {}, `“${oldName}”`),
      ". The old one is backed up first.");
    $("#st-go").disabled = false;
  } catch (e) {
    if (my !== stSeq) return;
    $("#st-msg").textContent = `couldn't read ${where} (${e.message}) — not storing without a backup.`;
  }
}

async function doStore() {
  const { bank, prog } = stTarget, where = slotName(bank, prog);
  $("#st-go").disabled = true;
  try {
    $("#st-msg").textContent = "backing up the old program…";
    await saveSlotBackup(schema.id, `${localStamp()} slot ${banks()[bank].label}-${pad3(prog)} ${stOld.name}`,
      { device: schema.id, slot: { bank, prog }, name: stOld.name, values: stOld.values, syx: stOld.syx });

    $("#st-msg").textContent = `writing ${where}…`;
    const sent = await driver.writeProgram(bank, prog, values);
    driver.forgetBank?.();
    await new Promise((res) => setTimeout(res, midi.drainMs() + 400));
    const back = await driver.requestProgram(bank, prog);
    if (!driver.sameProgram(sent, back.data)) throw new Error(`read ${where} back and it doesn't match — check the synth's memory / exclusive protect`);

    const known = names(); known[slotKey(bank, prog)] = nameString() || "(unnamed)";
    lsSet(`${schema.id}.names`, JSON.stringify(known));
    saved = snapshot(); applyAll(values, { send: false });
    renderProgramList();
    $("#storedlg").close();
    status(`stored “${nameString()}” in ${where} — verified · old “${stOld.name}” backed up`);
  } catch (e) {
    $("#st-msg").textContent = e.message;
    $("#st-go").disabled = false;
  }
}

function openSetup() { $("#setup").hidden = false; }
function closeSetup() { $("#setup").hidden = true; }

function usePorts() {
  midi.usePorts(schema.id, $("#in").value, $("#out").value);
  telemetry();
}

// bottom-right readout, like the plugins' [NS-AE] block
function telemetry() {
  const port = midi.output?.name || "no output";
  $("#tele-dev").textContent = `[NS-EDIT] ${schema.name} · ${schema.params.length} params`;
  $("#tele-port").firstChild.textContent = `${port} · ch ${channel() + 1} · ${schema.transport}`;
  $("#conninfo").textContent = `${midi.input?.name || "no input"} → ${port} · ch ${channel() + 1}`;
}

function barcode() {
  const svg = $("#barcode"); let x = 0, out = "";
  while (x < 480) { const w = 1 + Math.floor(Math.random() * 4); if (Math.random() > 0.35) out += `<rect x="${x}" y="0" width="${w}" height="16" fill="#6a6a6a"/>`; x += w + 1 + Math.floor(Math.random() * 3); }
  svg.innerHTML = out;
}

function doUndo() { if (!undo.length) return; redo.push(snapshot()); applyAll(undo.pop()); status("undo"); }
function doRedo() { if (!redo.length) return; undo.push(snapshot()); applyAll(redo.pop()); status("redo"); }
function toggleCompare() {
  if (compareSnapshot) { applyAll(compareSnapshot); compareSnapshot = null; $("#ab").classList.remove("on"); status("back to your edit"); }
  else { if (!Object.keys(saved).length) return status("nothing read from the synth yet to compare against — hit get", true);
    compareSnapshot = snapshot(); applyAll(saved); $("#ab").classList.add("on"); status("hearing the version on the synth — press again to return"); }
}

// computer keyboard plays notes (a–k row, z/x octave); space holds; l = setup
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("#setup").hidden) { e.preventDefault(); return closeSetup(); }
  if (view !== "edit") return;
  if (e.target.matches("input[type=text], input:not([type]), select") || e.metaKey || e.ctrlKey) {
    if ((e.metaKey || e.ctrlKey) && e.key === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
    return;
  }
  if (e.repeat) return;
  if (e.key === " ") { e.preventDefault(); return heldNote != null ? noteOff() : noteOn(12 * octave + 12); }
  if (e.key === "z") { octave = Math.max(0, octave - 1); return status(`octave ${octave}`); }
  if (e.key === "x") { octave = Math.min(8, octave + 1); return status(`octave ${octave}`); }
  if (e.key === "l") return $("#setup").hidden ? openSetup() : closeSetup();
  if (e.key === "[") return stepProgram(-1);
  if (e.key === "]") return stepProgram(1);
  if (e.key in KEYS) noteOn(12 * octave + 12 + KEYS[e.key]);
});
addEventListener("keyup", (e) => {
  if (e.key in KEYS && heldNote === 12 * octave + 12 + KEYS[e.key]) noteOff();
});

boot();
