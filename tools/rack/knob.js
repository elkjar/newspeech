// Knob — the plugins' anatomy (vibe/slice): grey ring, light 270° value arc
// (bipolar fills from centre), white tick; label underneath. No number at
// rest — the label turns into the value while you hover or drag, and the LCD
// shows it too. Enum params (destinations, sources…) keep their value visible
// as a borderless <select>: click it to jump straight to an option.
// Vertical drag (shift = fine), wheel = one step, double-click = saved value.

const SVGNS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs) => {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
};

export function createKnob({ size = 46, label, onBegin, onChange, onEnd, onReset, onHover, fmt }) {
  const cell = document.createElement("div");
  cell.className = "cell kcell";
  const s = size, cx = s / 2, cy = s / 2, r = s * 0.4;
  const svg = svgEl("svg", { width: s, height: s, viewBox: `0 0 ${s} ${s}` });
  const ring = svgEl("circle", { cx, cy, r, fill: "none", class: "kring" });
  const arc = svgEl("path", { fill: "none", class: "karc" });
  const tick = svgEl("line", { class: "ktick" });
  svg.append(ring, arc, tick);

  const lab = document.createElement("span");
  lab.className = "clabel";
  lab.textContent = label;
  cell.append(svg, lab);

  let param = null, value = 0, pick = null, dragging = false, hovering = false;

  function draw() {
    if (!param) return;
    const v = (value - param.min) / (param.max - param.min || 1);
    const deg = -135 + 270 * v, rad = (deg * Math.PI) / 180;
    const inner = r * 0.35;
    tick.setAttribute("x1", cx + inner * Math.sin(rad)); tick.setAttribute("y1", cy - inner * Math.cos(rad));
    tick.setAttribute("x2", cx + r * Math.sin(rad));     tick.setAttribute("y2", cy - r * Math.cos(rad));
    const bip = param.display === "bipolar";
    const startDeg = bip ? 0 : -135, startRad = (startDeg * Math.PI) / 180;
    const show = bip ? Math.abs(v - 0.5) > 0.002 : v > 0.001;
    arc.setAttribute("visibility", show ? "visible" : "hidden");
    if (show) arc.setAttribute("d",
      `M ${cx + r * Math.sin(startRad)} ${cy - r * Math.cos(startRad)} ` +
      `A ${r} ${r} 0 ${Math.abs(deg - startDeg) > 180 ? 1 : 0} ${deg >= startDeg ? 1 : 0} ` +
      `${cx + r * Math.sin(rad)} ${cy - r * Math.cos(rad)}`);
    if (pick) pick.value = value;
    lab.textContent = (dragging || hovering) && !pick ? fmt(param, value) : label;
    cell.classList.toggle("live", (dragging || hovering) && !pick);
  }

  function setParam(p) {
    param = p;
    svg.setAttribute("aria-label", p.name);
    pick?.remove(); pick = null;
    if (p.options && p.options.length > 2) {
      pick = document.createElement("select");
      pick.className = "cvalue";
      p.options.forEach((o, i) => pick.append(new Option(o, p.min + i)));
      pick.onchange = () => { onBegin(); set(Number(pick.value), true); onEnd(); };
      cell.append(pick);
    }
    draw();
  }

  function set(v, fromUser = false) {
    v = Math.max(param.min, Math.min(param.max, Math.round(v)));
    const changed = v !== value;
    value = v;
    draw();
    if (fromUser && changed) onChange(v);
    if (fromUser || hovering) onHover?.(param, value);
  }

  // full range over ~220px (at least 3px per step so stepped params don't skip)
  svg.addEventListener("pointerdown", (e) => {
    if (!param) return;
    e.preventDefault();
    svg.setPointerCapture(e.pointerId);
    onBegin();
    dragging = true; draw();
    const pxPerStep = Math.max(3, 220 / (param.max - param.min));
    let lastY = e.clientY, acc = value;
    const move = (ev) => {
      const dy = lastY - ev.clientY; lastY = ev.clientY;
      acc = Math.max(param.min, Math.min(param.max, acc + (dy / pxPerStep) * (ev.shiftKey ? 0.15 : 1)));
      set(acc, true);
    };
    const up = () => {
      svg.removeEventListener("pointermove", move); svg.removeEventListener("pointerup", up);
      dragging = false; draw(); onEnd();
    };
    svg.addEventListener("pointermove", move);
    svg.addEventListener("pointerup", up);
  });
  svg.addEventListener("pointerenter", () => { hovering = true; draw(); onHover?.(param, value); });
  svg.addEventListener("pointerleave", () => { hovering = false; draw(); });
  svg.addEventListener("wheel", (e) => {
    if (!param) return;
    e.preventDefault();
    onBegin(); set(value + (e.deltaY < 0 ? 1 : -1), true); onEnd();
  }, { passive: false });
  svg.addEventListener("dblclick", () => onReset?.());

  return {
    el: cell,
    setParam,
    set: (v) => set(v, false),
    flash() { cell.classList.remove("rx"); void cell.offsetWidth; cell.classList.add("rx"); },
    setChanged(on) { cell.classList.toggle("changed", on); },
  };
}
