# newspeech

Static site for audio/video experimentation. Plain HTML/CSS/JS — no build step, no framework. Lives at `www.newspeechsound.com` (Netlify auto-deploys on push to `origin/main`).

## Site shape

- `index.html` — home / landing.
- `live.html` — embedded Strudel REPL (live-coding music) with a custom audio analyser tap, save/load of `.strudel` files, custom transport controls.
- `visualizers.html` — index linking to numbered visualizer pages.
- `N-name.html` — individual visualizers (`1-streaks.html`, `2-static.html`, …), each a fullscreen `<canvas id="bg">`.
- `core.js` — shared visualizer infrastructure (mouse/audio/timing inputs, params panel, visual helpers). Loaded by every `N-*.html` before its inline script.

## Visualizer page anatomy

Each page is one HTML file with its own draw logic. Boilerplate identical across pages lives in `core.js`; the visual idea stays inline.

**Markup:** dark `#050505` body, `<canvas id="bg">` fixed at `inset:0`, cursor hidden, body overflow hidden. Standard OG/Twitter meta block.

**Render path:** clear with `ctx.clearRect(...)` (transparent — never opaque fill) so the bg-grid behind the canvas shows through gaps. For trail fades, use `globalCompositeOperation = "destination-out"` with `rgba(0,0,0,alpha)` rather than a dark fill — trails decay to transparent.

**Renderer:** 2D canvas (`getContext("2d")`). No Hydra, even for shader-field-looking effects (continuous warps, moiré, infinite zoom — all expressible in 2D; `6-grid.html` is the reference for the moiré case via two `drawGridLines()` passes with `globalCompositeOperation = "difference"`). If a piece truly needs per-pixel feedback shaders, surface that as a question — don't silently bring Hydra back. Hydra gotchas live in `hydra_fn_args.md` memory.

## `core.js` API (`window.Newspeech`)

See `core.js` for signatures and defaults; this is the orientation map.

**Inputs & lifecycle**
- `installInputs(opts?)` — attach mousemove listener (call once at startup).
- `tickInputs(dt)` — call from render loop with seconds; decays mouse activity, drives audio + grain ticks.
- `bumpActivity(target?)` — manually bump mouse-activity (use in click handlers).

**Drivers** (the values draw functions read)
- `intensity()` → `[0,1]` — automatic envelope. Mic off: LFO + mouse activity. Mic on: smoothed audio level. Tempo set: folds in an `exp(-beatPhase*4)*0.7` pulse via `max()`. Every visualizer reacts to audio + beat for free.
- `audioLevel()` / `bandLevel("low"|"mid"|"high")` / `onset(...)` — richer audio reactivity (returns 0/false when mic off).
- `poisson(rateFn, fire)` — non-grid event scheduling; rate can vary per-call (typically `intensity()`-driven).

**Tempo clock** — `bpm()` returns 0 when free-running; gate beat logic on `bpm() > 0`.
- `beatPhase(div?)`, `beat()`, `onBeat(cb)`, `tap()`, `setBpm(n)`, `clearBpm()`.

**Visual helpers** (multiply alpha by global haze/grain sliders automatically; pass `raw=true` to opt out)
- `drawSoftDot(ctx, x, y, size, alpha, raw?)` / `softDotSprite()`
- `hazeAlongLine(ctx, x1, y1, x2, y2, opts?)` — defaults work for short segments; drop `samples` to 3–6 for long polylines.
- `setHaze(n)` / `hazeAmount()`, `setGrain(n)` / `grainAmount()` — manual access; usually driven by panel sliders.

**Markers** (telemetry overlay) — opt-in for pages with a video/image source.
- `installMarkers({ getSource, getSourceDims, getEdgeData? })` — register; count + pick/shuffle live in panel-globals.
- `tickMarkers(dt)` — call at end of render so markers sit on top.
- Pages that already compute sobel (`10-edges.html`, `12-edgemask.html`) pass `getEdgeData` to share the buffer.

## Controls

**Params panel** (key `0`, bottom-right). Each page declares a `params` object + a `<div id="panel">` with `<label>` rows containing `<input type="range" data-k="key">`. Page reads `params.foo` directly. For side-effects on change, set `window.onParamChange = (k) => {...}` before `installPanel(params)`.

**Panel globals** (appended to the panel by `installPanel`). Site-wide controls applied to every page: `grayscale`, `contrast`, `grid` (off/dots/grid/topo), `grid opacity`, `haze`, `grain`, `data points`, `telemetry [pick] [s]`. Grayscale + contrast compose via `--ns-canvas-filter` (CSS filter on `canvas#bg`) — works on mobile Safari where `ctx.filter` no-ops pre-18. All state persists under `newspeech.*` localStorage keys. Globals rows are wrapped in `<div class="panel-row">` with `data-global="1"` so MIDI slot indexing skips them.

**Audio dialog** (key `9`, bottom-left). Mic on/off, sensitivity slider (0.1×–5×, applied to all `audioLevel`/`bandLevel`/`intensity` reads), live low/mid/high band meters, tempo input (type bpm or tap with `t`). Mic uses `getUserMedia` with AGC/echo/noise-suppression off so loud audio drives the analyser cleanly.

**MIDI mapping.** Hardware CC drives params-panel sliders by slot position — knob 1 → first slider, knob 2 → second, etc. Toggle learn with `m`; click a slider then twist a knob to bind a CC to that slot. Mappings persist in `localStorage` keyed by CC → slot index, so the same physical knob keeps its slot across pages. Web MIDI works on Chromium + Safari 18+, not Firefox.

**Page-wide keys** (all in `core.js`):
- `0` params panel · `9` audio dialog · `a` mic · `m` midi learn · `t` tap tempo

## Background grid

Separate `canvas#bg-grid` at `z-index:0` behind `canvas#bg` (z-index 1); body bg `#050505` shows through when grid is off or opacity is 0. Grid CSS opacity is bound to `--ns-grid-opacity` so slider changes don't trigger a redraw. The canvas itself is redrawn only on style change or window resize.

## Adding a visualizer

1. Copy an existing `N-*.html` as the scaffold.
2. Add an entry to `visualizers.html` (the `<ol>` and the count in the header).
3. Increment the number prefix.
4. Pick 4–6 params for the panel — the most meaningful knobs, not exhaustive.

## External libraries

CDN via unpkg, no local vendoring, no build step. `live.html` loads Strudel via `<script src="https://unpkg.com/@strudel/repl@latest">`. Visualizer pages load only `core.js` from this repo. Pin versions over `@latest` when stability matters.

## Fonts

Custom `zxx-*` family (sans/bold/noise/camo/xed) loaded from `fonts/`. Home and visualizers index do font-cycling on hover plus Poisson-scheduled character scrambling — that's the signature interaction; reuse for any new page with prominent text.
