// tool-viz.js — the live miniatures of the newspeech tools: one canvas draw
// function per tool (texture, slice, decay, drone, glitch, stretch), plus
// samples, visuals and sequence. the homepage cards + sequence vignette and
// the tools index draw from here.
//
// usage: NSToolViz.register(canvas, name, { observe?, vignette? }).
// the canvas is sized from its css box (ResizeObserver) and only renders
// while `observe` (default: the canvas) is on-screen. `vignette: true` =
// the canvas sits under a full-screen vignette whose copy covers the lower
// half on narrow screens — the sequence grid biases up there.
(function () {
  "use strict";

  // ---- intensity envelope: slow LFO + mouse activity (same as the pages) ----
  let mouseActivity = 0;
  let lastMX = -1, lastMY = -1;
  window.addEventListener("mousemove", (e) => {
    if (lastMX >= 0) mouseActivity = Math.min(1, mouseActivity + Math.hypot(e.clientX - lastMX, e.clientY - lastMY) * 0.004);
    lastMX = e.clientX;
    lastMY = e.clientY;
  });
  function intensity() {
    const t = performance.now();
    const sum = 0.5
      + 0.25 * Math.sin(t / 17000)
      + 0.18 * Math.sin(t / 31000)
      + 0.12 * Math.sin(t / 47000);
    return Math.max(0, Math.min(1, sum + mouseActivity * 0.4));
  }

  // ---- 02 sequence: 16×8 step grid, sweeping playhead, cells mutating ----
  function drawSeqViz(v, t, dt) {
    const { ctx: c, w, h, state } = v;
    const COLS = 16, ROWS = 8;
    if (!state.cells) {
      state.cells = [];
      for (let r = 0; r < ROWS; r++) {
        const row = [];
        const density = r === 0 ? 0.45 : 0.15 + Math.random() * 0.25;
        for (let col = 0; col < COLS; col++) {
          row.push(Math.random() < density ? 0.25 + Math.random() * 0.35 : 0);
        }
        state.cells.push(row);
      }
      state.step = 0;
      state.acc = 0;
      state.pulse = 0;
    }
    const stepDur = 60 / 124 / 4; // 124bpm sixteenths
    state.acc += dt;
    while (state.acc >= stepDur) {
      state.acc -= stepDur;
      state.step = (state.step + 1) % COLS;
      state.pulse = 1;
      // mutation: occasionally flip a cell on/off
      if (Math.random() < 0.22) {
        const r = (Math.random() * ROWS) | 0;
        const col = (Math.random() * COLS) | 0;
        state.cells[r][col] = state.cells[r][col] ? 0 : 0.25 + Math.random() * 0.35;
      }
    }
    state.pulse *= Math.pow(0.001, dt);

    c.clearRect(0, 0, w, h);
    // full vignette: the copy panel sits over the lower half of a narrow
    // canvas — bias the grid up there. cards center it.
    const up = v.vignette && w < 720;
    const cs = Math.min((w * (v.vignette && !up ? 0.72 : 0.84)) / COLS, (h * 0.62) / ROWS);
    const gap = cs * 0.18;
    const gw = COLS * cs, gh = ROWS * cs;
    const gx = (w - gw) / 2, gy = (up ? h * 0.26 : h / 2 + 6) - gh / 2; // +6: room for the readout

    c.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    c.textBaseline = "alphabetic";
    c.textAlign = "left";
    c.fillStyle = "rgba(255, 255, 255, 0.35)";
    c.fillText(`bank 03 · scene a · ${String(state.step + 1).padStart(2, "0")}/16`, gx, gy - 16);

    // playhead column
    c.fillStyle = "rgba(255, 255, 255, 0.05)";
    c.fillRect(gx + state.step * cs, gy - cs * 0.35, cs, gh + cs * 0.7);

    for (let r = 0; r < ROWS; r++) {
      for (let col = 0; col < COLS; col++) {
        const x = gx + col * cs, y = gy + r * cs;
        const a = state.cells[r][col];
        const size = cs - gap;
        if (a > 0) {
          c.fillStyle = col === state.step
            ? `rgba(255, 255, 255, ${(0.55 + 0.45 * state.pulse).toFixed(3)})`
            : `rgba(255, 255, 255, ${a.toFixed(3)})`;
          c.fillRect(x + gap / 2, y + gap / 2, size, size);
        } else {
          c.strokeStyle = "rgba(255, 255, 255, 0.10)";
          c.lineWidth = 1;
          c.strokeRect(x + gap / 2 + 0.5, y + gap / 2 + 0.5, size - 1, size - 1);
        }
      }
    }
  }

  // ---- 03 visuals: index-sheet of six live micro-tiles, one per visualizer
  // family. tiles keep trails via per-tile fade fills instead of a full clear ----
  const TILE_GAP = 14;
  const drawTile = {
    streaks(c, T, t, dt, env) {
      const n = 14;
      for (let i = 0; i < n; i++) {
        const y = T.y + Math.random() * T.h;
        const x = T.x + Math.random() * T.w * 0.7;
        const len = 10 + Math.random() * T.w * 0.5;
        const a = Math.pow(Math.random(), 3) * 0.5 + 0.02;
        c.fillStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
        c.fillRect(x, y, len, 1);
      }
    },
    grid(c, T, t, dt, env) {
      c.fillStyle = "rgba(5, 5, 5, 0.5)";
      c.fillRect(T.x, T.y, T.w, T.h);
      const sp = 7;
      const off = (t * 0.004) % sp;
      c.strokeStyle = "rgba(255, 255, 255, 0.30)";
      c.lineWidth = 1;
      c.beginPath();
      for (let y = T.y; y < T.y + T.h; y += sp) { c.moveTo(T.x, y); c.lineTo(T.x + T.w, y); }
      c.stroke();
      c.save();
      c.translate(T.x + T.w / 2, T.y + T.h / 2);
      c.rotate(0.05 + 0.12 * Math.sin(t / 9000 + T.seed));
      c.translate(-(T.x + T.w / 2), -(T.y + T.h / 2));
      c.beginPath();
      for (let y = T.y - T.h; y < T.y + T.h * 2; y += sp) { c.moveTo(T.x - T.w, y + off); c.lineTo(T.x + T.w * 2, y + off); }
      c.stroke();
      c.restore();
    },
    rings(c, T, t, dt, env) {
      if (Math.random() < dt * (0.8 + 2 * env)) T.rings.push({ r: 2 });
      const maxR = Math.hypot(T.w, T.h) / 2;
      c.lineWidth = 1;
      for (let i = T.rings.length - 1; i >= 0; i--) {
        const R = T.rings[i];
        R.r += (14 + 40 * env) * dt;
        const a = Math.max(0, 1 - R.r / maxR) * 0.6;
        if (a <= 0.01) { T.rings.splice(i, 1); continue; }
        c.strokeStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
        c.beginPath();
        c.arc(T.x + T.w / 2, T.y + T.h / 2, R.r, 0, Math.PI * 2);
        c.stroke();
      }
    },
    stars(c, T, t, dt, env) {
      if (!T.particles) {
        T.particles = [];
        for (let i = 0; i < 40; i++) {
          T.particles.push({ x: Math.random(), y: Math.random(), z: 0.05 + Math.random() * 0.95 });
        }
      }
      c.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      c.textAlign = "center";
      c.textBaseline = "middle";
      for (const p of T.particles) {
        p.z -= dt * (0.10 + 0.25 * env);
        if (p.z <= 0.03) { p.x = Math.random(); p.y = Math.random(); p.z = 1; }
        const px = T.x + T.w / 2 + ((p.x - 0.5) / p.z) * T.w * 0.5;
        const py = T.y + T.h / 2 + ((p.y - 0.5) / p.z) * T.h * 0.5;
        if (px < T.x || px > T.x + T.w || py < T.y || py > T.y + T.h) continue;
        const ch = ".,+*oO#"[Math.min(6, ((1 - p.z) * 7) | 0)];
        c.fillStyle = `rgba(255, 255, 255, ${Math.min(1, 1.1 - p.z).toFixed(3)})`;
        c.fillText(ch, px, py);
      }
    },
    swarm(c, T, t, dt, env) {
      if (!T.particles) {
        T.particles = [];
        for (let i = 0; i < 160; i++) {
          T.particles.push({
            x: Math.random() * T.w,
            y: Math.random() * T.h,
            dir: ((Math.random() * 8) | 0) * Math.PI / 4,
            turn: 0,
          });
        }
      }
      const sp = 26 + 50 * env;
      c.fillStyle = "rgba(230, 230, 230, 0.7)";
      for (const p of T.particles) {
        p.turn -= dt;
        if (p.turn <= 0) {
          p.dir = ((Math.random() * 8) | 0) * Math.PI / 4;
          p.turn = 0.1 + Math.random() * 0.5;
        }
        p.x += Math.cos(p.dir) * sp * dt;
        p.y += Math.sin(p.dir) * sp * dt;
        if (p.x < 0) p.x += T.w; else if (p.x >= T.w) p.x -= T.w;
        if (p.y < 0) p.y += T.h; else if (p.y >= T.h) p.y -= T.h;
        c.fillRect(T.x + p.x, T.y + p.y, 1, 1);
      }
    },
    chevron(c, T, t, dt, env) {
      if (!T.particles) T.particles = [{ t: 0.2 }, { t: 0.55 }, { t: 0.85 }];
      c.lineWidth = 1.5;
      for (const ch of T.particles) {
        ch.t += dt * 0.25 * (0.6 + 0.8 * env);
        if (ch.t >= 1) ch.t = 0;
        const fade = Math.min(ch.t / 0.12, (1 - ch.t) / 0.15, 1);
        const vx = T.x + T.w * (0.15 + 0.75 * ch.t);
        const vy = T.y + T.h / 2;
        const ang = (30 + 40 * ch.t) * Math.PI / 180;
        const dx = Math.cos(ang) * T.w, dy = Math.sin(ang) * T.w;
        c.strokeStyle = `rgba(255, 255, 255, ${(0.8 * fade).toFixed(3)})`;
        c.beginPath();
        c.moveTo(vx - dx, vy - dy);
        c.lineTo(vx, vy);
        c.lineTo(vx - dx, vy + dy);
        c.stroke();
      }
    },
  };
  function drawVisualsViz(v, t, dt) {
    const { ctx: c, w, h, state } = v;
    if (!state.tiles) {
      const kinds = ["streaks", "grid", "rings", "stars", "swarm", "chevron"];
      const cols = w >= h ? 3 : 2;
      const rows = Math.ceil(kinds.length / cols);
      const tw = (w * 0.9) / cols;
      const th = (h * 0.84) / rows;
      const ox = (w - tw * cols) / 2;
      const oy = (h - th * rows) / 2;
      state.tiles = kinds.map((kind, i) => ({
        kind,
        x: ox + (i % cols) * tw + TILE_GAP / 2,
        y: oy + ((i / cols) | 0) * th + TILE_GAP / 2,
        w: tw - TILE_GAP,
        h: th - TILE_GAP,
        seed: Math.random() * 1000,
        particles: null,
        rings: [],
      }));
    }
    const env = intensity();
    c.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    for (const T of state.tiles) {
      c.save();
      c.beginPath();
      c.rect(T.x, T.y, T.w, T.h);
      c.clip();
      c.fillStyle = "rgba(5, 5, 5, 0.30)";
      c.fillRect(T.x, T.y, T.w, T.h);
      drawTile[T.kind](c, T, t, dt, env);
      c.restore();
      c.strokeStyle = "rgba(255, 255, 255, 0.18)";
      c.lineWidth = 1;
      c.strokeRect(T.x + 0.5, T.y + 0.5, T.w - 1, T.h - 1);
      c.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
      c.textAlign = "left";
      c.textBaseline = "alphabetic";
      c.fillStyle = "rgba(255, 255, 255, 0.4)";
      c.fillText(T.kind, T.x + 8, T.y + T.h - 8);
    }
  }

  // ---- 04 samples: sliced kit waveform, sweeping playhead, retrigger jumps ----
  function drawSamplesViz(v, t, dt) {
    const { ctx: c, w, h, state } = v;
    const x0 = w * 0.06, x1 = w * 0.94;
    if (!state.wave) {
      const N = Math.max(300, Math.floor(x1 - x0)); // one sample per pixel column
      const NOTES = ["C1", "E1", "Gs1", "C2", "E2", "Gs2", "C3", "E3"];
      const wave = new Float32Array(N);
      const slices = [];
      const per = N / NOTES.length;
      for (let s = 0; s < NOTES.length; s++) {
        const start = Math.floor(s * per + per * 0.06);
        slices.push({ i: start, label: `kit-${NOTES[s]}.wav`, flash: 0 });
        const len = Math.floor(per * (0.45 + Math.random() * 0.4));
        const decay = 3 + Math.random() * 4;
        const tone = 0.02 + Math.random() * 0.10;
        for (let k = 0; k < len && start + k < N; k++) {
          const p = k / len;
          const envA = Math.min(1, k / (len * 0.02 + 1)) * Math.exp(-p * decay);
          wave[start + k] = (Math.sin(k * tone * Math.PI * 2) * 0.6 + (Math.random() * 2 - 1) * 0.4) * envA;
        }
      }
      state.wave = wave;
      state.slices = slices;
      state.head = 0;
      state.headSpeed = N / 14; // full sweep ~14s at env=0.5
    }
    const env = intensity();
    const N = state.wave.length;

    const lastHead = state.head;
    state.head += state.headSpeed * (0.5 + env) * dt;
    if (state.head >= N) state.head -= N;
    // occasional retrigger: jump the playhead to a random slice start
    if (Math.random() < dt * (0.06 + 0.25 * env)) {
      const s = state.slices[(Math.random() * state.slices.length) | 0];
      state.head = s.i;
      s.flash = 1;
    }
    for (const s of state.slices) {
      if (lastHead <= s.i && state.head > s.i) s.flash = 1;
      s.flash *= Math.pow(0.01, dt);
    }

    c.clearRect(0, 0, w, h);
    const midY = h / 2 + 8; // +8: the slice labels ride above
    const amp = h * 0.22;
    const px = (i) => x0 + (i / N) * (x1 - x0);

    for (let i = 0; i < N; i++) {
      const val = Math.abs(state.wave[i]);
      if (val < 0.004) continue;
      c.fillStyle = i < state.head ? "rgba(255, 255, 255, 0.55)" : "rgba(255, 255, 255, 0.22)";
      c.fillRect(px(i), midY - val * amp, (x1 - x0) / N + 0.5, val * amp * 2);
    }
    c.fillStyle = "rgba(255, 255, 255, 0.12)";
    c.fillRect(x0, midY, x1 - x0, 1);

    c.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    let labelEnd = -Infinity;
    for (let si = 0; si < state.slices.length; si++) {
      const s = state.slices[si];
      const x = px(s.i);
      c.fillStyle = `rgba(255, 255, 255, ${(0.3 + 0.7 * s.flash).toFixed(3)})`;
      c.fillRect(x, midY - amp - 26, 1, amp * 2 + 40);
      // thin the labels out wherever one would run into the last one drawn
      if (x + 5 < labelEnd + 12) continue;
      labelEnd = x + 5 + c.measureText(s.label).width;
      c.fillStyle = `rgba(255, 255, 255, ${(0.35 + 0.6 * s.flash).toFixed(3)})`;
      c.fillText(s.label, x + 5, midY - amp - 30);
    }

    const hx = px(state.head);
    c.fillStyle = "rgba(255, 255, 255, 0.9)";
    c.fillRect(hx, midY - amp - 34, 1, amp * 2 + 60);
  }

  // ---- 02 texture: loop waveform with a live selection window, wrapping
  // playhead (occasionally reversing — the vari-speed tape), grain-cloud
  // flashes around the head, and the ms-precision selection readout ----
  function drawTextureViz(v, t, dt) {
    const { ctx: c, w, h, state } = v;
    const x0 = w * 0.07, x1 = w * 0.93;
    if (!state.wave) {
      const N = Math.max(300, Math.floor(x1 - x0));
      const wave = new Float32Array(N);
      for (let i = 0; i < N; i++) {
        const p = i / N;
        const envA = 0.3 + 0.7 * Math.abs(Math.sin(p * Math.PI * 3.3 + 0.4));
        wave[i] = (Math.sin(i * 0.11) * 0.45 + Math.sin(i * 0.021) * 0.3
          + (Math.random() * 2 - 1) * 0.3) * envA;
      }
      state.wave = wave;
      state.selA = 0.30;
      state.selB = 0.62;
      state.pos = 0; // 0..1 within the selection
      state.dir = 1;
      state.rate = 0.16; // selection-fractions per second
      state.grains = []; // {f (file frac), age, life}
      state.dur = 3.2 + Math.random() * 2.4; // fake file length, seconds
    }
    const env = intensity();

    // re-drag the selection now and then — snap, no tween (page vocabulary)
    if (Math.random() < dt * (0.08 + 0.16 * env)) {
      const width = 0.14 + Math.random() * 0.38;
      const start = Math.random() * (1 - width);
      state.selA = start;
      state.selB = start + width;
    }
    // rare thru-zero flip — the tape reverses
    if (Math.random() < dt * 0.10) state.dir = -state.dir;

    state.pos += state.dir * state.rate * (0.5 + 0.9 * env) * dt / (state.selB - state.selA);
    state.pos -= Math.floor(state.pos); // wrap 0..1

    // grain spawns cluster near the head, scattering wider with intensity
    if (Math.random() < dt * (5 + 14 * env)) {
      let f = state.selA + state.pos * (state.selB - state.selA)
        + (Math.random() - 0.5) * 0.35 * (state.selB - state.selA);
      if (f < state.selA) f += state.selB - state.selA;
      if (f > state.selB) f -= state.selB - state.selA;
      state.grains.push({ f, age: 0, life: 0.25 + Math.random() * 0.45 });
    }

    c.clearRect(0, 0, w, h);
    const midY = h / 2 - 6; // -6: the selection readout sits under
    const amp = h * 0.22;
    const N = state.wave.length;
    const px = (f) => x0 + f * (x1 - x0);

    // waveform — bright inside the selection, dim outside
    for (let i = 0; i < N; i++) {
      const val = Math.abs(state.wave[i]);
      if (val < 0.004) continue;
      const f = i / N;
      const inside = f >= state.selA && f <= state.selB;
      c.fillStyle = inside ? "rgba(255, 255, 255, 0.55)" : "rgba(255, 255, 255, 0.14)";
      c.fillRect(px(f), midY - val * amp, (x1 - x0) / N + 0.5, val * amp * 2);
    }

    // selection edges + grip tabs
    c.fillStyle = "rgba(255, 255, 255, 0.8)";
    for (const f of [state.selA, state.selB]) {
      const x = px(f);
      c.fillRect(x, midY - amp - 22, 1, amp * 2 + 44);
      c.fillRect(x - 4, midY - 1, 8, 2);
    }

    // grain cloud — parabolic-window flashes
    for (let i = state.grains.length - 1; i >= 0; i--) {
      const g = state.grains[i];
      g.age += dt;
      if (g.age >= g.life) { state.grains.splice(i, 1); continue; }
      const tt = g.age / g.life;
      const a = 4 * tt * (1 - tt) * 0.30;
      c.fillStyle = `rgba(255, 255, 255, ${a.toFixed(3)})`;
      c.fillRect(px(g.f) - 3, midY - amp - 10, 6, amp * 2 + 20);
    }

    // playhead + direction caret
    const hf = state.selA + state.pos * (state.selB - state.selA);
    const hx = px(hf);
    c.fillStyle = "rgba(255, 255, 255, 0.95)";
    c.fillRect(hx, midY - amp - 30, 1, amp * 2 + 52);
    c.beginPath();
    c.moveTo(hx + state.dir * 6, midY - amp - 24);
    c.lineTo(hx, midY - amp - 30);
    c.lineTo(hx, midY - amp - 18);
    c.closePath();
    c.fill();

    // selection readout, the tool's ms-precision line
    c.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    c.fillStyle = "rgba(255, 255, 255, 0.4)";
    const secs = (f) => (f * state.dur).toFixed(3);
    const readout = `${secs(state.selA)}s – ${secs(state.selB)}s · ${secs(state.selB - state.selA)}s · ${state.dir < 0 ? "−" : "+"}1x`;
    // follows the selection but never runs off the card's right edge
    const rx = Math.min(px(state.selA), w - c.measureText(readout).width - 10);
    c.fillText(readout, Math.max(10, rx), midY + amp + 34);
  }

  // ---- 03 slice: NEWSPEECH as a morse lane over a beat grid — playhead
  // sweeps, hits light, and the message scrambles a letter at a time until a
  // restore snaps it back (the tool's decay/RESTORE loop) ----
  const SLICE_MORSE = {
    A: ".-", B: "-...", C: "-.-.", D: "-..", E: ".", F: "..-.", G: "--.",
    H: "....", I: "..", J: ".---", K: "-.-", L: ".-..", M: "--", N: "-.",
    O: "---", P: ".--.", Q: "--.-", R: ".-.", S: "...", T: "-", U: "..-",
    V: "...-", W: ".--", X: "-..-", Y: "-.--", Z: "--..",
  };
  const SLICE_MSG = "NEWSPEECH";
  function drawSliceViz(v, t, dt) {
    const { ctx: c, w, h, state } = v;
    if (!state.pat) {
      state.shown = [...SLICE_MSG];
      state.pass = 1;
      state.pos = 0;
      state.compile = () => {
        const evs = [], span = [];
        let u = 0;
        for (let ci = 0; ci < state.shown.length; ci++) {
          const code = SLICE_MORSE[state.shown[ci]] || ".";
          const s = u;
          for (let i = 0; i < code.length; i++) {
            const d = code[i] === "-" ? 3 : 1;
            evs.push({ u, d, dah: d > 1, ci });
            u += d;
            if (i < code.length - 1) u += 1;
          }
          span.push([s, u]);
          u += 3;
        }
        state.pat = { evs, span, total: u + 4 };
      };
      state.compile();
    }
    const env = intensity();
    state.pos += dt * (6 + 5 * env); // units per second — the clock breathes
    if (state.pos >= state.pat.total) {
      state.pos -= state.pat.total;
      state.pass++;
      // the mangle: scramble one letter per pass; past four, RESTORE
      const bad = state.shown.reduce((a, ch, i) => a + (ch !== SLICE_MSG[i] ? 1 : 0), 0);
      if (bad >= 4) {
        state.shown = [...SLICE_MSG];
      } else if (Math.random() < 0.7) {
        const i = (Math.random() * state.shown.length) | 0;
        state.shown[i] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[(Math.random() * 26) | 0];
      }
      state.compile();
      state.pos = Math.min(state.pos, state.pat.total - 0.001);
    }
    const { evs, span, total } = state.pat;

    c.clearRect(0, 0, w, h);
    const laneW = w * 0.88;
    const lx = (w - laneW) / 2;
    const ly = h / 2 + 18; // the letters + readout ride above the lane
    const dahH = Math.min(110, h * 0.18);
    const ditH = dahH * 0.55;
    const uW = laneW / total;

    // clock caption
    c.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    c.fillStyle = "rgba(255, 255, 255, 0.35)";
    c.fillText(`140bpm · 1/16 · pass ${String(state.pass).padStart(2, "0")}`, lx, ly - dahH * 0.5 - 58);

    // beat grid: hairline per beat (4 units), brighter per bar
    for (let b = 0; b <= total; b += 4) {
      c.fillStyle = b % 16 === 0 ? "rgba(255, 255, 255, 0.14)" : "rgba(255, 255, 255, 0.05)";
      c.fillRect(lx + b * uW, ly - dahH * 0.85, 1, dahH * 1.7);
    }

    // the message, letters over their own morse; corrupted letters struck
    c.font = `13px ui-monospace, SFMono-Regular, Menlo, monospace`;
    c.textAlign = "center";
    let litCi = -1;
    for (const ev of evs) {
      if (state.pos >= ev.u && state.pos < ev.u + ev.d) { litCi = ev.ci; break; }
    }
    for (let ci = 0; ci < state.shown.length; ci++) {
      const [a, b] = span[ci];
      const x = lx + ((a + b) / 2) * uW;
      const bad = state.shown[ci] !== SLICE_MSG[ci];
      c.fillStyle = ci === litCi ? "rgba(255, 255, 255, 0.95)"
        : bad ? "rgba(255, 255, 255, 0.85)" : "rgba(255, 255, 255, 0.4)";
      c.fillText(state.shown[ci], x, ly - dahH * 0.5 - 22);
      if (bad) c.fillRect(x - 7, ly - dahH * 0.5 - 27, 14, 1.5);
    }

    // the blocks
    for (const ev of evs) {
      const x = lx + ev.u * uW;
      const bw = Math.max(2, ev.d * uW - 2);
      const bh = ev.dah ? dahH : ditH;
      const active = state.pos >= ev.u && state.pos < ev.u + ev.d;
      c.fillStyle = `rgba(255, 255, 255, ${active ? 0.95 : 0.38})`;
      c.fillRect(x, ly - bh / 2, bw, bh);
    }

    // playhead
    c.fillStyle = "#fff";
    c.fillRect(lx + state.pos * uW, ly - dahH * 0.85, 1.5, dahH * 1.7);
  }

  // ---- 04 decay: a loop's waveform eroding in place — a positional wear map
  // deepens the same wounds every pass (rich-get-richer + spread, the tool's
  // actual algorithm in miniature); a faint ghost of the original stays put;
  // when the tape dies it re-seeds with fresh oxide ----
  function drawDecayViz(v, t, dt) {
    const { ctx: c, w, h, state } = v;
    const COLS = 140;
    if (!state.peaks) {
      // a fake loop: smoothed random amplitude envelope, symmetric bars
      state.peaks = new Float32Array(COLS);
      let a = 0.5;
      for (let i = 0; i < COLS; i++) {
        a += (Math.random() - 0.5) * 0.3;
        a = Math.min(1, Math.max(0.12, a * 0.97 + 0.02));
        state.peaks[i] = a * (0.55 + 0.45 * Math.sin((i / COLS) * Math.PI * 2 + 1));
      }
      state.wear = new Float32Array(COLS);
      state.pass = 1;
      state.pos = 0;
    }
    const env = intensity();
    state.pos += dt / (5.5 - 2 * env); // seconds per pass — breathes with the room
    if (state.pos >= 1) {
      state.pos -= 1;
      state.pass++;
      // evolve wear: a few hits, most-damaged-of-4 wins, then neighbor spread
      for (let k = 0; k < 5; k++) {
        let idx = (Math.random() * COLS) | 0;
        if (Math.random() < 0.65) {
          for (let cnd = 0; cnd < 3; cnd++) {
            const j = (Math.random() * COLS) | 0;
            if (state.wear[j] > state.wear[idx]) idx = j;
          }
        }
        state.wear[idx] = Math.min(1, state.wear[idx] + 0.08 + 0.1 * Math.random());
      }
      for (let i = 0; i < COLS; i++) {
        const nb = Math.max(state.wear[(i + COLS - 1) % COLS], state.wear[(i + 1) % COLS]);
        if (nb > state.wear[i]) state.wear[i] += (nb - state.wear[i]) * 0.1;
      }
      // dead tape → fresh oxide
      let health = 0;
      for (let i = 0; i < COLS; i++) health += Math.pow(1 - state.wear[i], 3);
      if (health / COLS < 0.06) {
        state.wear = new Float32Array(COLS);
        state.pass = 1;
      }
    }

    c.clearRect(0, 0, w, h);
    const laneW = w * 0.88;
    const lx = (w - laneW) / 2;
    const ly = h / 2 + 8;
    const amp = Math.min(120, h * 0.24);
    const cw = laneW / COLS + 0.5;

    let health = 0;
    for (let i = 0; i < COLS; i++) health += Math.pow(1 - state.wear[i], 3);
    health /= COLS;

    // caption, same register as the tool's readout
    c.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    c.fillStyle = "rgba(255, 255, 255, 0.35)";
    c.fillText(`pass ${String(state.pass).padStart(2, "0")} · tape ${Math.round(health * 100)}%`, lx, ly - amp - 26);

    for (let i = 0; i < COLS; i++) {
      const x = lx + (i / COLS) * laneW;
      const pk = state.peaks[i] * amp;
      const wr = state.wear[i];
      const gv = Math.pow(1 - wr, 2);
      // ghost of what the tape once held
      c.fillStyle = "rgba(255, 255, 255, 0.08)";
      c.fillRect(x, ly - pk, cw, Math.max(1, pk * 2));
      if (gv <= 0.02) {
        // dead column: residue + flickering dust
        c.fillStyle = "rgba(255, 255, 255, 0.12)";
        c.fillRect(x, ly, cw, 1);
        if (Math.random() < 0.1) {
          c.fillStyle = "rgba(255, 255, 255, 0.2)";
          c.fillRect(x, ly - pk + Math.random() * pk * 2, cw, 1);
        }
        continue;
      }
      const jit = wr > 0.2 ? (Math.random() * 2 - 1) * wr * 4 : 0;
      const bh = pk * (0.06 + 0.94 * gv);
      c.fillStyle = `rgba(255, 255, 255, ${(0.14 + 0.4 * gv).toFixed(3)})`;
      c.fillRect(x, ly - bh + jit, cw, Math.max(1, bh * 2));
    }

    // oxide strip: the wear map, verbatim
    for (let i = 0; i < COLS; i++) {
      if (state.wear[i] <= 0.02) continue;
      c.fillStyle = `rgba(255, 255, 255, ${(state.wear[i] * 0.55).toFixed(3)})`;
      c.fillRect(lx + (i / COLS) * laneW, ly + amp + 14, cw, 4);
    }

    // playhead
    c.fillStyle = "#fff";
    c.fillRect(lx + state.pos * laneW, ly - amp, 1.5, amp * 2);
  }

  // ---- 05 drone: six harmonics breathing on their own slow clocks — each bar
  // swells inside a ghost of its full reach (the tool's viz verbatim); every
  // while the seed rerolls and the same tone breathes differently ----
  const DRONE_AMPS = [0.40, 0.26, 0.22, 0.18, 0.12, 0.05];
  function drawDroneViz(v, t, dt) {
    const { ctx: c, w, h, state } = v;
    if (!state.lfo) {
      state.reseed = () => {
        state.lfo = DRONE_AMPS.map(() => ({
          rate: 0.04 + Math.random() * 0.08,
          ph: Math.random() * Math.PI * 2,
        }));
        state.seed = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, "0");
        state.age = 0;
      };
      state.reseed();
    }
    state.age += dt;
    if (state.age > 24) state.reseed(); // a new performance of the same chord
    const env = intensity();
    c.clearRect(0, 0, w, h);
    const laneW = w * 0.8;
    const lx = (w - laneW) / 2;
    const baseY = h * 0.84;
    const maxH = Math.min(260, h * 0.58);
    const n = DRONE_AMPS.length;
    const bw = laneW / (n * 2);

    c.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    c.fillStyle = "rgba(255, 255, 255, 0.35)";
    c.fillText(`seed ${state.seed} · 6 harmonics`, lx, baseY - maxH - 18);

    for (let p = 0; p < n; p++) {
      const breathe = 0.7 + 0.3 * Math.sin(2 * Math.PI * state.lfo[p].rate * (1 + env) * state.age + state.lfo[p].ph);
      const full = (DRONE_AMPS[p] / DRONE_AMPS[0]) * maxH;
      const live = full * breathe;
      const x = lx + (p * 2 + 0.5) * bw;
      // ghost = the partial's full reach; the live bar breathes inside it
      c.fillStyle = "rgba(255, 255, 255, 0.07)";
      c.fillRect(x, baseY - full, bw, full);
      c.fillStyle = "rgba(255, 255, 255, 0.5)";
      c.fillRect(x, baseY - live, bw, live);
    }
  }

  // ---- 06 glitch: the tool's lane timeline — six stages, blocks drawn in
  // cells, a playhead sweeping the loop; at every wrap the pattern mutates
  // (shift / resize / drop / split / rare add) and the pass counter climbs.
  // the engaged block under the head lights up, same as the page ----
  const GLITCH_LANES = ["crush", "noise", "drive", "chop", "glitch", "feedback"];
  function drawGlitchViz(v, t, dt) {
    const { ctx: c, w, h, state } = v;
    const CELLS = 64;
    if (!state.lanes) {
      state.reseed = () => {
        state.seed = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, "0");
        state.lanes = GLITCH_LANES.map((name, li) => {
          const blocks = [];
          // a few long blocks on the slow stages, scattered hits on the fast ones
          const n = li >= 3 ? 4 + ((Math.random() * 5) | 0) : 1 + ((Math.random() * 2) | 0);
          for (let k = 0; k < n; k++) {
            const len = li >= 3 ? 1 + ((Math.random() * 3) | 0) : 8 + ((Math.random() * 20) | 0);
            const s0 = (Math.random() * (CELLS - len)) | 0;
            blocks.push({ s: s0, e: s0 + len });
          }
          return { name, blocks: mergeBlocks(blocks) };
        });
        state.pass = 1;
        state.pos = 0;
        state.authored = state.lanes.map((l) => l.blocks.map((b) => ({ ...b })));
      };
      state.reseed();
    }
    function mergeBlocks(bs) {
      bs.sort((a, b) => a.s - b.s);
      const out = [];
      for (const b of bs) {
        const last = out[out.length - 1];
        if (last && b.s <= last.e) last.e = Math.max(last.e, b.e);
        else out.push(b);
      }
      return out;
    }
    const env = intensity();
    state.pos += dt / (6 - 2.5 * env);
    if (state.pos >= 1) {
      state.pos -= 1;
      state.pass++;
      if (state.pass > 9) { state.reseed(); }
      else {
        // mutate: each lane rolls for one edit, biased to shift + resize
        for (const lane of state.lanes) {
          const bs = lane.blocks;
          const r = Math.random();
          if (r < 0.35 && bs.length) {
            const b = bs[(Math.random() * bs.length) | 0];
            const d = ((Math.random() * 9) | 0) - 4;
            const len = b.e - b.s;
            b.s = Math.max(0, Math.min(CELLS - len, b.s + d));
            b.e = b.s + len;
          } else if (r < 0.6 && bs.length) {
            const b = bs[(Math.random() * bs.length) | 0];
            b.e = Math.max(b.s + 1, Math.min(CELLS, b.e + ((Math.random() * 7) | 0) - 3));
          } else if (r < 0.72 && bs.length > 1) {
            bs.splice((Math.random() * bs.length) | 0, 1);
          } else if (r < 0.82 && bs.length) {
            const b = bs[(Math.random() * bs.length) | 0];
            if (b.e - b.s >= 3) {
              const cut = b.s + 1 + ((Math.random() * (b.e - b.s - 2)) | 0);
              bs.push({ s: cut + 1, e: b.e });
              b.e = cut;
            }
          } else if (r < 0.9) {
            const len = 1 + ((Math.random() * 3) | 0);
            const s0 = (Math.random() * (CELLS - len)) | 0;
            bs.push({ s: s0, e: s0 + len });
          }
          lane.blocks = mergeBlocks(bs);
        }
      }
    }

    c.clearRect(0, 0, w, h);
    // lane labels hang left of the lanes — shift the block right to fit them
    const laneW = w * 0.78 - 40;
    const lx = (w - laneW) / 2 + 20;
    const rows = GLITCH_LANES.length;
    const rowH = Math.min(34, (h * 0.66) / rows);
    const top = h / 2 + 8 - (rowH * rows) / 2;
    const cw = laneW / CELLS;
    const headCell = state.pos * CELLS;

    c.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    c.fillStyle = "rgba(255, 255, 255, 0.35)";
    c.fillText(`pass ${String(state.pass).padStart(2, "0")} · seed ${state.seed} · ÷${CELLS}`, lx, top - 14);

    for (let li = 0; li < rows; li++) {
      const y = top + li * rowH;
      // lane rule + label
      c.fillStyle = "rgba(255, 255, 255, 0.08)";
      c.fillRect(lx, y + rowH - 1, laneW, 1);
      c.fillStyle = "rgba(255, 255, 255, 0.28)";
      c.textAlign = "right";
      c.fillText(GLITCH_LANES[li], lx - 10, y + rowH * 0.66);
      // authored ghost (what was drawn) under the live, mutated blocks
      for (const b of state.authored[li]) {
        c.fillStyle = "rgba(255, 255, 255, 0.06)";
        c.fillRect(lx + b.s * cw, y + 4, (b.e - b.s) * cw - 1, rowH - 9);
      }
      for (const b of state.lanes[li].blocks) {
        const on = headCell >= b.s && headCell < b.e;
        c.fillStyle = on ? "rgba(255, 255, 255, 0.85)" : "rgba(255, 255, 255, 0.22)";
        c.fillRect(lx + b.s * cw, y + 4, Math.max(1.5, (b.e - b.s) * cw - 1), rowH - 9);
        if (!on) {
          c.strokeStyle = "rgba(255, 255, 255, 0.5)";
          c.lineWidth = 1;
          c.strokeRect(lx + b.s * cw + 0.5, y + 4.5, Math.max(1.5, (b.e - b.s) * cw - 2), rowH - 10);
        }
      }
    }
    // playhead
    c.fillStyle = "#fff";
    c.fillRect(lx + state.pos * laneW, top - 4, 1.5, rowH * rows + 4);
  }

  // ---- stretch: a drum-ish loop actually run through the cyclic stretch (the
  // og-stretch comp, animated) — every hit comes back as a flam of repeated
  // blocks, bar heights stepped like the coarse converter. the playhead sweeps
  // the stretched pass; each wrap re-rolls the ratio, the bit depth and where
  // the loop sits in the file (the overview strip underneath) ----
  const STRETCH_RATIOS = [1.5, 2, 3, 4];
  function stretchPass(state) {
    const src = state.src, N = src.length;
    const LEN = 2000;
    const LS = Math.floor(Math.random() * (N - LEN));
    const S = STRETCH_RATIOS[(Math.random() * STRETCH_RATIOS.length) | 0];
    const L = 260, XF = 20, H = L - XF;
    const OUT = Math.floor(LEN * S);
    const out = new Float32Array(OUT);
    for (let t0 = 0; t0 < OUT; t0 += H) {
      const at = Math.floor(t0 / S);
      for (let a = 0; a < L && t0 + a < OUT; a++) {
        let w = 1;
        if (a < XF) w = 0.5 - 0.5 * Math.cos((Math.PI * a) / XF);
        else if (a >= L - XF) w = 0.5 - 0.5 * Math.cos((Math.PI * (L - a)) / XF);
        out[t0 + a] += src[LS + ((at + a) % LEN)] * w;
      }
    }
    state.ls = LS / N;
    state.le = (LS + LEN) / N;
    state.ratio = S;
    state.bits = Math.random() < 0.6 ? 12 : 8;
    state.rate = ["30k", "15k", "8k"][(Math.random() * 3) | 0];
    state.out = out;
    state.pos = 0;
  }
  function drawStretchViz(v, t, dt) {
    const { ctx: c, w, h, state } = v;
    const laneW = w * 0.86;
    const lx = (w - laneW) / 2;
    if (!state.src) {
      const N = 8000;
      const src = new Float32Array(N);
      for (let hIdx = 150; hIdx < N; hIdx += 280 + ((Math.random() * 5) | 0) * 140) {
        const amp = 0.55 + 0.45 * Math.random();
        const dec = 45 + Math.random() * 130;
        for (let i = 0; i < 550 && hIdx + i < N; i++) src[hIdx + i] += (Math.random() * 2 - 1) * amp * Math.exp(-i / dec);
      }
      for (let i = 0; i < N; i++) src[i] += Math.sin(i * 0.05) * 0.05;
      state.src = src;
      // the overview is fixed — only the loop bracket moves
      const OC = Math.max(60, Math.floor(laneW / 3)), op = N / OC;
      state.over = new Float32Array(OC);
      for (let k = 0; k < OC; k++) {
        let mx = 0;
        for (let i = Math.floor(k * op); i < Math.floor((k + 1) * op); i++) mx = Math.max(mx, Math.abs(src[i]));
        state.over[k] = mx;
      }
      stretchPass(state);
    }
    const env = intensity();
    // one pass of the stretched loop takes ~2.4s per 100% at env 0.5
    state.pos += dt / (1.2 * state.ratio) * (0.6 + 0.8 * env);
    if (state.pos >= 1) stretchPass(state);

    c.clearRect(0, 0, w, h);
    const amp = h * 0.2;
    const midY = h * 0.44;

    c.font = "10px ui-monospace, SFMono-Regular, Menlo, monospace";
    c.textAlign = "left";
    c.textBaseline = "alphabetic";
    c.fillStyle = "rgba(255, 255, 255, 0.35)";
    c.fillText(`${Math.round(state.ratio * 100)}% · ${state.bits}-bit ${state.rate}`, lx, midY - amp - 14);

    // the stretched pass — stepped like a coarse converter, lit behind the head
    const out = state.out, OUT = out.length;
    const COLS = Math.max(60, Math.floor(laneW / 2.5));
    const cw = laneW / COLS + 0.5;
    const STEP = amp / (state.bits === 12 ? 9 : 4);
    const per = OUT / COLS;
    for (let k = 0; k < COLS; k++) {
      let mx = 0;
      for (let i = Math.floor(k * per); i < Math.floor((k + 1) * per); i++) mx = Math.max(mx, Math.abs(out[i]));
      const bh = Math.max(1, Math.round((mx * amp) / STEP) * STEP);
      c.fillStyle = k / COLS < state.pos ? "rgba(255, 255, 255, 0.72)" : "rgba(255, 255, 255, 0.22)";
      c.fillRect(lx + (k / COLS) * laneW, midY - bh, cw, bh * 2);
    }

    // overview strip: the whole file, the loop lit and bracketed
    const OY = midY + amp + 22, OH = Math.max(14, h * 0.1);
    const OC = state.over.length, ocw = laneW / OC + 0.5;
    const bx0 = lx + state.ls * laneW, bx1 = lx + state.le * laneW;
    for (let k = 0; k < OC; k++) {
      const x = lx + (k / OC) * laneW;
      const inside = x + ocw / 2 >= bx0 && x + ocw / 2 <= bx1;
      const bh = Math.max(1, state.over[k] * OH * 0.45);
      c.fillStyle = inside ? "rgba(255, 255, 255, 0.45)" : "rgba(255, 255, 255, 0.14)";
      c.fillRect(x, OY + OH / 2 - bh, ocw, bh * 2);
    }
    c.fillStyle = "rgba(255, 255, 255, 0.06)";
    c.fillRect(bx0, OY, bx1 - bx0, OH);
    c.fillStyle = "rgba(255, 255, 255, 0.45)";
    c.fillRect(bx0, OY, 1, OH);
    c.fillRect(bx1 - 1, OY, 1, OH);

    // playhead — the one bright line, on the pass and on the loop
    c.fillStyle = "#fff";
    c.fillRect(lx + state.pos * laneW, midY - amp - 6, 1.5, amp * 2 + 12);
    c.fillRect(bx0 + state.pos * (bx1 - bx0), OY, 1, OH);
  }


  const DRAW = {
    sequence: drawSeqViz,
    texture: drawTextureViz,
    slice: drawSliceViz,
    decay: drawDecayViz,
    drone: drawDroneViz,
    glitch: drawGlitchViz,
    stretch: drawStretchViz,
    samples: drawSamplesViz,
    visuals: drawVisualsViz,
  };

  const views = [];
  function register(cv, name, opts = {}) {
    const vctx = cv.getContext("2d");
    const v = { draw: DRAW[name], ctx: vctx, w: 0, h: 0, visible: false, state: {}, vignette: !!opts.vignette };
    function fit() {
      const r = cv.getBoundingClientRect();
      if (Math.round(r.width) === Math.round(v.w) && Math.round(r.height) === Math.round(v.h)) return;
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      v.w = r.width;
      v.h = r.height;
      cv.width = Math.max(1, Math.floor(r.width * dpr));
      cv.height = Math.max(1, Math.floor(r.height * dpr));
      vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      v.state = {}; // layout-dependent state rebuilds lazily on next draw
    }
    // grids reflow at their breakpoints without a window resize of note
    new ResizeObserver(fit).observe(cv);
    fit();
    new IntersectionObserver(
      (entries) => { v.visible = entries[0].isIntersecting; },
      { threshold: 0.02 }
    ).observe(opts.observe || cv);
    views.push(v);
  }

  let lastT = performance.now();
  requestAnimationFrame(function frame(t) {
    const dt = Math.min(0.1, (t - lastT) / 1000); // a background tab can't jump the state
    lastT = t;
    mouseActivity = Math.max(0, mouseActivity - 1.2 * dt);
    for (const v of views) if (v.visible && v.w > 0) v.draw(v, t, dt);
    requestAnimationFrame(frame);
  });

  window.NSToolViz = { register };
})();
