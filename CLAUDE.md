# newspeech

Static site for audio/video experimentation. Plain HTML/CSS/JS — no build step, no framework. Lives at `www.newspeechsound.com` (Netlify, auto-deploys on push to `origin/main`).

## Site shape

- `index.html` — home / landing.
- `live.html` — embedded Strudel REPL (live-coding music) with a custom audio analyser tap, save/load of `.strudel` files, custom transport controls.
- `visualizers.html` — index page linking to numbered visualizer pages.
- `N-name.html` — individual visualizers (`1-streaks.html`, `2-static.html`, …), each a fullscreen `<canvas id="bg">`.
- `core.js` — shared visualizer infrastructure (intensity envelope, Poisson scheduler, mouse-activity tracking, parameter-panel shell). Loaded by every `N-*.html`.

## Visualizer conventions

Each visualizer page is one HTML file with its own draw logic. Boilerplate that's identical across pages lives in `core.js`; the visualizer's actual idea (the chevron bands, the ridge stack, the swarm field, etc.) stays inline per file.

**Shared infrastructure (`core.js`).** Loaded via `<script src="core.js">` before the page's inline script. Exposes `window.Newspeech` with:
- `intensity()` — overall mood/density driver, range `[0,1]`. When the mic is **off**, returns a slow-LFO envelope (sum of a few `Math.sin(t / N)`) plus mouse activity. When the mic is **on**, returns the smoothed audio level — every visualizer reacts to audio automatically without per-page changes. When a **tempo** is set (see `bpm()` below), an `exp(-beatPhase*4) * 0.7` pulse is folded in via `max()` so every visualizer gets a beat-synced lift without per-page wiring; pages that want a stronger beat reaction still opt in via `onBeat()`.
- `poisson(rateFn, fire)` — schedules events at a Poisson-distributed rate where the rate itself can vary (typically `intensity()`-driven). For naturalistic, non-grid timing.
- `installInputs(opts?)` — attaches the mousemove listener that bumps `mouseActivity`. Call once at startup. `opts` overrides `moveSensitivity` (default 0.004), `decay` (default 1.2/sec), `intensityMouseWeight` (default 0.4) for per-page tuning.
- `tickInputs(dt)` — call from the page's render loop (RAF or `setInterval`) with `dt` in seconds; decays mouse activity AND drives the audio analyser tick when the mic is active.
- `bumpActivity(target?)` — set mouse activity to at least `target` (default 1). Use in click handlers and other event-driven nudges.
- `installPanel(params)` — wires up the parameter-control panel: queries `<div id="panel">`, syncs `<input data-k="key">` sliders to `params[key]`, calls `window.onParamChange(k)` on change.
- `enableAudio()` / `disableAudio()` / `audioActive()` — programmatic mic control. The `a` key already toggles via the page-wide keydown handler in core.js, so manual calls are rarely needed.
- `audioLevel()` / `bandLevel("low"|"mid"|"high")` / `onset("low"|"mid"|"high")` — opt-in audio accessors for pages that want richer-than-`intensity()` reactivity (e.g. bass-driven invert flashes, kick-driven thrash bursts). Return `0`/`false` when the mic is off.
- `hazeAlongLine(ctx, x1, y1, x2, y2, opts?)` / `drawSoftDot(ctx, x, y, size, alpha, raw?)` / `softDotSprite()` / `hazeAmount()` / `setHaze(n)` — shared particle-glow primitives lifted from 18-chevron, with a single global multiplier exposed by the panel-globals "haze" slider (0–2, default 1). Both helpers multiply their alpha by `hazeAmount()` automatically, so visualizers don't have to plumb the global through. Pass `opts.raw = true` (or `raw=true` to `drawSoftDot`) to opt out — used when a call needs the global slider to NOT scale it (rare). `hazeAlongLine` defaults: `samples=60, jitter=10, alpha=0.06, dpr=1, size=1.0`. Tune samples way down (3-6) when calling per-segment along long polylines.
- `grainAmount()` / `setGrain(n)` — film-grain layer drawn on a dedicated `canvas#bg-grain` (z-index 2, `mix-blend-mode: screen`, sits between `#bg` and `#hud-overlay`). Pre-rendered noise tiles cycle ~12fps with a random offset each frame, so every visualizer gets vintage-feel grain without any per-page wiring. Strength comes from the panel-globals "grain" slider (0–1, default 0.5; mapped internally to 0..0.22 effective screen-blend opacity to match the look originally tuned in 18-chevron). Driven by `_tickGrain` inside `tickInputs`, so any page that calls `tickInputs(dt)` (all of them) gets it for free.
- `bpm()` / `beatPhase(div?)` / `beat()` / `onBeat(cb)` / `tap()` / `setBpm(n)` / `clearBpm()` — global tempo clock. `bpm()` returns 0 when no tempo is set (treat as "free-running"); when set, `beatPhase()` returns 0..1 within the current beat (or beat ÷ div, e.g. `beatPhase(4)` for sixteenths), and `onBeat(cb)` registers a callback fired on each beat crossing. The user sets tempo via the audio dialog (key `[t]` to tap, or type a bpm), so visualizers should opt-in by checking `bpm() > 0` rather than gating purely on whether they've been wired.
- `installMarkers({ params, getSource, getSourceDims, getEdgeData? })` / `tickMarkers(dt)` — source-driven HUD overlay for `N-*.html` pages that take a video/image source. The marker count + telemetry pick/shuffle now live in the **panel-globals block** (shared across the whole site, persisted in `localStorage` as `newspeech.dataPoints`); `installMarkers` no longer injects a per-page slider, but still has to be called so the page is registered as opted-in (and to register custom `getSource`/`getEdgeData`). Runs a sobel pass on `getSource()` at 480px long edge, pools markers anchored to high-magnitude pixels, snaps to local edge center-of-mass each frame, and draws `[xyz]` labels with nearest-neighbor connectors above whatever the page just rendered. `getEdgeData` is an optional opt-out: pages that already compute their own sobel (`10-edges.html`, `12-edgemask.html`) pass `() => ({mag, w, h})` to share the buffer and avoid a duplicate readback. Call `tickMarkers(dt)` at the end of the page's render path so markers sit on top.

**Parameter panel.** Toggle with `0`; sits at `bottom:32px right:32px`. CSS injected by `core.js`. Each page declares a `params` object and a `<div id="panel">` containing one `<label>` per slider with `<span class="name">`, `<span class="val">`, and `<input type="range" data-k="...">`. Page reads `params.foo` directly. For params that need a side-effect on change (e.g. retarget a particle pool), set `window.onParamChange = (k) => { ... }` before calling `installPanel`. `installPanel` also appends a `.panel-globals` block at the bottom with site-wide controls — `grayscale: on/off`, `contrast` (0.5–2.5, default 1.0), `grid: off/dots/grid/topo`, `grid opacity` (0–1, default 0.5), `haze` (0–2, default 1.0), `grain` (0–1, default 0.5), `data points` (0–128, default 14), and the `telemetry [pick] [s]` tap-row. Grayscale + contrast compose into a single CSS filter on `canvas#bg` via the `--ns-canvas-filter` custom property, so they work on mobile Safari (where `ctx.filter` silently no-ops pre-18). State persists in `localStorage` under `newspeech.grayscale` / `newspeech.contrast` / `newspeech.gridStyle` / `newspeech.gridOpacity` / `newspeech.haze` / `newspeech.grain` / `newspeech.dataPoints` / `newspeech.telemetryEnabled` / `newspeech.telemetryOrder`. Slider rows in the globals block are wrapped in `<div class="panel-row">` (not `<label>`) and carry `data-global="1"` so they're excluded from MIDI slot indexing — knobs continue to map to per-page sliders only.

**Background grid.** A separate `canvas#bg-grid` sits at `z-index: 0` behind `canvas#bg` (z-index 1); body bg `#050505` is what shows when grid style is `off` or opacity is `0`. The grid's CSS opacity is bound to a `--ns-grid-opacity` variable so the slider changes don't trigger a redraw. The canvas itself is redrawn only on style change or window resize. For the grid to be visible *through* the visualizer's gaps, every visualizer page clears its main canvas with `ctx.clearRect(0, 0, ...)` (transparent), not an opaque `ctx.fillStyle = "#050505"; ctx.fillRect(...)`. Pages that fade trails (5-stars, 9-swarm) use `globalCompositeOperation = "destination-out"` with an `rgba(0, 0, 0, alpha)` fillRect so trails decay toward transparent rather than toward an opaque dark layer — this is the correct pattern for any new trail-fade page that should sit on top of the bg-grid.

**Audio reactivity.** Press `a` anywhere on a visualizer page to toggle the mic. The mic is `getUserMedia` with AGC/echo/noise-suppression off so loud audio drives the analyser cleanly. When on, `intensity()` returns the smoothed mic level (gain-applied) so every existing visualizer reacts automatically. Bands and onsets follow the same tap pattern as `live.html`'s analyser.

**Audio dialog.** Toggle with `9` (bottom-left, mirrors the params panel in bottom-right). Built by `core.js`, shared across pages — no per-page setup. Contains: clickable mic on/off row, sensitivity slider (0.1×–5×, gain applied on every read of `audioLevel()` / `bandLevel()` / `intensity()`), and live low/mid/high band meters showing post-gain levels. Use the slider to compensate for ambient room volume — crank up for quiet music, pull back for loud.

**MIDI mapping.** Hardware knobs / faders sending MIDI CC drive the params-panel sliders by panel-slot position — knob 1 controls the first slider on whatever visualizer is open, knob 2 the second, etc. A "learn" button in the audio dialog enables the binding: while learn is on, the params panel sliders go inert and you click a slider then twist a knob to bind that CC to that slot. Mappings are global (cc → slot index) and persist in `localStorage` so the same physical knob keeps its slot across pages and reloads. Web MIDI is supported on Chromium (Chrome/Edge/Brave/Opera) and Safari 18+; Firefox shows an "unsupported" status. Slot indexing is by position of `<label>` containing an `<input type="range">` inside `#panel`, so if a page has 5 sliders and a controller has 8 knobs, the last 3 knobs do nothing on that page.

**Page-wide keys** (all live in `core.js`; pages don't wire keys themselves):
- `0` — toggle params panel
- `9` — toggle audio dialog
- `a` — toggle mic on/off
- `m` — toggle midi learn mode
- `t` — tap tempo (re-anchors beat 0 + refines bpm from running average; gap > 2s clears the buffer)

**Per-page markup:** dark `#050505` background, `<canvas id="bg">` fixed-positioned at `inset: 0`, cursor hidden, body overflow hidden. Standard OG/Twitter meta block.

When adding a new visualizer:
1. Copy an existing `N-*.html` as the starting scaffold.
2. Add an entry to `visualizers.html` (the `<ol>` and the count in the header).
3. Increment the number prefix.
4. Pick the params worth exposing on the panel (4–6 is a good range; the most meaningful knobs, not exhaustive).

## Renderer

Every visualizer page uses **2D canvas** (`getContext("2d")`). No Hydra. Even for visuals that look shader-field-y — continuous warps, moiré, infinite zoom — the right move is to express them in 2D primitives. The grid moiré (see `6-grid.html` and the equivalent mode in `live.html`) is the existence proof: two `drawGridLines()` calls with `globalCompositeOperation = "difference"` between them, plus `ctx.scale()` for zoom and noise-warped vertices for the modulate analogue.

If a piece seems to truly need WebGL shaders (heavy per-pixel feedback, e.g. `src(o0)`-style recursion), surface that as a question rather than silently bringing Hydra back. The Hydra gotchas (fn-arg → NaN, RAF swallowing) are documented in the memory file `hydra_fn_args.md` — relevant only if the Strudel REPL in `live.html` revives Hydra usage.

## Loading external libraries

Convention is **CDN via unpkg**, no local vendoring, no build step. Current example: `live.html` loads Strudel via `<script src="https://unpkg.com/@strudel/repl@latest">`. Visualizer pages (`N-*.html`) load only `core.js` from this repo — no third-party deps, no `<script src="...unpkg...">` (see *Renderer* above; ports stay in 2D canvas).

**Recommended (not yet applied):** pin versions instead of `@latest`. `@latest` on a deployed site can break unexpectedly when upstream ships changes. Form: `https://unpkg.com/<pkg>@<version>`.

## Roadmap notes (decisions made, not yet implemented)

- **Glitch / processed-video visualizers** are an active direction. The Strudel REPL is the prototyping surface (Strudel ships native Hydra integration — `await initHydra()`, FFT bins via `a.fft[...]`, pattern-clock-driven parameters — useful for sketching the look against music). Anything that graduates from REPL prototype into a published `N-*.html` page gets ported to 2D canvas per the *Renderer* rule above; the live-grid → `6-grid.html` port is the reference.
- **Asset-creation workflow** (when the goal is producing video assets, not live playback): prototype the look in the Strudel REPL, port into a 2D-canvas `N-*.html` page in this repo, capture via screen recording (Cmd+Shift+5 / OBS). WebCodecs-based in-browser encoding is the upgrade path if recording quality ever becomes a bottleneck.
- **Audio reactivity options:** FFT-driven (responds to amplitude/spectrum) vs. pattern-clock-driven (responds to the actual notes/cycles in a Strudel pattern). Pattern-clock is preferred for tightly-composed pieces because it accents specific events rather than chasing the waveform.

## Fonts

Project uses a custom `zxx-*` family (sans/bold/noise/camo/xed) loaded from `fonts/`. The home and visualizers index do font-cycling on hover plus Poisson-scheduled character scrambling — that's the signature interaction. Reuse the pattern when adding pages with prominent text.
