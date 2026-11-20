// murmurations-flock.js — flock sim for murmurations.html.
//
// 3D flock inside a box (half-sizes halfW × halfH × halfD m; x right, y up,
// z toward the viewer). The page draws it from the side, in perspective,
// so overlapping layers fold over each other the way real ones do on
// camera. Each bird steers by its k nearest neighbours by rank, not
// distance (topological interaction, Ballerini et al. 2008: k ≈ 6–7).
//
// Cohesion follows StarDisplay (Hildenbrandt, Carere & Hemelrijk 2010): a
// bird is pulled toward its neighbours in proportion to its centrality —
// how lopsided its neighbourhood is — so birds on the border hold on while
// the interior stays loose. A pull toward the flock's centre acts only on
// birds outside its usual radius (an always-on one rounded earlier
// versions into discs).
//
// Turns are waves. A wave starts on a few birds; a bird joins when
// `contagion` of its k neighbours are turning in that wave and its reaction
// delay has passed, then rotates about the wave's axis — mostly vertical,
// tilted by up to `bank`, so turns roll the flock through 3D. Each join is
// pushed to `events` for the page to play and draw. The flock as a whole
// also steers toward a target point in the box that moves on when reached.
//
// `timeScale` slows the motion (0.1 = a tenth of real speed) without
// changing the flock's dynamics; waves still spread at real reaction speed.
//
// No DOM. window.MurmFlock in the browser, module.exports in node.
(function (root) {
  const NMAX = 8000;
  const KMAX = 24;

  function createFlock(opts) {
    const p = Object.assign({
      n: 1200,
      k: 7,             // neighbours each bird tracks (topological)
      speed: 10,        // cruise speed, m/s (flock time; see timeScale)
      timeScale: 1,     // motion plays at this share of real time
      contagion: 1.5,   // turning neighbours needed before a bird joins a wave;
                        // fractional = that share of birds need one more
      reaction: 0.07,   // s, mean neighbour-to-neighbour reaction delay
      turnTime: 0.45,   // s (flock time), how long one bird takes to turn
      refractory: 1.6,  // s, after turning a bird ignores new waves this long
      waveLife: 8,      // s, a wave stops spreading this long after it starts
      halfW: 53,        // m, box half-width (16:9 at halfH 30)
      halfH: 30,        // m, box half-height
      halfD: 30,        // m, box half-depth
      align: 2.6,       // how hard a bird matches its neighbours' velocity
      local: 15,        // pull toward neighbours, scaled by centrality
      pull: 0,          // pull toward the flock centre, everywhere
      cohesion: 1.2,    // pull back for birds outside the flock radius
      radius: 1,        // flock radius for that pull, as a share of 1.43·∛N m
      sep: 30,          // how hard birds push apart inside sepRadius
      sepRadius: 1.4,   // m, personal space
      noise: 0.6,       // m/s², random wing noise per bird
      steer: 0.45,      // rad/s (flock time), fastest whole-flock turn toward the target
      roam: 0.45,       // steering targets fall inside this share of the box
      edge: 6,          // push-back past the box walls
      bank: 0.6,        // 0 = turns about the vertical only, 1 = tilted up to 45°
      turnAngle: 1.5,   // rad, largest spontaneous turn (smallest = 0.4×)
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
    let tx = 0, ty = 0, tz = 0, nextTarget = 0;   // whole-flock steering target
    const waves = new Map();      // id → wave, pruned once quiet
    const events = [];            // { i, wave, t }: drained by the page

    const stats = {
      cx: 0, cy: 0, cz: 0,        // centroid
      mvx: 0, mvy: 0, mvz: 0,     // mean velocity
      extent: 10,                 // RMS radius about the centroid
      polarization: 1,            // |mean unit velocity|, 1 = all aligned
      turning: 0,                 // fraction of birds mid-turn
      nn: 1.5,                    // mean nearest-neighbour distance
    };

    function rnd(a, b) { return a + Math.random() * (b - a); }

    function spawn(i, x, y, z, ux, uy, uz) {
      px[i] = x; py[i] = y; pz[i] = z;
      vx[i] = ux * p.speed; vy[i] = uy * p.speed; vz[i] = uz * p.speed;
      waveOf[i] = -1; startT[i] = -1e9; turnLeft[i] = 0; refrUntil[i] = 0;
      delay[i] = rnd(0.6, 1.4);
      nerve[i] = Math.random();
    }

    function setCount(n) {
      n = Math.max(8, Math.min(NMAX, Math.round(n)));
      if (N === 0) {
        const r = 1.1 * Math.cbrt(n);
        for (let i = 0; i < n; i++) {
          // uniform in a ball, heading +x
          let x, y, z;
          do { x = rnd(-1, 1); y = rnd(-1, 1); z = rnd(-1, 1); } while (x * x + y * y + z * z > 1);
          spawn(i, x * r, y * r, z * r, 1, rnd(-0.05, 0.05), rnd(-0.1, 0.1));
        }
      } else {
        for (let i = N; i < n; i++) {
          // new birds spawn beside a random existing one
          const j = (Math.random() * N) | 0;
          const s = Math.hypot(vx[j], vy[j], vz[j]) || 1;
          spawn(i, px[j] + rnd(-1, 1), py[j] + rnd(-1, 1), pz[j] + rnd(-1, 1), vx[j] / s, vy[j] / s, vz[j] / s);
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
    // axis: vertical, tilted toward a random horizontal direction by up to
    // `bank` × 45°
    function newWave(kind, angle, t) {
      const tilt = rnd(0, p.bank) * Math.PI / 4, dir = rnd(0, 2 * Math.PI);
      const ax = Math.sin(tilt) * Math.cos(dir), ay = Math.cos(tilt), az = Math.sin(tilt) * Math.sin(dir);
      const w = { id: waveId++, kind, angle, ax, ay, az, t0: t, count: 0, last: t };
      waves.set(w.id, w);
      if (typeof api.onWave === "function") api.onWave(w);
      return w;
    }

    function join(i, w, t) {
      waveOf[i] = w.id;
      startT[i] = t;
      turnLeft[i] = w.angle;
      turnRate[i] = w.angle / p.turnTime;
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
        const d = (px[i] - stats.cx) ** 2 + (py[i] - stats.cy) ** 2 + (pz[i] - stats.cz) ** 2;
        if (d > far) { far = d; seed = i; }
      }
      const w = newWave("turn", rnd(0.4, 1) * p.turnAngle * (Math.random() < 0.5 ? -1 : 1), t);
      seedAround(seed, w, t);
      return w;
    }

    // new target: of 4 random points inside `roam` of the box, the one
    // furthest from the flock
    function pickTarget(t) {
      let best = -1;
      for (let s = 0; s < 4; s++) {
        const x = rnd(-1, 1) * p.roam * p.halfW, y = rnd(-1, 1) * p.roam * p.halfH, z = rnd(-1, 1) * p.roam * p.halfD;
        const d = (x - stats.cx) ** 2 + (y - stats.cy) ** 2 + (z - stats.cz) ** 2;
        if (d > best) { best = d; tx = x; ty = y; tz = z; }
      }
      nextTarget = t + rnd(10, 20) / Math.max(0.05, p.timeScale);
    }

    // strike at (x,y,z): birds within `radius` turn away immediately; the
    // rest follow by contagion
    function strike(t, x, y, z, radius) {
      const w = newWave("strike", rnd(1.6, 2.4) * (Math.random() < 0.5 ? -1 : 1), t);
      w.x = x; w.y = y; w.z = z;
      const r2 = radius * radius;
      let hit = 0;
      for (let i = 0; i < N; i++) {
        if ((px[i] - x) ** 2 + (py[i] - y) ** 2 + (pz[i] - z) ** 2 < r2) { join(i, w, t); hit++; }
      }
      if (!hit) {
        // nothing in range: start at the nearest bird
        let best = 0, bd = Infinity;
        for (let i = 0; i < N; i++) {
          const d = (px[i] - x) ** 2 + (py[i] - y) ** 2 + (pz[i] - z) ** 2;
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
      const win = p.turnTime / Math.max(0.05, p.timeScale) + 0.3;
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
    // rotate velocity i about unit axis (ax, ay, az) by angle a (Rodrigues)
    function rotate(i, ax, ay, az, a) {
      const c = Math.cos(a), s = Math.sin(a);
      const x = vx[i], y = vy[i], z = vz[i];
      const dot = ax * x + ay * y + az * z;
      const cx = ay * z - az * y, cy = az * x - ax * z, cz = ax * y - ay * x;
      vx[i] = x * c + cx * s + ax * dot * (1 - c);
      vy[i] = y * c + cy * s + ay * dot * (1 - c);
      vz[i] = z * c + cz * s + az * dot * (1 - c);
    }

    // dt is flock time (real dt × timeScale)
    function integrate(dt, sx_, sy_, sz_, omega) {
      const k = kNow();
      const v0 = p.speed;
      const rSep = p.sepRadius;
      const W = p.halfW, H = p.halfH, D = p.halfD;
      const r0 = p.radius * 1.1 * Math.cbrt(N) * 1.3;   // flock radius at usual spacing
      for (let i = 0; i < N; i++) {
        const base = i * KMAX;
        let mx = 0, my = 0, mz = 0, cx = 0, cy = 0, cz = 0, sx = 0, sy = 0, sz = 0, ux = 0, uy = 0, uz = 0;
        for (let s = 0; s < k; s++) {
          const j = nbr[base + s];
          mx += vx[j]; my += vy[j]; mz += vz[j];
          const dx = px[j] - px[i], dy = py[j] - py[i], dz = pz[j] - pz[i];
          cx += dx; cy += dy; cz += dz;
          const d = nbrD[base + s];
          if (d > 1e-4) {
            ux += dx / d; uy += dy / d; uz += dz / d;
            if (d < rSep) {
              const f = (rSep - d) / (rSep * d);
              sx -= dx * f; sy -= dy * f; sz -= dz * f;
            }
          }
        }
        const ik = 1 / k;
        // centrality: 0 deep inside, → 1 on the border
        const cen = Math.hypot(ux, uy, uz) * ik;
        const coh = p.local * cen;
        let ax = p.align * (mx * ik - vx[i]) + coh * cx * ik + p.sep * sx;
        let ay = p.align * (my * ik - vy[i]) + coh * cy * ik + p.sep * sy;
        let az = p.align * (mz * ik - vz[i]) + coh * cz * ik + p.sep * sz;
        // optional pulls toward the flock centre
        const gx = stats.cx - px[i], gy = stats.cy - py[i], gz = stats.cz - pz[i];
        ax += p.pull * gx; ay += p.pull * gy; az += p.pull * gz;
        if (p.cohesion > 0) {
          const gd = Math.hypot(gx, gy, gz);
          if (gd > r0) { const f = p.cohesion * (gd - r0) / gd; ax += gx * f; ay += gy * f; az += gz * f; }
        }
        // box walls
        if (px[i] > W) ax -= p.edge * (px[i] - W); else if (px[i] < -W) ax -= p.edge * (px[i] + W);
        if (py[i] > H) ay -= p.edge * (py[i] - H); else if (py[i] < -H) ay -= p.edge * (py[i] + H);
        if (pz[i] > D) az -= p.edge * (pz[i] - D); else if (pz[i] < -D) az -= p.edge * (pz[i] + D);
        // noise
        ax += rnd(-1, 1) * p.noise; ay += rnd(-1, 1) * p.noise; az += rnd(-1, 1) * p.noise;

        vx[i] += ax * dt; vy[i] += ay * dt; vz[i] += az * dt;

        // whole-flock steering: the same rotation for every bird
        if (omega !== 0) rotate(i, sx_, sy_, sz_, omega * dt);

        if (turnLeft[i] !== 0) {
          const w = waves.get(waveOf[i]);
          let a = turnRate[i] * dt;
          if (Math.abs(a) > Math.abs(turnLeft[i])) a = turnLeft[i];
          if (w) rotate(i, w.ax, w.ay, w.az, a);
          turnLeft[i] = w ? turnLeft[i] - a : 0;
          if (Math.abs(turnLeft[i]) < 1e-4) turnLeft[i] = 0;
        }

        // relax toward cruise speed, clamp 0.55–1.6×
        const sp = Math.hypot(vx[i], vy[i], vz[i]) || 1e-6;
        const target = sp + (v0 - sp) * Math.min(1, dt * 1.5);
        const sc = Math.max(0.55 * v0, Math.min(1.6 * v0, target)) / sp;
        vx[i] *= sc; vy[i] *= sc; vz[i] *= sc;

        px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;

        // respawn on NaN or escape
        if (!(px[i] === px[i] && vx[i] === vx[i]) || Math.abs(px[i]) > 1.5 * W || Math.abs(py[i]) > 1.5 * H || Math.abs(pz[i]) > 1.5 * D) {
          spawn(i, stats.cx + rnd(-2, 2), stats.cy + rnd(-2, 2), stats.cz + rnd(-2, 2), 1, 0, 0);
        }
      }
    }

    function measure(t) {
      let cx = 0, cy = 0, cz = 0, mx = 0, my = 0, mz = 0, ux = 0, uy = 0, uz = 0, turning = 0, nn = 0;
      for (let i = 0; i < N; i++) {
        cx += px[i]; cy += py[i]; cz += pz[i];
        mx += vx[i]; my += vy[i]; mz += vz[i];
        const s = Math.hypot(vx[i], vy[i], vz[i]) || 1;
        ux += vx[i] / s; uy += vy[i] / s; uz += vz[i] / s;
        if (turnLeft[i] !== 0) turning++;
        nn += nbrD[i * KMAX];
      }
      const iN = 1 / N;
      stats.cx = cx * iN; stats.cy = cy * iN; stats.cz = cz * iN;
      stats.mvx = mx * iN; stats.mvy = my * iN; stats.mvz = mz * iN;
      stats.polarization = Math.hypot(ux, uy, uz) * iN;
      stats.turning = turning * iN;
      stats.nn = nn * iN;
      let r2 = 0;
      for (let i = 0; i < N; i++) r2 += (px[i] - stats.cx) ** 2 + (py[i] - stats.cy) ** 2 + (pz[i] - stats.cz) ** 2;
      stats.extent = Math.sqrt(r2 * iN);
      for (const [id, w] of waves) if (t - w.last > 3) waves.delete(id);
    }

    // dt, t: real time. motion runs at dt × timeScale.
    function step(dt, t) {
      if (N === 0) return;
      if (frame === 0) { updateNeighbours(); frame++; }
      updateNeighbours();
      contagion(t);
      // steer the flock's mean heading toward the target, about the axis
      // perpendicular to both
      const ex = tx - stats.cx, ey = ty - stats.cy, ez = tz - stats.cz;
      if (t > nextTarget || Math.hypot(ex, ey, ez) < 8) pickTarget(t);
      const hm = Math.hypot(stats.mvx, stats.mvy, stats.mvz) || 1, em = Math.hypot(ex, ey, ez) || 1;
      const hx = stats.mvx / hm, hy = stats.mvy / hm, hz = stats.mvz / hm;
      let ax = hy * ez - hz * ey, ay = hz * ex - hx * ez, az = hx * ey - hy * ex;
      const am = Math.hypot(ax, ay, az);
      const ang = Math.atan2(am / em, (hx * ex + hy * ey + hz * ez) / em);
      let omega = 0;
      if (am > 1e-6) { ax /= am; ay /= am; az /= am; omega = Math.min(p.steer, 1.2 * ang); }
      integrate(dt * p.timeScale, ax, ay, az, omega);
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
      joinedAt: (i) => startT[i],
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
