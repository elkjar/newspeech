# newspeech

Static site for audio experimentation. Plain HTML/CSS/JS — no build step, no framework. Each page is self-contained. Lives at `www.newspeechsound.com` (Netlify, auto-deploys on push to `origin/main`).

## Site shape

- `index.html` — home / landing.
- `live.html` — embedded Strudel REPL (live-coding music) with a custom audio analyser tap, save/load of `.strudel` files, custom transport controls.
- `visualizers.html` — index page linking to numbered visualizer pages.
- `N-name.html` — individual visualizers (`1-streaks.html`, `2-static.html`, …). Self-contained, fullscreen `<canvas id="bg">`.

## Visualizer conventions

Every visualizer page follows the same structural pattern:

- **Markup:** dark `#050505` background, `<canvas id="bg">` fixed-positioned at `inset: 0`, cursor hidden, body overflow hidden. Standard OG/Twitter meta block.
- **Shared idioms** (re-implemented per file, not factored out — keeps each page self-contained):
  - `intensity()` — slow-LFO envelope, sums a few `Math.sin(t / N)` terms with different periods, clamped to `[0, 1]`. Drives overall mood/density across the visualizer. Some pages also fold in a `mouseActivity` term.
  - `poisson(rateFn, fire)` — schedules events at a Poisson-distributed rate where the rate itself can vary (typically driven by `intensity()`). Used for naturalistic, non-grid timing of bursts/spawns.
- **No shared script file** — duplication is intentional. Each visualizer is standalone so it can evolve without coupling.

When adding a new visualizer:
1. Copy an existing `N-*.html` as the starting scaffold.
2. Add an entry to `visualizers.html` (the `<ol>` and the count in the header).
3. Increment the number prefix.

## Renderer choice

Pen-and-ink visuals (lines, particles, glyphs, filled shapes) → 2D canvas (`getContext("2d")`). Shader-field visuals (continuous warps, modulate-driven coord interference, recursive feedback, kaleid mirroring) → Hydra via `hydra-synth` from unpkg. Don't reach for Hydra by default just because a piece is audio-reactive — both renderers can read `lowLevel` / `audioLevel` from the analyser tap.

Hydra (currently `hydra-synth@1.4.0` via `https://unpkg.com/hydra-synth`) has two known traps on this site:

- **fn-arg → NaN → white canvas.** `.modulate(src, () => n)`, `.rotate(() => n)`, and `.scrollX(0, () => n)` silently produce a fully-white canvas — the function arg reaches the GLSL as NaN. Only single-scalar fn-args like `.scale(() => n)`, `.brightness(() => n)`, `.invert(() => n)`, `.thresh(() => n)` are reliable. For other channels, drive `window.__*` globals from a `setInterval` and re-issue the chain with static numeric args (the chain-factory pattern in `6-grid.html` is the reference).
- **requestAnimationFrame swallowing.** Once `new Hydra(...)` runs, external `requestAnimationFrame` callbacks queued by site code stop firing. Use `setInterval` (≈50ms / 20Hz) for any non-Hydra render or polling loop on a Hydra page. Hydra's own canvas keeps rendering at full RAF cadence on its internal loop; only external RAF is affected.

If `hydra-synth` later pins to a newer version, retest both before assuming the rules still hold.

## Loading external libraries

Convention is **CDN via unpkg**, no local vendoring, no build step. Current example: `live.html` loads Strudel via `<script src="https://unpkg.com/@strudel/repl@latest">`. Hydra (`hydra-synth`) is loaded the same way — see *Renderer choice* above for its quirks.

**Recommended (not yet applied):** pin versions instead of `@latest`. `@latest` on a deployed site can break unexpectedly when upstream ships changes. Form: `https://unpkg.com/<pkg>@<version>`.

## Roadmap notes (decisions made, not yet implemented)

- **Glitch / processed-video visualizers** are an active direction. The chosen toolchain is **Hydra** (live-coded WebGL video synth) for visuals, paired with **Strudel** for music. Strudel ships native Hydra integration (`await initHydra()`, FFT bins via `a.fft[...]`, pattern-clock-driven parameters) — that pairing is the intended design surface.
- **Asset-creation workflow** (when the goal is producing video assets, not live playback): prototype the look in the Strudel+Hydra REPL, port the Hydra code into a standalone fullscreen `N-*.html` page in this repo, capture via screen recording (Cmd+Shift+5 / OBS). WebCodecs-based in-browser encoding is the upgrade path if recording quality ever becomes a bottleneck.
- **Audio reactivity options:** FFT-driven (responds to amplitude/spectrum) vs. pattern-clock-driven (responds to the actual notes/cycles in a Strudel pattern). Pattern-clock is preferred for tightly-composed pieces because it accents specific events rather than chasing the waveform.

## Fonts

Project uses a custom `zxx-*` family (sans/bold/noise/camo/xed) loaded from `fonts/`. The home and visualizers index do font-cycling on hover plus Poisson-scheduled character scrambling — that's the signature interaction. Reuse the pattern when adding pages with prominent text.
