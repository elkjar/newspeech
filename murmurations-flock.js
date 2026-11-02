// murmurations-flock.js — flock sim for murmurations.html.
//
// 3D flock. Each bird steers by its k nearest neighbours by rank, not
// distance (topological interaction, Ballerini et al. 2008: k ≈ 6–7).
//
// Turns are waves. A wave starts on a few birds; a bird joins when
// `contagion` of its k neighbours are turning in that wave and its reaction
// delay has passed, then rotates by the wave's angle. Each join is pushed
// to `events` for the page to play and draw.
//
// No DOM. window.MurmFlock in the browser, module.exports in node.
(function (root) {
  const NMAX = 1500;
  const KMAX = 24;
  const TAU = Math.PI * 2;

  function createFlock(opts) {
    const p = Object.assign({
      n: 600,
      k: 7,             // neighbours each bird tracks (topological)
      speed: 10,        // cruise speed, m/s
      contagion: 1.4,   // turning neighbours needed before a bird joins a wave;
                        // fractional = that share of birds need one more
      reaction: 0.07,   // s, mean neighbour-to-neighbour reaction delay
      turnTime: 0.45,   // s, how long one bird takes to complete its turn
      refractory: 1.6,  // s, after turning a bird ignores new waves this long
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
    const waves = new Map();      // id → wave, pruned once quiet
    const events = [];            // { i, wave, t } — drained by the page

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
          spawn(i, x * r, y * r * 0.6, z * r, 1 + rnd(-0.1, 0.1), rnd(-0.05, 0.05), rnd(-0.1, 0.1));
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

    // brute-force k nearest. half the flock per frame.
    function updateNeighbours() {
      const k = kNow();
      const parity = frame & 1;
      for (let i = parity; i < N; i += 2) {
        let filled = 0;
        const xi = px[i], yi = py[i], zi = pz[i];
        for (let j = 0; j < N; j++) {
          if (j === i) continue;
          const dx = px[j] - xi, dy = py[j] - yi, dz = pz[j] - zi;
          const d = dx * dx + dy * dy + dz * dz;
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
        const base = i * KMAX;
        for (let s = 0; s < k; s++) { nbr[base + s] = bestJ[s]; nbrD[base + s] = Math.sqrt(bestD[s]); }
      }
    }

    // ---- waves ----
    function newWave(kind, ax, ay, az, angle, t) {
      const m = Math.hypot(ax, ay, az) || 1;
      const w = { id: waveId++, kind, ax: ax / m, ay: ay / m, az: az / m, angle, t0: t, count: 0, last: t };
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

    // spontaneous wave: 75% yaw, 25% pitch. starts at an edge bird + its
    // neighbours.
    function initiate(t) {
      if (N < 2) return null;
      let seed = 0, far = -1;
      for (let s = 0; s < 6; s++) {
        const i = (Math.random() * N) | 0;
        const d = (px[i] - stats.cx) ** 2 + (py[i] - stats.cy) ** 2 + (pz[i] - stats.cz) ** 2;
        if (d > far) { far = d; seed = i; }
      }
      let w;
      const angle = rnd(0.9, 2.0) * (Math.random() < 0.5 ? -1 : 1);
      if (Math.random() < 0.75) {
        w = newWave("yaw", rnd(-0.25, 0.25), 1, rnd(-0.25, 0.25), angle, t);
      } else {
        // axis ⟂ heading in the horizontal plane → pitch the flock
        w = newWave("roll", -stats.mvz, 0, stats.mvx, angle * 0.5, t);
      }
      seedAround(seed, w, t);
      return w;
    }

    function seedAround(seed, w, t) {
      join(seed, w, t);
      const k = kNow(), base = seed * KMAX;
      for (let s = 0; s < k; s++) {
        const j = nbr[base + s];
        if (waveOf[j] !== w.id) join(j, w, t + 0.02 * s);
      }
    }

    // strike at (x,y,z): birds within `radius` turn away immediately; the
    // rest follow by contagion.
    function strike(t, x, y, z, radius) {
      const ox = stats.cx - x, oz = stats.cz - z;
      // yaw sign that swings the mean heading toward "away from the strike"
      const cross = stats.mvx * oz - stats.mvz * ox;
      const angle = rnd(1.6, 2.4) * (cross >= 0 ? -1 : 1);
      const w = newWave("strike", rnd(-0.35, 0.35), 1, rnd(-0.35, 0.35), angle, t);
      w.x = x; w.y = y; w.z = z;
      const r2 = radius * radius;
      let hit = 0;
      for (let i = 0; i < N; i++) {
        const d = (px[i] - x) ** 2 + (py[i] - y) ** 2 + (pz[i] - z) ** 2;
        if (d < r2) { join(i, w, t); hit++; }
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
          if (id === waveOf[j]) continue;   // already rode this one
          let m = 0;
          while (m < kinds && tallyId[m] !== id) m++;
          if (m === kinds) { tallyId[m] = id; tally[m] = 0; kinds++; }
          if (++tally[m] >= need) {
            const w = waves.get(id);
            if (w) join(j, w, t);
            break;
          }
        }
      }
    }

    // ---- motion ----
    // roost: slowly moving point the flock is pulled toward
    function roost(t) {
      return [
        22 * Math.sin(t / 41) + 9 * Math.sin(t / 13.7),
        4 * Math.sin(t / 29),
        16 * Math.sin(t / 53 + 1.3) + 6 * Math.sin(t / 17.3),
      ];
    }

    function rotate(i, ax, ay, az, a) {
      // Rodrigues: rotate v_i about unit axis by angle a
      const c = Math.cos(a), s = Math.sin(a);
      const x = vx[i], y = vy[i], z = vz[i];
      const dot = ax * x + ay * y + az * z;
      const cx = ay * z - az * y, cy = az * x - ax * z, cz = ax * y - ay * x;
      vx[i] = x * c + cx * s + ax * dot * (1 - c);
      vy[i] = y * c + cy * s + ay * dot * (1 - c);
      vz[i] = z * c + cz * s + az * dot * (1 - c);
    }

    function integrate(dt, t) {
      const k = kNow();
      const [rx, ry, rz] = roost(t);
      const v0 = p.speed;
      const rSep = 1.4;
      for (let i = 0; i < N; i++) {
        const base = i * KMAX;
        let mx = 0, my = 0, mz = 0, cx = 0, cy = 0, cz = 0, sx = 0, sy = 0, sz = 0;
        for (let s = 0; s < k; s++) {
          const j = nbr[base + s];
          mx += vx[j]; my += vy[j]; mz += vz[j];
          cx += px[j]; cy += py[j]; cz += pz[j];
          const d = nbrD[base + s];
          if (d < rSep && d > 1e-4) {
            const f = (rSep - d) / (rSep * d);
            sx += (px[i] - px[j]) * f; sy += (py[i] - py[j]) * f; sz += (pz[i] - pz[j]) * f;
          }
        }
        const ik = 1 / k;
        let ax = 2.6 * (mx * ik - vx[i]) + 0.9 * (cx * ik - px[i]) + 30 * sx;
        let ay = 2.6 * (my * ik - vy[i]) + 0.9 * (cy * ik - py[i]) + 30 * sy;
        let az = 2.6 * (mz * ik - vz[i]) + 0.9 * (cz * ik - pz[i]) + 30 * sz;
        // roost pull, stronger past 30 m
        const dx = rx - px[i], dy = ry - py[i], dz = rz - pz[i];
        const dh = Math.hypot(dx, dz);
        const pull = 0.035 + (dh > 30 ? 0.04 * (dh - 30) / dh : 0);
        ax += dx * pull; az += dz * pull;
        ay += dy * 0.12 - vy[i] * 0.6;   // altitude band + preference for level flight
        // noise
        ax += rnd(-1.5, 1.5); ay += rnd(-0.6, 0.6); az += rnd(-1.5, 1.5);

        vx[i] += ax * dt; vy[i] += ay * dt; vz[i] += az * dt;

        if (turnLeft[i] !== 0) {
          const w = waves.get(waveOf[i]);
          if (w) {
            let a = turnRate[i] * dt;
            if (Math.abs(a) > Math.abs(turnLeft[i])) a = turnLeft[i];
            rotate(i, w.ax, w.ay, w.az, a);
            turnLeft[i] -= a;
            if (Math.abs(turnLeft[i]) < 1e-4) turnLeft[i] = 0;
          } else turnLeft[i] = 0;
        }

        // relax toward cruise speed, clamp 0.55–1.6×
        let sp = Math.hypot(vx[i], vy[i], vz[i]) || 1e-6;
        const target = sp + (v0 - sp) * Math.min(1, dt * 1.5);
        const sc = Math.max(0.55 * v0, Math.min(1.6 * v0, target)) / sp;
        vx[i] *= sc; vy[i] *= sc; vz[i] *= sc;

        px[i] += vx[i] * dt; py[i] += vy[i] * dt; pz[i] += vz[i] * dt;

        // respawn on NaN
        if (!(px[i] === px[i] && vx[i] === vx[i])) {
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

    function step(dt, t) {
      if (N === 0) return;
      if (frame === 0) { updateNeighbours(); frame++; }
      updateNeighbours();
      contagion(t);
      integrate(dt, t);
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

  const MurmFlock = { createFlock, NMAX, KMAX, TAU };
  if (typeof module !== "undefined" && module.exports) module.exports = MurmFlock;
  else root.MurmFlock = MurmFlock;
})(typeof window !== "undefined" ? window : globalThis);
