# newspeech

Static site for audio experimentation. Plain HTML/CSS/JS — no build step, no framework. Lives at `www.newspeechsound.com` (Netlify, auto-deploys on push to `origin/main`).

## Site shape

- `index.html` — home / landing.
- `live.html` — embedded Strudel REPL (live-coding music) with a custom audio analyser tap, save/load of `.strudel` files, custom transport controls.
- `visualizers.html` — index page linking to numbered visualizer pages.
- `N-name.html` — individual visualizers (`1-streaks.html`, `2-static.html`, …), each a fullscreen `<canvas id="bg">`.
- `core.js` — shared visualizer infrastructure (intensity envelope, Poisson scheduler, mouse-activity tracking, parameter-panel shell). Loaded by every `N-*.html`.

## Visualizer conventions

Each visualizer page is one HTML file with its own draw logic. Boilerplate that's identical across pages lives in `core.js`; the visualizer's actual idea (the chevron bands, the ridge stack, the swarm field, etc.) stays inline per file.

**Shared infrastructure (`core.js`).** Loaded via `<script src="core.js">` before the page's inline script. Exposes `window.Newspeech` with:
- `intensity()` — overall mood/density driver, range `[0,1]`. When the mic is **off**, returns a slow-LFO envelope (sum of a few `Math.sin(t / N)`) plus mouse activity. When the mic is **on**, returns the smoothed audio level — every visualizer reacts to audio automatically without per-page changes.
- `poisson(rateFn, fire)` — schedules events at a Poisson-distributed rate where the rate itself can vary (typically `intensity()`-driven). For naturalistic, non-grid timing.
- `installInputs(opts?)` — attaches the mousemove listener that bumps `mouseActivity`. Call once at startup. `opts` overrides `moveSensitivity` (default 0.004), `decay` (default 1.2/sec), `intensityMouseWeight` (default 0.4) for per-page tuning.
- `tickInputs(dt)` — call from the page's render loop (RAF or `setInterval`) with `dt` in seconds; decays mouse activity AND drives the audio analyser tick when the mic is active.
- `bumpActivity(target?)` — set mouse activity to at least `target` (default 1). Use in click handlers and other event-driven nudges.
- `installPanel(params)` — wires up the parameter-control panel: queries `<div id="panel">`, syncs `<input data-k="key">` sliders to `params[key]`, calls `window.onParamChange(k)` on change.
- `enableAudio()` / `disableAudio()` / `audioActive()` — programmatic mic control. The `a` key already toggles via the page-wide keydown handler in core.js, so manual calls are rarely needed.
- `audioLevel()` / `bandLevel("low"|"mid"|"high")` / `onset("low"|"mid"|"high")` — opt-in audio accessors for pages that want richer-than-`intensity()` reactivity (e.g. bass-driven invert flashes, kick-driven thrash bursts). Return `0`/`false` when the mic is off.

**Parameter panel.** Toggle with `0`; sits at `bottom:32px right:32px`. CSS injected by `core.js`. Each page declares a `params` object and a `<div id="panel">` containing one `<label>` per slider with `<span class="name">`, `<span class="val">`, and `<input type="range" data-k="...">`. Page reads `params.foo` directly. For params that need a side-effect on change (e.g. retarget a particle pool), set `window.onParamChange = (k) => { ... }` before calling `installPanel`.

**Audio reactivity.** Press `a` anywhere on a visualizer page to toggle the mic. The mic is `getUserMedia` with AGC/echo/noise-suppression off so loud audio drives the analyser cleanly. When on, `intensity()` returns the smoothed mic level (gain-applied) so every existing visualizer reacts automatically. Bands and onsets follow the same tap pattern as `live.html`'s analyser.

**Audio dialog.** Toggle with `9` (bottom-left, mirrors the params panel in bottom-right). Built by `core.js`, shared across pages — no per-page setup. Contains: clickable mic on/off row, sensitivity slider (0.1×–5×, gain applied on every read of `audioLevel()` / `bandLevel()` / `intensity()`), and live low/mid/high band meters showing post-gain levels. Use the slider to compensate for ambient room volume — crank up for quiet music, pull back for loud.

**MIDI mapping.** Hardware knobs / faders sending MIDI CC drive the params-panel sliders by panel-slot position — knob 1 controls the first slider on whatever visualizer is open, knob 2 the second, etc. A "learn" button in the audio dialog enables the binding: while learn is on, the params panel sliders go inert and you click a slider then twist a knob to bind that CC to that slot. Mappings are global (cc → slot index) and persist in `localStorage` so the same physical knob keeps its slot across pages and reloads. Web MIDI is supported on Chromium (Chrome/Edge/Brave/Opera) and Safari 18+; Firefox shows an "unsupported" status. Slot indexing is by position of `<label>` containing an `<input type="range">` inside `#panel`, so if a page has 5 sliders and a controller has 8 knobs, the last 3 knobs do nothing on that page.

**Page-wide keys** (all live in `core.js`; pages don't wire keys themselves):
- `0` — toggle params panel
- `9` — toggle audio dialog
- `a` — toggle mic on/off
- `m` — toggle midi learn mode

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
