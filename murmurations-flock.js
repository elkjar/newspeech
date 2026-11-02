// murmurations-flock.js — flock sim for murmurations.html.
//
// 2D flock inside a rectangle (half-sizes `halfW` × `halfH` m, set by the
// page to the screen's aspect). Each bird steers by
// its k nearest neighbours by rank, not distance (topological interaction,
// Ballerini et al. 2008: k ≈ 6–7).
//
// Turns are waves. A wave starts on a few birds; a bird joins when
// `contagion` of its k neighbours are turning in that wave and its reaction
// delay has passed, then rotates by the wave's angle. Each join is pushed
// to `events` for the page to play and draw.
//
// The flock as a whole steers toward a target point that moves on whenever
// the flock gets close: every bird rotates by the same small angle per step
// (at most `steer` rad/s), so the flock sweeps in arcs across the space
// without losing its alignment. Birds further than the flock's own radius
// from its centre are pulled back, so it stays one body.
//
// Birds also have a height inside a slab of half-thickness `depth` m. The
// page draws the flock from above, so birds at different heights overlap
// on screen; spacing and neighbours are measured in 3D. A bird joining a
// wave banks: it gets a vertical kick of up to `bank` m/s, so turns sweep
// birds through the layers.
//
// Speed and spacing defaults sit inside measured flocks (jackdaws, Ling et
// al. 2019: 8.6–13.5 m/s, nearest neighbour 1.4–2.2 m).
//
// No DOM. window.MurmFlock in the browser, module.exports in node.
(function (root) {
  const NMAX = 8000;
  const KMAX = 24;

  function createFlock(opts) {
    const p = Object.assign({
      n: 1200,
      k: 7,             // neighbours each bird tracks (topological)
      speed: 10,        // cruise speed, m/s
      contagion: 1.5,   // turning neighbours needed before a bird joins a wave;
                        // fractional = that share of birds need one more
      reaction: 0.07,   // s, mean neighbour-to-neighbour reaction delay
      turnTime: 0.45,   // s, how long one bird takes to complete its turn
      refractory: 1.6,  // s, after turning a bird ignores new waves this long
      waveLife: 8,      // s, a wave stops spreading this long after it starts
      halfW: 71,        // m, half-width of the space (16:9 at halfH 40)
      halfH: 40,        // m, half-height
      cohesion: 0.6,    // pull back toward the centre for birds outside the flock radius
      local: 0.3,       // pull toward the centre of each bird's k neighbours
      pull: 0.04,       // gentle pull toward the flock centre, everywhere
      align: 2.6,       // how hard a bird matches its neighbours' velocity
      sep: 30,          // how hard birds push apart inside sepRadius
      sepRadius: 1.4,   // m, personal space
      noise: 0.6,       // m/s², random wing noise per bird
      steer: 0.45,      // rad/s, fastest whole-flock turn toward the target
      roam: 0.7,        // steering targets fall inside this share of the space
      edge: 6,          // push-back past the screen edge (turn-around ≈ v/√edge m)
      turnAngle: 1.5,   // rad, largest spontaneous turn (smallest = 0.4×)
      depth: 10,        // m, half-thickness of the slab birds fly in (0 = flat)
      bank: 3,          // m/s, vertical kick when a bird joins a wave
    }, opts);

    const px = new Float32Array(NMAX), py = new Float32Array(NMAX), pz = new Float32Array(NMAX);
    const vx = new Float32Array(NMAX), vy = new Float32Array(NMAX), vz = new Float32Array(NMAX);
    const nbr = new Int32Array(NMAX * KMAX);
    const nbrD = new Float32Array(NMAX * KMAX);
    const waveOf = new Int32Array(NMAX).fill(-1);
    const startT = new Float64Array(NMAX).fill(-1e9);
    const turnLeft = new Float32Array(NMAX);
    const turnRate = new Float32Array(NMAX);
    const refrUntil = new Float64Array(NMAX);
    const delay = new Float32Array(NMAX);
    const nerve = new Float32Array(NMAX);   // per-bird draw for fractional contagion
    const bestD = new Float64Array(KMAX), bestJ = new Int32Array(KMAX);

    let N = 0;
    let frame = 0;
    let waveId = 0;
    let tx = 0, ty = 0, nextTarget = 0;   // whole-flock steering target
    const waves = new Map();      // id → wave, pruned once quiet
    const events = [];            // { i, wave, t }: drained by the page

    const stats = {
      cx: 0, cy: 0,               // centroid
      mvx: 0, mvy: 0,             // mean velocity
      extent: 10,                 // RMS radius about the centroid
      polarization: 1,            // |mean unit velocity|, 1 = all aligned
      turning: 0,                 // fraction of birds mid-turn
      nn: 1.5,                    // mean nearest-neighbour distance
    };

    function rnd(a, b) { return a + Math.random() * (b - a); }

    function spawn(i, x, y, ux, uy, z) {
      px[i] = x; py[i] = y; pz[i] = z;
      vx[i] = ux * p.speed; vy[i] = uy * p.speed; vz[i] = 0;
      waveOf[i] = -1; startT[i] = -1e9; turnLeft[i] = 0; refrUntil[i] = 0;
      delay[i] = rnd(0.6, 1.4);
      nerve[i] = Math.random();
    }

    function setCount(n) {
      n = Math.max(8, Math.min(NMAX, Math.round(n)));
      if (N === 0) {
        const r = 0.8 * Math.sqrt(n);
        for (let i = 0; i < n; i++) {
          // uniform in a disc, heading +x
          let x, y;
          do { x = rnd(-1, 1); y = rnd(-1, 1); } while (x * x + y * y > 1);
          spawn(i, x * r, y * r, 1, rnd(-0.1, 0.1), rnd(-1, 1) * p.depth);
        }
      } else {
        for (let i = N; i < n; i++) {
          // new birds spawn beside a random existing one
          const j = (Math.random() * N) | 0;
          const s = Math.hypot(vx[j], vy[j]) || 1;
          spawn(i, px[j] + rnd(-1, 1), py[j] + rnd(-1, 1), vx[j] / s, vy[j] / s, pz[j] + rnd(-1, 1));
        }
      }
      N = n;
    }

    function kNow() { return Math.max(1, Math.min(KMAX, Math.round(p.k), N - 1)); }

    // k nearest via a uniform 3D grid (CELL m): each bird searches shells
    // of cells outward until no unseen bird can be closer than its kth.
    // Rebuilt every frame; half the flock re-searches per frame.
    const CELL = 2;
    let gCount = new Int32Array(1), gStart = new Int32Array(1);
    const gItems = new Int32Array(NMAX), cellOf = new Int32Array(NMAX);
    let gx0 = 0, gy0 = 0, gz0 = 0, gnx = 1, gny = 1, gnz = 1;
    function buildGrid() {
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      for (let i = 0; i < N; i++) {
        if (px[i] < x0) x0 = px[i]; if (px[i] > x1) x1 = px[i];
        if (py[i] < y0) y0 = py[i]; if (py[i] > y1) y1 = py[i];
        if (pz[i] < z0) z0 = pz[i]; if (pz[i] > z1) z1 = pz[i];
      }
      gx0 = x0; gy0 = y0; gz0 = z0;
      gnx = Math.floor((x1 - x0) / CELL) + 1; gny = Math.floor((y1 - y0) / CELL) + 1; gnz = Math.floor((z1 - z0) / CELL) + 1;
      const cells = gnx * gny * gnz;
      if (gCount.length < cells + 1) { gCount = new Int32Array(cells + 1); gStart = new Int32Array(cells + 1); }
      gCount.fill(0, 0, cells + 1);
      for (let i = 0; i < N; i++) {
        const c = (Math.floor((pz[i] - z0) / CELL) * gny + Math.floor((py[i] - y0) / CELL)) * gnx + Math.floor((px[i] - x0) / CELL);
        cellOf[i] = c; gCount[c]++;
      }
      gStart[0] = 0;
      for (let c = 0; c < cells; c++) gStart[c + 1] = gStart[c] + gCount[c];
      for (let c = 0; c < cells; c++) gCount[c] = gStart[c];
      for (let i = 0; i < N; i++) gItems[gCount[cellOf[i]]++] = i;
    }
    function updateNeighbours() {
      const k = kNow();
      const parity = frame & 1;
      buildGrid();
      const rMax = Math.max(gnx, gny, gnz);
      for (let i = parity; i < N; i += 2) {
        let filled = 0;
        const xi = px[i], yi = py[i], zi = pz[i];
        const ci = Math.floor((xi - gx0) / CELL), cj = Math.floor((yi - gy0) / CELL), ck = Math.floor((zi - gz0) / CELL);
        for (let r = 0; r <= rMax; r++) {
          for (let dz = -r; dz <= r; dz++) {
            const z = ck + dz; if (z < 0 || z >= gnz) continue;
            for (let dy = -r; dy <= r; dy++) {
              const y = cj + dy; if (y < 0 || y >= gny) continue;
              const onShell = Math.abs(dz) === r || Math.abs(dy) === r;
              for (let dx = -r; dx <= r; dx += (onShell || r === 0) ? 1 : 2 * r) {
                const x = ci + dx; if (x < 0 || x >= gnx) continue;
                const c = (z * gny + y) * gnx + x;
                for (let q = gStart[c], e = gStart[c + 1]; q < e; q++) {
                  const j = gItems[q];
                  if (j === i) continue;
                  const ddx = px[j] - xi, ddy = py[j] - yi, ddz = pz[j] - zi;
                  const d = ddx * ddx + ddy * ddy + ddz * ddz;
                  if (filled < k) {
                    let s = filled++;
                    while (s > 0 && bestD[s - 1] > d) { bestD[s] = bestD[s - 1]; bestJ[s] = bestJ[s - 1]; s--; }
                    bestD[s] = d; bestJ[s] = j;
                  } else if (d < bestD[k - 1]) {
                    let s = k - 1;
                    while (s > 0 && bestD[s - 1] > d) { bestD[s] = bestD[s - 1]; bestJ[s] = bestJ[s - 1]; s--; }
                    bestD[s] = d; bestJ[s] = j;
                  }
                }
              }
            }
          }
          // every cell in shell r+1 is at least r·CELL away
          if (filled >= k && bestD[k - 1] <= (r * CELL) * (r * CELL)) break;
        }
        const base = i * KMAX;
        for (let s = 0; s < k; s++) { nbr[base + s] = bestJ[s]; nbrD[base + s] = Math.sqrt(bestD[s]); }
      }
    }

    // ---- waves ----
    function newWave(kind, angle, t) {
      const w = { id: waveId++, kind, angle, t0: t, count: 0, last: t, bank: rnd(0.5, 1) * p.bank * (Math.random() < 0.5 ? -1 : 1) };
      waves.set(w.id, w);
      if (typeof api.onWave === "function") api.onWave(w);
      return w;
    }

    function join(i, w, t) {
      waveOf[i] = w.id;
      startT[i] = t;
      turnLeft[i] = w.angle;
      turnRate[i] = w.angle / p.turnTime;
      if (p.depth > 0.5) vz[i] += w.bank;
      refrUntil[i] = t + p.refractory;
      w.count++;
      w.last = t;
      events.push({ i, wave: w, t });
    }

    function seedAround(seed, w, t) {
      join(seed, w, t);
      const k = kNow(), base = seed * KMAX;
      for (let s = 0; s < k; s++) {
        const j = nbr[base + s];
        if (waveOf[j] !== w.id) join(j, w, t + 0.02 * s);
      }
    }

    // spontaneous wave: starts at an edge bird + its neighbours
    function initiate(t) {
      if (N < 2) return null;
      let seed = 0, far = -1;
      for (let s = 0; s < 6; s++) {
        const i = (Math.random() * N) | 0;
        const d = (px[i] - stats.cx) ** 2 + (py[i] - stats.cy) ** 2;
        if (d > far) { far = d; seed = i; }
      }
      const w = newWave("turn", rnd(0.4, 1) * p.turnAngle * (Math.random() < 0.5 ? -1 : 1), t);
      seedAround(seed, w, t);
      return w;
    }

    // new target: of 4 random points inside 70 % of the space, the one
    // furthest from the flock
    function pickTarget(t) {
      let best = -1;
      for (let s = 0; s < 4; s++) {
        const x = rnd(-1, 1) * p.roam * p.halfW, y = rnd(-1, 1) * p.roam * p.halfH;
        const d = (x - stats.cx) ** 2 + (y - stats.cy) ** 2;
        if (d > best) { best = d; tx = x; ty = y; }
      }
      nextTarget = t + rnd(10, 20);
    }

    // strike at (x,y): birds within `radius` turn away immediately; the
    // rest follow by contagion
    function strike(t, x, y, radius) {
      const ox = stats.cx - x, oy = stats.cy - y;
      const cross = stats.mvx * oy - stats.mvy * ox;
      const w = newWave("strike", rnd(1.6, 2.4) * (cross >= 0 ? 1 : -1), t);
      w.x = x; w.y = y;
      const r2 = radius * radius;
      let hit = 0;
      for (let i = 0; i < N; i++) {
        if ((px[i] - x) ** 2 + (py[i] - y) ** 2 < r2) { join(i, w, t); hit++; }
      }
      if (!hit) {
        // nothing in range: start at the nearest bird
        let best = 0, bd = Infinity;
        for (let i = 0; i < N; i++) {
          const d = (px[i] - x) ** 2 + (py[i] - y) ** 2;
          if (d < bd) { bd = d; best = i; }
        }
        seedAround(best, w, t);
      }
      return w;
    }

    const tally = new Int32Array(KMAX), tallyId = new Int32Array(KMAX);
    function contagion(t) {
      const k = kNow();
      const c = Math.max(1, Math.min(k, p.contagion));
      const lo = Math.floor(c), frac = c - lo;
      const win = p.turnTime + 0.3;
      for (let j = 0; j < N; j++) {
        if (t < refrUntil[j]) continue;
        const base = j * KMAX;
        const dj = delay[j] * p.reaction;
        const need = nerve[j] < frac ? lo + 1 : lo;
        let kinds = 0;
        for (let s = 0; s < k; s++) {
          const n = nbr[base + s];
          const age = t - startT[n];
          if (age < dj || age > win) continue;
          const id = waveOf[n];
          // only waves newer than the last one this bird rode: each wave
          // passes each bird once, so two waves can't ping-pong forever
          if (id <= waveOf[j]) continue;
          let m = 0;
          while (m < kinds && tallyId[m] !== id) m++;
          if (m === kinds) { tallyId[m] = id; tally[m] = 0; kinds++; }
          if (++tally[m] >= need) {
            const w = waves.get(id);
            if (w && t - w.t0 < p.waveLife) join(j, w, t);
            break;
          }
        }
      }
    }

    // ---- motion ----
    function integrate(dt, omega) {
      const k = kNow();
      const v0 = p.speed;
      const rSep = p.sepRadius;
      const W = p.halfW, H = p.halfH;
      // flock radius at its usual spacing (~1.3 m between birds)
      const r0 = 0.6 * Math.sqrt(N) * 1.3;
      for (let i = 0; i < N; i++) {
        const base = i * KMAX;
        let mx = 0, my = 0, cx = 0, cy = 0, cz = 0, sx = 0, sy = 0, sz = 0;
        for (let s = 0; s < k; s++) {
          const j = nbr[base + s];
          mx += vx[j]; my += vy[j];
          cx += px[j]; cy += py[j]; cz += pz[j];
          const d = nbrD[base + s];
          if (d < rSep && d > 1e-4) {
            const f = (rSep - d) / (rSep * d);
            sx += (px[i] - px[j]) * f; sy += (py[i] - py[j]) * f; sz += (pz[i] - pz[j]) * f;
          }
        }
        const ik = 1 / k;
        // local pull kept low: in 3D a strong one packs birds into balls
        // whose 7 neighbours are all inside the ball, and the flock splits
        let ax = p.align * (mx * ik - vx[i]) + p.local * (cx * ik - px[i]) + p.sep * sx;
        let ay = p.align * (my * ik - vy[i]) + p.local * (cy * ik - py[i]) + p.sep * sy;
        // cohesion: birds outside the flock radius are pulled toward the centre
        const gx = stats.cx - px[i], gy = stats.cy - py[i], gd = Math.hypot(gx, gy);
        ax += p.pull * gx; ay += p.pull * gy;
        if (gd > r0) {
          const f = p.cohesion * (gd - r0) / gd;
          ax += gx * f; ay += gy * f;
        }
        // edge: birds past the screen edge are pushed back, harder the
        // further out; at 10 m/s they turn around within ~4 m (√(v²/6)),
        // 10 % of the 40 m half-height
        if (px[i] > W) ax -= p.edge * (px[i] - W); else if (px[i] < -W) ax -= p.edge * (px[i] + W);
        if (py[i] > H) ay -= p.edge * (py[i] - H); else if (py[i] < -H) ay -= p.edge * (py[i] + H);
        // noise
        ax += rnd(-1, 1) * p.noise; ay += rnd(-1, 1) * p.noise;

        vx[i] += ax * dt; vy[i] += ay * dt;

        // height: neighbours + spacing in 3D, banking decays, slab walls
        let az = 0.45 * (cz * ik - pz[i]) + p.sep * sz - 1.2 * vz[i] + rnd(-0.5, 0.5) * p.noise;
        if (pz[i] > p.depth) az -= 4 * (pz[i] - p.depth); else if (pz[i] < -p.depth) az -= 4 * (pz[i] + p.depth);
        vz[i] += az * dt;
        pz[i] += vz[i] * dt;

        // whole-flock steering: the same rotation for every bird
        if (omega !== 0) {
          const c = Math.cos(omega * dt), s = Math.sin(omega * dt), x = vx[i];
          vx[i] = x * c - vy[i] * s;
          vy[i] = x * s + vy[i] * c;
        }

        if (turnLeft[i] !== 0) {
          let a = turnRate[i] * dt;
          if (Math.abs(a) > Math.abs(turnLeft[i])) a = turnLeft[i];
          const c = Math.cos(a), s = Math.sin(a), x = vx[i];
          vx[i] = x * c - vy[i] * s;
          vy[i] = x * s + vy[i] * c;
          turnLeft[i] -= a;
          if (Math.abs(turnLeft[i]) < 1e-4) turnLeft[i] = 0;
        }

        // relax toward cruise speed, clamp 0.55–1.6×
        const sp = Math.hypot(vx[i], vy[i]) || 1e-6;
        const target = sp + (v0 - sp) * Math.min(1, dt * 1.5);
        const sc = Math.max(0.55 * v0, Math.min(1.6 * v0, target)) / sp;
        vx[i] *= sc; vy[i] *= sc;

        px[i] += vx[i] * dt; py[i] += vy[i] * dt;

        // respawn on NaN or escape
        if (!(px[i] === px[i] && vx[i] === vx[i]) || Math.abs(px[i]) > 1.5 * W || Math.abs(py[i]) > 1.5 * H) {
          spawn(i, stats.cx + rnd(-2, 2), stats.cy + rnd(-2, 2), 1, 0, 0);
        }
      }
    }

    function measure(t) {
      let cx = 0, cy = 0, mx = 0, my = 0, ux = 0, uy = 0, turning = 0, nn = 0;
      for (let i = 0; i < N; i++) {
        cx += px[i]; cy += py[i];
        mx += vx[i]; my += vy[i];
        const s = Math.hypot(vx[i], vy[i]) || 1;
        ux += vx[i] / s; uy += vy[i] / s;
        if (turnLeft[i] !== 0) turning++;
        nn += nbrD[i * KMAX];
      }
      const iN = 1 / N;
      stats.cx = cx * iN; stats.cy = cy * iN;
      stats.mvx = mx * iN; stats.mvy = my * iN;
      stats.polarization = Math.hypot(ux, uy) * iN;
      stats.turning = turning * iN;
      stats.nn = nn * iN;
      let r2 = 0;
      for (let i = 0; i < N; i++) r2 += (px[i] - stats.cx) ** 2 + (py[i] - stats.cy) ** 2;
      stats.extent = Math.sqrt(r2 * iN);
      for (const [id, w] of waves) if (t - w.last > 3) waves.delete(id);
    }

    function step(dt, t) {
      if (N === 0) return;
      if (frame === 0) { updateNeighbours(); frame++; }
      updateNeighbours();
      contagion(t);
      // steer the flock's mean heading toward the target
      if (t > nextTarget || Math.hypot(tx - stats.cx, ty - stats.cy) < 12) pickTarget(t);
      let diff = Math.atan2(ty - stats.cy, tx - stats.cx) - Math.atan2(stats.mvy, stats.mvx);
      diff = Math.atan2(Math.sin(diff), Math.cos(diff));
      const omega = Math.max(-p.steer, Math.min(p.steer, 1.2 * diff));
      integrate(dt, omega);
      measure(t);
      frame++;
    }

    const api = {
      params: p,
      stats,
      events,
      waves,
      px, py, pz, vx, vy, vz,
      nbr, KMAX,
      get n() { return N; },
      turning: (i) => turnLeft[i] !== 0,
      waveOf: (i) => waveOf[i],
      setCount,
      step,
      initiate,
      strike,
      onWave: null,
    };
    setCount(p.n);
    return api;
  }

  const MurmFlock = { createFlock, NMAX, KMAX };
  if (typeof module !== "undefined" && module.exports) module.exports = MurmFlock;
  else root.MurmFlock = MurmFlock;
})(typeof window !== "undefined" ? window : globalThis);
