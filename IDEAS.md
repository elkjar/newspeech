# IDEAS

Things in flight for newspeech. Stable conventions and decided direction live in `CLAUDE.md`; this file is for in-progress ideas with open questions. Items here may shift, get reordered, or get killed.

---

## 1. Homepage Hydra background

Autonomous Hydra piece behind the existing typography on `index.html`. Same vibe as the standalone visualizers — no audio reactivity, no interaction, just atmosphere. Typography remains the focal point; Hydra is mood underneath.

Treat homepage Hydra and the Strudel-player (`live.html`) backgrounds as **separate concerns** — different audiences, different intent. Don't share code between them.

**Status of related work.** Standalone visualizer integration shipped: `6-grid.html` (Hydra), `7-ridges.html` and `8-rings.html` (2D canvas, audio-shaped sibling visuals). The renderer-choice rule (pen-and-ink → 2D canvas, shader fields → Hydra) and Hydra gotchas live in `CLAUDE.md`. `live.html` now hosts all eight visualizer modes (keys 1–8 lock, 0 resumes auto-cycle).

**Open:** does the homepage Hydra piece stay fixed, or rotate through several over time / on reload?

---

## 2. Custom sample library — every sound on the site is original

Replace **all** prebuilt sounds in the Strudel patches — both the drum samples and the built-in oscillators — with custom-recorded material. Premise: prebuilt anything reads as borrowed; if every sound is yours, the site has a single coherent audio identity. Lines up with the "art project, not utility" framing in #3.

### What needs replacing

**Drum samples** (currently Strudel's bundled bank):
- `bd` — kick
- `hh` — hi-hat
- `cp` — clap

**Synthesized voices** (currently Strudel's built-in oscillators on `note(...).s("...")`, extracted from the 5 patches in `live.html`):
- **Bass** — sawtooth/sine, low register (c1–c3); used in all 5 patches
- **Lead / arp** — square wave, mid register (c4–g5); used in `transmission`, `lattice`
- **Bells** — triangle wave, high register (c4–c6); used in `vacuum`, `lattice`, `halo`
- **Drone / pad** — slow swept sawtooth, low/mid register; used in `halo`
- **Sub** — sine, very low (c1–ab1); used in `vacuum`, `lattice`

Five voice categories. Could collapse (bell + lead together) or split further depending on what actually gets recorded — the patches will adapt to whatever the bank ends up being.

### Multisample approach

Strudel supports anchor-pitch multisampling — define a few base pitches per voice, Strudel pitch-shifts to fill the rest:

```js
samples({
  bass: { c2: 'samples/bass-c2.wav', g2: 'samples/bass-g2.wav', c3: 'samples/bass-c3.wav' }
})
note("c2 g1 a1").s("bass")   // pitch-shifts from nearest anchor
```

So you don't record every semitone — record 2–3 anchor pitches per voice across the range it covers and let Strudel interpolate.

### Pitches used across current patches

Reference for recording — pitches that actually appear:
- **Bass range:** c1, ab1, a1, bb1, e1, f1, g1, c2, eb2, g2, ab2, c3, eb3, g3
- **Lead / bell range:** c4, eb4, g4, bb4, c5, eb5, g5, bb5, c6
- Note vocabulary stays in natural minor / minor-pentatonic territory across all 5 patches

### Rough budget

3 drums + 5 voices × ~3 anchor pitches each ≈ **15–20 samples total**. ~5MB each at 16-bit/44.1k stereo, ~100MB library — comfortably on Netlify. First-load of `live.html` grows but stays acceptable; lazy-load per-patch is the optimization if it ever bites.

### Honest framing

Significantly more tracking than the original 3-drum plan — call it a multi-session recording project rather than a one-afternoon pass. Engineering is still small (just `samples({...})` declarations + dropping existing `s("...")` calls onto the new bank). The work is in the studio.

---

## 3. Audio file showcase / pseudo-filesystem browser

New page on the site — file-explorer-style UI for browsing → previewing → downloading audio files. Showcases the band's work as individual elements (stems, samples, sketches) rather than only as cohesive releases. **Framing: art project, not utility.**

**Tech shape:** vanilla HTML/JS, `<audio>` for preview, `<a download>` for the file. Files hosted on Netlify to start (100GB/mo free-tier bandwidth — fine for an art piece; revisit only if traffic ever forces the question). UI leans into the newspeech aesthetic — ASCII tree, monospace, dark.

**License:** all files Creative Commons ShareAlike. Surface the license prominently on the page header and on each file's metadata row.

**Dependency with #2:** the sample library and this showcase share source material. Sample library = building blocks (one-shots, hits, loops); showcase = curated finished pieces and stems. Worth recording/curating with both uses in mind from the start so a single session feeds both.

**Open:** file-tree taxonomy — by track? by instrument? by session? by date? Decide before populating; restructuring later is annoying.

---

## 4. Multi-block Strudel arrangements

Goal: extend current single-loop patches into structured arrangements (intro / verse / chorus / breakdown / etc.) where blocks fire sequentially or after N cycles.

**Framing:** auxiliary release alongside traditionally-recorded studio output. The project's premise is the pairing of analog studio craft with this digital frontier — Strudel arrangements aren't trying to replicate a DAW, they're a different shape of artifact entirely.

**Native Strudel primitive:** `arrange([cycles, pattern], ...)` — sequences patterns by cycle counts. e.g.:

```js
arrange(
  [8,  intro],
  [16, verse],
  [8,  chorus],
  [16, verse2],
  [8,  outro]
)
```

Combined with `every`, `whenmod`, and conditional `mask`s, covers most pop/electronic structures.

**Collaboration workflow:**
1. You describe the flow (cycles per section, what enters/exits, key moments, tempo, mood).
2. I draft the `arrange` block plus the per-section patterns.
3. We iterate live in `live.html`.

**Hard ceiling to know upfront:** perfectly-timed one-shot stingers, automation curves over a 4-minute timeline, and other DAW-grade work eventually hits the wall. For pieces that need that level of timeline control, render Strudel stems and assemble in the studio. That hybrid is on-brand for the project.
