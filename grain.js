// grain.js — the site-wide film-grain overlay for content pages.
//
// a compact standalone copy of the core.js #bg-grain layer: screen-blended
// animated noise tiles (~12fps cycle, random offset per frame) over the whole
// viewport. honors the global grain slider via the same localStorage key, so
// intensity stays consistent with the visualizer pages.
//
// usage: <script src="grain.js"></script> (or ../grain.js from a subdir).
// no-op on pages that already run the core.js grain layer.
(function () {
  "use strict";
  if (window.Newspeech || document.getElementById("bg-grain")) return; // core.js owns grain there

  let amount = 0.5;
  try {
    const v = parseFloat(localStorage.getItem("newspeech.grain"));
    if (isFinite(v)) amount = Math.max(0, Math.min(1, v));
  } catch (_) {}
  if (amount <= 0) return;

  const canvas = document.createElement("canvas");
  // half the core.js coefficient (0.22): over static text pages the same
  // opacity reads much heavier than over a moving visualizer.
  canvas.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2;mix-blend-mode:screen;opacity:" + (amount * 0.11).toFixed(3);
  document.body.appendChild(canvas);
  const ctx = canvas.getContext("2d");

  const tiles = [];
  for (let n = 0; n < 6; n++) {
    const off = document.createElement("canvas");
    off.width = off.height = 256;
    const octx = off.getContext("2d");
    const img = octx.createImageData(256, 256);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const fine = Math.random();
      const coarse = (Math.random() + Math.random() + Math.random()) / 3;
      const v = (fine * 0.7 + coarse * 0.3) * 200;
      d[i] = v; d[i + 1] = v; d[i + 2] = v; d[i + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    tiles.push(off);
  }

  function size() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    canvas.width = Math.floor(window.innerWidth * dpr);
    canvas.height = Math.floor(window.innerHeight * dpr);
    canvas.style.width = window.innerWidth + "px";
    canvas.style.height = window.innerHeight + "px";
  }
  size();
  window.addEventListener("resize", size);

  (function tick() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const tile = tiles[(performance.now() / 80 | 0) % tiles.length];
    const tw = tile.width * 1.5 * dpr, th = tile.height * 1.5 * dpr;
    const offX = -((Math.random() * tw) | 0), offY = -((Math.random() * th) | 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = offY; y < canvas.height; y += th) {
      for (let x = offX; x < canvas.width; x += tw) {
        ctx.drawImage(tile, x, y, tw, th);
      }
    }
    requestAnimationFrame(tick);
  })();
})();
