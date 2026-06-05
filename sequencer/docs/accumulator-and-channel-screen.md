# Plan — Accumulator (mutate upper-half) + focused-channel piano-roll screen

Notated 2026-06-04 for a build pass. Two related features, inspired by hardware:
the **Intellijel Metropolix accumulator** and the **Reliq** big focused-channel
screen. Decisions confirmed with Chris are marked ✅; the one open call is marked ⚠️.

---

## Feature 1 — Accumulator (replaces the upper half of `mutate`)

### Why
`mutate` today escalates into "writing new patterns" at the top of its range
(for leads: fork 2 = octave leaps; for stochastic voices: heavy dice). That reads
as *new* rather than *developed*. The accumulator replaces that top tier with a
**deterministic, coherent climb** — each loop pass transposes the pattern by a set
amount, builds up, then wraps home. Contour and rhythm are preserved; only pitch
ladders. More musical than rolling new notes.

### Build phasing (revised 2026-06-04)
Ship the **per-step accumulator standalone first**, validate it musically, *then* lift
the same mechanic to the track level under the mutate knob. Rationale: the per-step
path is self-contained (one sparse plock + an offset in `runTick` + inspector UI),
while the knob remap touches `mutationTree`, fork-dropping, `accDepth`, and Ghost's
combined mapping. No reason to take that risk before the climb proves itself.

- **Phase 1 (build first) — per-step accumulator only.** `Step.accumulator?`,
  independent per-`(track,step)` counters (per-fire), offset applied in `runTick`,
  inspector section. NO knob remap, NO track accumulator, NO role defaults, NO
  `mutationTree` changes. The accumulator doesn't exist unless authored on a step.
- **Phase 2 (after Phase 1 feels right) — lift into `mutate`.** Track-level
  accumulator on the knob's upper half, the fork-2 drop, `accDepth` reach-scaling,
  Ghost combined mapping. Everything in "Confirmed decisions" below is Phase 2.
  Expectation (Chris): it extends cleanly because the per-step mechanic is the same
  ladder, just driven by one per-track counter instead of per-step ones.

The rest of this section describes the **full** design; the *Mechanics*, *Data model*,
and *inspector* subsections apply to Phase 1, the *knob remap* / *track counter* /
*role defaults* parts are Phase 2.

### Confirmed decisions (Phase 2 — knob integration)
- ✅ **Knob remap = "Accumulator replaces it."** `mutate` (`track.mutation`, 0..1)
  splits at 0.5:
  - **0.0–0.5 "Vary":** existing mutation, with its full useful range compressed
    into the lower half. For leads, the tree opens **forks 0 + 1 only** (diatonic
    shift + fifth leaps) — **fork 2 (octave leaps) is dropped from the knob.** For
    stochastic voices, dice scale 0→full by 0.5, then hold.
  - **0.5–1.0 "Accumulate":** accumulator depth ramps 0→full. No octave-leap / heavy-
    dice escalation up here anymore.
- ✅ **Unit = scale degrees.** Climbs diatonically, stays in key, resolves home on
  wrap. Composes with the existing scale-degree pitch model for free.

### Resolved 2026-06-04
- ✅ **Both layers.** Accumulation lives within `mutate` (track-level, driven by the
  knob's upper half) AND exists as an independent per-step function authored in the
  inspector. The two compose: the knob develops the whole channel; per-step plocks
  make specific notes climb on their own regardless of the knob. (Implementation =
  track default/role default + per-step override, per below — the per-step path is
  first-class, not just an override of the track default.)

### Mapping math (`tick.ts`)
Let `m = mutControl + ghostLeadMutation(track.id)` (the existing combined value at
`tick.ts:752`, so Ghost can drive accumulation autonomously — Ghost "develops by
climbing," very on-theme for the Wreckage-Systems direction).

```
varyAmount = clamp(m / 0.5, 0, 1)      // existing mutation, full by 0.5, holds after
accDepth   = clamp((m - 0.5) / 0.5, 0, 1)  // accumulator, 0 below 0.5, full at 1.0
```

- **Leads:** feed the tree `treePos = varyAmount`, and **cap fork opening at 2 forks**
  (drop fork 2). Concretely: `openForkCount` reach uses `varyAmount * 2` instead of
  `treePos * FORK_LEVELS` (or set a `MAX_OPEN_FORKS = 2` and clamp in
  `mutationTree.ts:150` + the parallel reach loop at `:352`). Octave drama now comes
  from the accumulator's climb, not a fork.
- **Stochastic (bass/pad):** dice axes scale by `varyAmount`. Accumulator applies on
  top in the upper half.
- **Drums (unpitched):** accumulator is a **no-op on pitch**. Upper half just holds
  the lower-half dice/density. (Possible later extension: accumulate velocity or
  ratchet count instead — noted, out of scope for v1.)

### Mechanics (finalized 2026-06-04)
Each accumulator (track-level and per-step) has three authored params:
- **`step`** — signed scale degrees added per rung (−7…+7). Climb size + direction.
- **`range`** — rungs before it turns/resets (1–8). Ladder height; what brings it home.
- **`shape`** — `'wrap' | 'bounce' | 'hold'`:
  - `wrap` — `rung = c % range` (sawtooth, snap home).
  - `bounce` — triangle, period `2*(range-1)`: `p = c % (2*(range-1)); rung = p < range ? p : 2*(range-1) - p`.
  - `hold` — `rung = min(c, range-1)` (climb once, stay; only a reset event clears it).

  where `c` = the track's loop counter.
- **Rate = once per loop** (hardcoded v1; `c` increments on each pattern-length wrap).
- **Chance = deferred** (later pass — probability the rung advances on each loop).

Applied degree offset = `step * rung`, added in `runTick` alongside `treePitchJump`
in scale-degree space (then scale-quantized like all other pitch).

### Data model (`store.ts`)
Sparse plock on `Step`, mirroring the existing `chordVoicing?` pattern (`store.ts:52`):

```ts
interface AccumulatorCfg { step: number; range: number; shape: 'wrap'|'bounce'|'hold'; }
// Step.accumulator?: AccumulatorCfg     // undefined → no per-step climb
// Track.accumulator?: AccumulatorCfg    // role default below
```

Role defaults (track-level): `lead {+1, range 4, bounce}`, `bass {+1, range 3, wrap}`,
`pad {+1, range 8, bounce (slow)}`.

Setter `setStepAccumulator(trackId, index, cfg | undefined)` — immutable map, same
shape as `setStepVelocity` (`store.ts:1485`).

### Runtime accumulation state (ephemeral — like `treeState.ts`)
**Two independent counter systems**, both module-level, **not** persisted (playback
state). This is the key musical lever — per-step ladders drift against each other and
against the track ladder (the "intersecting unsynced systems" aesthetic, per
[[feedback-intersecting-systems]]).

**1. Track counter** — `Map<trackId, c>`, ONE per track.
- Increment `c` at the track's **loop boundary** (local step wraps `track.length`).
- Applies a **uniform** climb across the whole pattern (the "lives within `mutate`"
  layer).
- Scaled by the knob via `accDepth` on the *reach into Range*:
  `effRange = max(1, round(range * accDepth))`, then `rung` from the shape formula with
  `effRange`. At `accDepth = 0` → `effRange = 1` → rung always 0 (flat). Cranking opens
  more rungs — clean integers, no fractional climb.

**2. Per-step counters** — `Map<trackId, Map<stepIndex, c_s>>`, INDEPENDENT per step.
- Increment `c_s` **when that step fires** (read rung, then bump after it sounds — so a
  step's first sounding = rung 0 / home). Identical to per-loop for always-on steps;
  decouples once Chance/conditionals land, and holds place when a step is off.
- Each wraps on its **own authored `range`/`shape`**; none resets any other. Ignores
  `accDepth` — full ladder, the independent function.

**Composition = STACK:** a step's total offset =
`trackStep * trackRung(c, effRange)` + `stepStep * stepRung(c_s, stepRange)`, added in
`runTick` alongside `treePitchJump`, in scale-degree space (then scale-quantized like
all other pitch). Rein in with Range if it compounds too far.

- **Reset all counters (`c` and every `c_s`) to 0 on:** transport stop, bank swap,
  scene swap, song swap, init/clear. (Same reset surface as `resetBranchWalk`; `hold`
  shape only clears on these.)
- **Freeze:** hold all counters (don't advance) so a freeze captures the current rungs.

**Tune by ear** — build the audible increment first, audition in the Sequence app.

### Step inspector UI (`StepInspector.tsx`)
New section below chord voicing, same `LabeledSelect` + `×`-to-clear pattern:
- `S` (step): −7..+7 degrees (curated set: −2,−1,+1,+2,+3,+4,+5,+7)
- `R` (range): 1..8 rungs
- `⟳` (shape): wrap / bounce / hold
- Plocked → labels/values brighten to full white; no per-step accumulator → dim; `×`
  clears the per-step plock.
- Tiny live readout of the **current rung** for that step (e.g. `+2`) so the
  inspector reflects playback. Monochrome only.
- Track-default editing UI is a follow-up; v1 uses role defaults (no UI) + per-step.

---

## Feature 2 — Focused-channel piano-roll screen (Reliq-style)

### Confirmed framing
✅ Not a multi-track overview. It's a **piano roll of the channel you're currently
interacting with** — exactly like Reliq's big top screen, which shows the focused
channel's roll. It follows your editing focus.

✅ **It's THE "computed view" — the live visualizer for every runtime modulation, not
just the accumulator.** It renders the gap between the *authored* pattern and what the
engine actually produces, across the whole modulation stack:
- **mutate** — tree variation flips + pitch-jumps
- **chance** — probability misses drawn as a step that *didn't* fire (struck-out)
- **accumulator** — the per-step / track climb
- **LFOs** — continuous sweeps (filter cutoff/Q, mutation depth, density, macros)
- **ghost** — lead-mutation, density fills, scene/bank intention
- **density** — fills + thinning

The grid is *intent*; the computed view is *reality*. Everything that currently moves
invisibly (mutation has driven audio with no visual since 2026-06-01) gets a home.

✅ **The grid stays the authored editor; the screen is the live view.** This resolves
the tension behind [[reference-grid-shows-authored]] — the computed "live" overlay was
pulled OUT of the step grid on 2026-06-01 because it polluted the authored editor, and
mutation has driven audio invisibly since. The channel screen is its proper home: grid
= what you authored, screen = what's actually sounding. No grid pollution.

**Data sources:**
- **Resolved-note layer** (pitch / on-off / velocity / gate / chance-miss) —
  `mutationOverlay` (`audio/mutationOverlay.ts`) already captures resolved per-step
  state each tick (built for freeze replay): `setOverlay` / `getOverlay`. No new
  capture plumbing.
- **Continuous-modulation layer** (LFO-driven filter cutoff/Q, mutation depth, density,
  macro values) — the same per-tick snapshot the datafeed / stream window already emits
  (App.tsx 10Hz snapshot + `stream:batch`). Reuse it; don't add a parallel feed.
- Authored baseline comes straight from the track.

### Focus source
Use the same "active track" the `StepInspector` already derives from
`selectedStep` / `tieAnchor` (`store.ts:689`). Add a sticky `focusedTrackId` to the
store, set on any step interaction or track-header click, so the screen doesn't snap
away when nothing is hovered. Default to the first melodic track on load.

### What it draws (canvas, like `Scope` — smooth playhead + animated climb)
- **X** = steps 0..`track.length`, aligned to the grid below; current playhead column
  lit (concentric-ring convention from `StepButton`).
- **Y** = pitch. Each ON step → a horizontal bar at its resolved pitch; bar **length**
  = gate/tie (legato extends across steps); **velocity** → bar brightness/height nub;
  **ratchet** → subdivision ticks within the bar.
- **Ties** render as connected/extended bars.
- **Live deviation layer (the payoff):** authored bars drawn dim as the baseline; the
  *resolved* note (from `mutationOverlay`) drawn bright offset from it — so tree
  pitch-jumps, on/off flips, the accumulator climb, and ghost mutation all read as a
  visible departure from the authored line, walking and resetting in real time. One
  surface that makes the whole otherwise-invisible mutate function legible.
- **Drum channels (unpitched):** collapse to a single trigger/velocity lane with
  ratchet ticks (no pitch axis).

### Layout / footprint — multi-mode top screen (confirmed 2026-06-05)
✅ **The top becomes ONE wide multi-mode display** — a single full-width rectangle (the
"screen") with mode tabs, replacing the current top bar. The piano roll is its default
mode; LFOs and FX/master fold in as alternate modes of the *same* rectangle. This is the
key vertical-budget move: each mode reuses one rectangle, so adding LFO + FX views costs
**zero** extra height, and the page stays within its current vertical (native window is
1500×960).

**Why multi-mode (the deciding constraint):** the 8-cell `LFOPanel` is ~960px wide ×
96px tall and the `FXPanel` is a full-width 40+-knob bank — both want the *same* wide
rectangle the roll wants. Stacking them permanently above a real screen would crush its
height. Making them modes of one screen resolves that cleanly.

**Scope of this build (re-grounded 2026-06-05 against Chris's `screen-layout.png` mock).**
The mock is the **existing sequencer, reorganized, plus ONE new thing — the multi-mode
screen.** Everything else in it is existing functionality just repositioned, NOT to be
touched: the track grid + per-track inline knobs, the `rhythm | melody` section toggle
(`SectionToggle`, `App.tsx:204`), the `notes | velocity | chance | ratchet | timing |
gate` edit-mode tabs (`ModeSwitcher`, `App.tsx:227`), `SCENE`/`PATTERN` pads, transport,
BPM/root/scale, and `GEN SPARSE + GENERATE` (the existing ghost generator —
`src/ghost/generator/`, `composeSparse`). The build = the screen + the accumulator. Do
not redesign existing controls; only relocate per the mock.

**Screen modes (tabs in the screen header, monochrome — fill/outline contrast per
[[feedback-sequencer-monochrome]]). Confirmed 2026-06-05: ROLL / LFO / FX / MASTER.**
- **ROLL** (default) — the focused-channel piano roll (draw spec above) with the
  **`StepInspector` folded in** (roll on the left/center, selected-step detail incl. the
  accumulator section on the right/below). Selecting a step on the roll *or* the grid
  drives the inspector. Header strip: track · role · `mutate` · accumulator state
  (`acc↑ +1/4`) · length · key/scale.
- **LFO** — the 8 `LFOPanel` cells rendered in the screen rectangle (they already total
  ~960×96, a natural fit). Full LFO routing/select behaviour unchanged.
- **FX** — the global FX banks (tape · glitch · reverb · saturation). Folded in from the
  removed bottom-of-page section (`App.tsx:1841`).
- **MASTER** — the master chain (in · drive · comp · bias · mix · hi-cut · …), its own
  mode. `FXPanel` today bundles FX + master (imports from `audio/master`); splitting it
  across the FX and MASTER modes is part of this build.

Note: **per-track** fx send / filter / etc. stay as the inline knobs in each grid track
row (existing, untouched); the FX and MASTER modes are the **global** chain only.

✅ **Pinned top-right of the title row (always visible, not a mode):** the compact
`MacroStrip` (freeze · auto · density · motion · drift · chaos · tension · voicing) —
sits on the `NEWSPEECH | SEQUENCE` logo row with the settings/stream icons, per the mock.
It's the live *performance* surface, played constantly, so it stays put while
LFO/FX/MASTER (setup/routing, touched less often) live behind the mode tabs.

✅ **Mode switching = tabs + key cycle.** Clickable mode tabs on the screen header
(`● ROLL  ○ LFO  ○ FX  ○ MASTER`, fill/outline contrast) AND a keyboard shortcut to
cycle. Bindable to a hardware button later (performance rig). The ROLL canvas keeps
rendering underneath while another mode is shown, so switching back is seamless.

**Removed outright:**
- ✅ **`Scope`** (80×96 post-FX analyser) — superseded by the screen. Delete from layout;
  leave the `getScopeAnalyser` tap (`audio/scope.ts`) for later reuse.
- ✅ **`GhostDebug`** — top-row entropy histogram removed; the stream-window Datafeed
  (landed 2026-05-25) already carries bank entropy/shape/density. Ghost's *effect on the
  focused channel* still shows inside the ROLL deviation layer.

### Phasing (revised 2026-06-05 — screen builds FIRST, see Build order)
- **A (build first):** static piano roll of the focused channel from the **authored**
  pattern (pitch bars, gates/ties, velocity, playhead) **+ the new full-width top
  layout**: screen as centerpiece, `StepInspector` folded in, `Scope` removed, LFO/Macro
  deprioritized, focus tracking via `focusedTrackId`. Establishes the surface before
  anything modulates it. Switches with focus.
- **B:** live deviation layer from `mutationOverlay` — tree variation + accumulator
  climb + ghost drawn bright over the dim authored baseline, updating per tick. Lands
  *after* accumulator Phase 1 so there's a real climb to render.
- **C:** chance-miss markers (struck-out steps), drum-lane mode, focus-stickiness polish.
- **D (later):** continuous-modulation lanes under the roll — LFO-driven filter
  cutoff/Q, mutation depth, density, macro sparklines from the 10Hz snapshot. Turns the
  screen into the full computed view of every modulation source on the channel (and
  partly earns back the LFO/Macro real estate as *visualization* rather than controls).

---

## Build order (revised 2026-06-05 — screen first, accumulator into it, interleaved)

Confirmed with Chris: build the **channel screen Phase A first** (establish the new
top surface), then land the accumulator into a screen that already exists to show it.

1. **Channel screen Phase A** — split into three safe sub-phases (Chris's call, so
   nothing breaks mid-build):
   - **1.1 Shell — ✅ DONE 2026-06-05.** `ChannelScreen.tsx` (rectangle + ROLL/LFO/FX/
     MASTER tabs, click + backtick cycle, empty placeholder bodies). `screenMode` +
     `setScreenMode` added to the store (ephemeral, not persisted; `ScreenMode` type).
     Mounted at the top of the main column ABOVE the existing layout, which is left
     untouched for now (page is temporarily taller — resolved in 1.2). UI-only, no
     Launchpad wiring. Cycle key = backtick (`` ` ``); MODE_KEYS `1`–`6` + Space + arrows
     stay clear.
   - **1.2 Populate views with existing content — ✅ DONE 2026-06-05.** `LFOPanel` renders
     in the LFO body; `FXPanel` gained a `section?: 'fx'|'master'|'all'` prop (FX = pre/
     tape/glitch/reverb, MASTER = master chain incl. `MasterPresetSelect`; `'all'` keeps
     the legacy combined+expand-toggle layout) and renders as the FX + MASTER bodies;
     `MacroStrip` pinned to the title row (top-right, `GhostDebug` removed from that row);
     `ChannelScreen` moved below the title row; `Scope` removed from the layout (file +
     tap kept). Bottom-of-page `FXPanel` slot freed. `StepInspector` kept in its old row
     for now (folds into ROLL in 1.3). Per-track knobs / grid / section+edit-mode tabs /
     GENERATE untouched. tsc clean, verified in the Sequence app.
   - **1.3a Fold `StepInspector` into ROLL — ✅ DONE 2026-06-05.** ROLL body is now a flex
     row: a stretched placeholder (left, where the roll canvas lands) + `StepInspector`
     (right, 320px). Inspector removed from its old App row + import. Also dropped the
     "` cycle" tab hint per Chris.
   - **1.3b Piano roll canvas in ROLL — ✅ DONE 2026-06-05.** `focusedTrackId` +
     `setFocusedTrackId` added to the store (sticky; `setSelectedStep`/`setTieAnchor` set
     it when non-null so hover/pin drive focus without snapping away on mouse-leave;
     default falls back to first melodic track). `PianoRoll.tsx` (canvas, RAF off
     `getState`, ResizeObserver-sized): X = steps 0..length (beat separators every 4), Y =
     authored `step.pitch` (auto-fit range, ±1 pad), bar length = gate + tie run-length,
     velocity → alpha, ratchet → notch ticks, drum/unpitched = single centre lane,
     scene-relative per-track playhead column, source label top-left. Rendered in the ROLL
     placeholder beside the inspector. tsc clean, verified in the Sequence app. KNOWN v1
     limits (later phases): no header strip yet; track-header click → focus is a follow-up
     (setter exists).
   - **1.3c Behaviour tie-in (started 2026-06-05).** Roll reflects real note behaviour, not
     just `step.pitch`. **Reference look:** full chromatic MIDI grid (white/black-key
     shading), root pitch-class rows highlighted (brighter band + line + white label,
     root-aware not hardcoded C), bar dividers every 4 — monochrome adaptation of the Reliq
     `reliq-piano-roll.png` (amber dropped; `NOTE_RGB` constant). Note height dialed thin.
     **Chords:** chord-master + `semitones`-follower rows resolve the authored
     `chordVoicing` via `resolveChord` and draw a bar per tone (range auto-fits the chord).
     Gated to rows dispatch actually voices (matches StepInspector).
     **Live deviation layer (Phase B) DONE 2026-06-05:** while playing, authored pattern
     draws as a DIM baseline and the live RESOLVED note from `mutationOverlay`
     (`getOverlay`) draws bright on top — mutation pitch-jumps / flips / resolved chord
     (drop/borrow/shuffle) / ghost all read as a departure. Chance-misses (`gated===false`
     at an attack) draw as hollow outlines; authored ties disambiguate sustain (skip
     continuations) from a genuine miss. Stopped → authored at full weight.
     **Focus lock + click-selection DONE 2026-06-05:** the roll + `StepInspector` are
     locked to one focused channel. Selection is now CLICK-driven, not hover (hover→select
     and leave→clear removed from `StepButton`/`TrackGrid`) — a large panel shouldn't chase
     the cursor. Clicking a step focuses its channel (`focusedTrackId` set via
     `setSelectedStep`/`setTieAnchor`); the focused track's name button brightens in the
     grid so it's obvious which channel both panels reflect.
     DENSITY now shows (2026-06-05): the resolved pass keys off `gated` (sounds), not
     `on` — so density FILLS (authored-off, on=false/gated=true) draw bright and density
     THINNING (on=true/gated=false) draws as an outline, same as a chance miss.
     ALL 6 MACROS now reflected (2026-06-05): density/chaos/tension/voicing via the
     overlay; motion/drift via a `harmonicShift` field added to `OverlayValue` (per-tick
     harmonic offset) — chord master's chord root already baked it in, lead/follower rows
     now add `ov.harmonicShift` to the resolved pitch. Bright resolved notes shift with
     the harmonic motion off the dim authored baseline.
     STILL TODO: chord-tone/scale-tone/root-follow followers plot raw `step.pitch`;
     LFO/continuous-mod lanes; header strip; track-header click → focus.
2. **Accumulator Phase 1 (per-step) — ✅ DONE 2026-06-05.** `audio/accumulator.ts`
   (`AccumulatorCfg {step,range,shape}`, `accRung` wrap/bounce/hold math, module-Map
   per-`(track,step)` fire counters mirroring `treeState`, `consumeStepAccRung`
   read-and-advance, `resetStepAccumulators`, `parseAccumulator`, `peekStepAccRung` for
   UI). `Step.accumulator?` + `setStepAccumulator` setter (sparse plock, mirrors
   `chordVoicing`); `hydrateStep` parses it; persists automatically (rides the step
   object). `runTick` adds `step.accumulator.step * rung` to `resolution.pitch` BEFORE the
   overlay emit (so the roll deviation layer shows the climb), melodic-only, advances the
   counter only when gated (per-fire) and not frozen. `consumeStepAccRung` wired into the
   `TickContext` in `App.tsx`. Reset wired alongside `resetBranchWalk` (store ×3 +
   persist import). Inspector accumulator section in the folded-in `StepInspector`: `S`
   (degrees/rung, `—` = off, toggles the plock) · `R` (range 1–8) · `⟳` (shape) · live
   `rung·offset` readout (RAF-polled) · `×` clear; dim until plocked. tsc clean; engine
   reload hook (`tick.ts:51`) makes it audible. PENDING: audition by ear in the app.
3. **Channel screen Phase B** — live deviation layer from `mutationOverlay`: tree
   variation + accumulator climb + ghost drawn bright over the dim authored baseline,
   per tick. The accumulator from step 2 is now visible.
4. **Accumulator Phase 2 (mutate-driven auto-accumulator) — ✅ DONE 2026-06-05, REFRAMED.**
   Chris's call: not the doc's old vary/acc knob-split. Instead `mutate` AUTO-applies the
   accumulator mechanic on lead tracks (no per-step authoring), **layered on top of** the
   existing tree (pitch-jumps + flips kept). `consumeAutoMutationRung` in `accumulator.ts`:
   per-placement FNV hash → eligibility (coverage scales 0→all with the combined knob+ghost
   `leadMutAmount`) + a varied loop length (range 2–8); sawtooth climb **capped at +2
   degrees** (climb to +2, hold, reset on wrap). Applied in `runTick` after resolution
   (authored `step.accumulator` takes precedence; else lead + `leadMutAmount>0` → auto),
   before the overlay emit so the roll deviation layer shows it. Reuses the per-step fire
   counters + reset. `consumeAutoMutationRung` wired into `TickContext`/App. Bass/pad/chord-
   master unchanged. NOT the old fork-drop/accDepth design — superseded.
5. **Channel screen C/D** — chance-miss markers, drum-lane mode, focus polish; later the
   continuous-modulation lanes (LFO/density/macro sparklines from the 10Hz snapshot).

## LFO view + per-LFO shapes (DONE 2026-06-05)
First piece of the polish/feature pass on the LFO mode:
- **Per-LFO `shape`** (`sine|triangle|saw|square`) added to the `LFO` model + `lfoShapeValue`
  helper; routed through every sample site (`lfoOutput`, freeze snapshot, `modulated()`,
  `useLFOValue`) so it drives audio, not just the picture. `setLFOShape` setter; hydrate
  defaults old saves to sine; persists with the LFO. (Not in the original screen plan —
  Chris-requested extension.)
- **LFO mode rebuilt** (`LFOPanel.tsx`): 8 cells laid out HORIZONTALLY filling the screen
  rectangle, each a framed waveform plot (Reliq `destination-settings-mix.png` reference) —
  the actual shape drawn bold across one cycle with 0/25/50/75/100% gridlines + centerline,
  amplitude floored at 35% + depth-scaled so the shape is always legible, a phase dot at
  the LFO rate. Per-cell depth knob + shape-cycle button + period + destination label;
  cell-click still arms LFO-select. Replaced the old spinning-circle cells.

## FX / MASTER view layout (deferred 2026-06-05)
FX + MASTER modes currently just center the existing `FXPanel` knob banks
(`items-center justify-center`, rows switched `justify-end`→`justify-center`). Works, but
the layout wants a proper expand/adjust pass (use the full rectangle, group by stage,
sizing) — parked until after the broader UI polish.

## UI polish pass (deferred — functionality validated 2026-06-05)
Channel screen + accumulator are built functionality-first (labeled, legible, plain) per
[[feedback-label-knobs-during-build]] / [[feedback-build-audio-iteratively]]. Chris wants
a visual punch-up pass once the behaviour settled (it has). Candidates: the screen frame +
mode tabs, piano-roll typography/density/contrast (root band, labels, note bars,
deviation dim/bright levels), the inspector `acc`/chord rows, macro-strip compaction. Keep
[[feedback-sequencer-monochrome]] (no accent colour) + [[feedback-subtle-toggles]].

## Open decisions to settle while building
- ⚠️ Track default vs per-step-only (Phase 2; per-step is first-class regardless).
- ✅ **Per-fire increment** (resolved 2026-06-05). Both counter systems advance per-fire:
  the per-step counter (Phase 1) bumps when that step fires; the track counter (Phase 2)
  bumps on each pattern-length wrap (its "fire"). No per-loop variant. If the track climb
  reads too fast at per-fire cadence in Phase 2, tune via `range`/`accDepth`, not by
  reverting the increment model.
- `accDepth` scaling math — tune by ear.
- Drum upper-half behavior (recommending pitch no-op; vel/ratchet accumulation is a
  later extension).
- **Key for the mode cycle** — pick a free key during Phase A (current page keys: see
  `core.js`/app keymap; avoid clobbering `0/9/a/m/t` conventions from the site).
- **Macro strip compaction** — at 56px knobs ×8 it's ~616px; fits above the screen at
  grid width, but trim to ~44px if it crowds. Decide visually in Phase A.

Resolved 2026-06-05: top region is a **multi-mode screen** (ROLL default + LFO + FX,
switched by tabs + key cycle), `MacroStrip` pinned above, `StepInspector` folded into
ROLL, `Scope` + `GhostDebug` removed, accumulator increments **per-fire**, screen builds
before the accumulator.

## Key files
- `src/engine/tick.ts` — `runTick`, `treePos` at `:752`, mutation application.
- `src/audio/mutationTree.ts` — `openForkCount` `:150`, reach loop `:352`, `FORK_LEVELS` `:45`.
- `src/audio/treeState.ts` — ephemeral walk state (pattern to mirror for `loopCount`).
- `src/audio/voices.ts` — role profiles (where role defaults belong).
- `src/components/Scope.tsx` — canvas reference for the piano-roll screen; **removed
  from the layout in Phase A** (tap in `audio/scope.ts` left in place).
- `src/audio/mutationOverlay.ts` — resolved per-step layer for the deviation view
  (`getOverlay(trackId, stepIndex)` → `{on, velocity, pitch, gate, gated, ratchet,
  chord?}`); already captured each tick, no new plumbing.
- `src/components/StepInspector.tsx` — `LabeledSelect` pattern; folds into the channel
  screen (Phase A), gains the accumulator section (Phase 1).
- `src/components/MacroStrip.tsx` — pinned above the screen (Phase A); knobs at 56px.
- `src/components/LFOPanel.tsx` — moved into the screen's **LFO mode** (8 cells, 120×96).
- `src/components/FXPanel.tsx` — moved into the screen's **FX mode** (frees `App.tsx:1841`).
- `src/components/GhostDebug.tsx` — **removed** from the layout (Phase A).
- `src/state/store.ts` — add sticky `focusedTrackId` (derive default from `selectedStep`
  / first melodic track); `Step` `:52`, setters `:1485+`, `selectedStep` `:689`.
- `src/App.tsx` — top layout `:1712+` (rows at `:1731` logo+Ghost+Macro, `:1801`
  Scope+Inspector+LFO, `:1808` transport; `TrackGrid` `:1819`) — where the screen lands.
