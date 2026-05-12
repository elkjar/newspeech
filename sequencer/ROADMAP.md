# Sequencer Roadmap & Design Document

Original design doc (drafted prior to 2026-05-08). Now lives in the repo. Implementation status is annotated inline with ✅ (shipped) / ❌ (not built). For detailed ship state see `memory/project_sequencer.md`; for in-flight feature plans see `../IDEAS.md`.

## Project Identity

A **generative step sequencer designed as an involved instrument** — played live, not operated as a system. The sequencer produces evolving compositions that the user performs *with* in real time, capturing audio output into a DAW where it becomes the foundation for live instrumental arrangement (drums, guitar, etc.) in mathy electronic music.

**Design DNA:** Eurorack generative patches (Make Noise René, Marbles, Pamela's Workout) — but with the structural clarity that Eurorack often lacks for capture/arrangement workflows.

**Market gap this fills:** Most commercial step sequencers (Stepic, Cthulhu, Riffer, Elektron boxes) are loop-oriented or song-mode-as-DAW-timeline. Hardware like Pamela's Workout or Hapax solves pieces of this. A generative-but-structured form sequencer designed as an instrument for capture-and-arrange is genuinely underserved.

---

## Core Design Principles

These principles drive every feature decision. New ideas should be evaluated against them.

### 1. The capture is the artifact

Every performance is unique. There is no "reproduce that take" feature. If you want it, you grab it while it's happening — or you let it go and trust the instrument to give you another good moment. This is closer to recording a Eurorack patch or a live improvisation than to programming a track.

### 2. Instrument, not system

The sequencer is *played*. It does not run autonomously to produce output for the user. Features that automate the user's involvement are scope creep; features that make live interaction richer earn their place.

This rules out (intentionally):
- Deterministic / seeded playback
- Multiple-take rendering
- Batch export
- Anything labeled "render" or "generate output"

This elevates:
- Real-time controls
- Freeze / lock / grab gestures
- MIDI controller mapping
- Performance-time scene transitions

### 3. Capture is audio, not MIDI

The output workflow is committing to audio in the DAW. This means scene markers, MIDI program changes for transitions, and similar metadata features are unnecessary — scene boundaries are audible. MIDI out remains useful for *driving* the instrument or routing notes to external gear during performance, not for reproducing performances.

### 4. Depth over breadth

More plocks per pattern beats more pattern slots. More expressive scenes beats more scenes. More modulation per LFO beats more LFOs. The tool is already feature-rich; from here, every feature must multiply existing ones.

### 5. No transparent effects

Every audio/visual effect should be apparent and intentional; characterful over transparent everywhere. Added 2026-05-09 once the output FX section started landing — defaults should announce themselves, not hide.

---

## Roadmap (Prioritized)

### Tier 1: The Instrument Itself

These features define the live performance experience. Without these, the tool is a programmable sequencer that happens to be generative. With them, it's an instrument.

#### ✅ Global Macros: Density / Chaos / Motion / Drift / Tension

Shipped. Final macro set is **density, chaos, motion, drift, tension** — `drift` was added during build because motion needed a probability gate separate from rate. Non-destructive lenses over the active pattern: density biases per-step trigger probability with metric weighting, motion drives bar-aligned scale-degree jumps (bipolar with away/home alternation), drift gates motion jumps, chaos multiplies mutation, tension biases mutation pitch-jump weights toward color tones.

#### ✅ Freeze (global scope)

Shipped 2026-05-08 as a global-only toggle. Freezes the *previous* mutation cycle's outcomes — captures the cycle just heard. Composes with pattern banks (save the captured state to a slot). Per-track freeze deliberately NOT shipped — `rhythmLock` (per-row, renamed from `lockTiming`) handles the narrower "preserve rhythm, let timbre evolve" case.

**LOCK is the orthogonal complement** — stages parameter *changes* rather than capturing output. See [`../IDEAS.md`](../IDEAS.md) item #1 for the full plan; drafted, not yet picked up.

#### ✅ MIDI Controller Mapping

Shipped 2026-05-10. Per-rig library (bundled + user `.midimap` JSON), learn mode, ~100-target surface (macros, bank pads, per-track knobs, FX knobs, transport). User-library-only as of 2026-05-11 — bundled defaults pulled because guessed CC numbers didn't match real controller templates.

#### ❌ History / Grab

Not shipped. Pattern banks (shipped 2026-05-10) are a sibling but distinct: banks save explicit snapshots on shift+click; grab would be a continuous rolling buffer of recent state with a single "grab the last N bars" button. Captures *what was sounding* including LFO-modulated knob positions frozen at each step — the result, not the recipe. Lands in a separate scratchpad area. Must work mid-performance without stopping playback.

#### ❌ Count-In (Drum Hits)

Not shipped. Native-feeling pre-roll for tracking live instruments. No metronome bolted on — drum hits from the kit, or a dedicated count-in sound. Sounds like the instrument talking to itself.

#### ❌ Performance Mode / UI

Not shipped. A live-playing layout distinct from the programming layout. Programming UI optimizes for editing patterns and assignments; performance UI optimizes for the small set of gestures used during a take (global macros, freeze, grab, bank advance, LFO speed). One toggle between them, or a configurable view.

---

### Tier 2: Song Structure

Lets the instrument produce evolving compositions over performance-length timescales (3+ minutes) without losing its instrument character.

#### 🟡 Pattern Chaining (Foundation)

Partial. **Pattern banks shipped 2026-05-10** — 16 slots, bar-quantized recall, shift+click to save, click to queue. Bank-level chain mode (auto-advance through a slot list) is the natural completion; deferred until the user plays with manual queue/recall and forms an opinion on the feel. The bar-boundary commit infrastructure is in place — only the chain UI + per-step bar count + loop behavior remain.

#### ❌ Scenes (Probability Graph)

Not shipped. Banks save `tracks + macros`; scenes would extend that to include LFO speed multipliers, key/scale, tempo override, duration range — a fuller container. Scenes connect via weighted transitions: Scene A → 70% stay, 20% to B, 10% to C. During performance, scenes evolve probabilistically within bounds you've defined, with manual override for live direction.

Banks were deliberately scoped narrower (no tempo, no modulation routing, no key) so a swap doesn't yank the groove. Scenes earn the wider scope by carrying transition logic.

#### ❌ Manual Scene Override

Not shipped (depends on scenes).

---

### Tier 3: Multipliers on Existing Features

Make the existing feature set more expressive without adding conceptual surface area.

#### ✅ Parameter Locks (P-Locks)

Shipped via per-step values for note, velocity, chance, ratchet, micro-timing, gate, and per-step chord-voicing on melodic rows. Mutation already operates on these dimensions; morph interpolates between A/B snapshots that capture them.

#### ❌ Trig Conditions

Not shipped. Per-step rules beyond probability: 1:4 / 2:4 / 3:4 (every Nth bar), first/last (only on first or last repeat), previous step did/didn't fire, neighbor track fired, fill-mode-only. Cheap to implement on top of the existing chance system; disproportionate musical payoff.

#### ❌ MIDI CC Out from LFOs

Not shipped. The 8 LFOs are assignable to internal knobs + macros + FX params; letting them also output as MIDI CC would extend modulation to external gear. Tiny addition, big expansion of scope.

#### ❌ Random / S&H Modulation Sources

Not shipped. Pair the LFOs with random per-step, sample-and-hold, and stepped random sources. LFOs alone get repetitive; mixed modulation sources feel less mechanical.

#### ❌ Very Slow LFOs (Song-Timescale Modulation)

Not shipped. LFOs currently run at detuned-prime free-running rates suited to bar/cycle-timescale modulation. Slow LFOs (30+ second cycles) modulating macros would give hands-off long-form evolution — the thing that makes a long generative piece *work* vs. *feel aimless*.

---

### Tier 4: Mathy Electronic Aesthetic

Specific to the user's musical context — instrumental electronic with odd meters and harmonic motion.

#### ❌ Polymetric Scene Transitions

Not shipped (depends on scenes). Track 1 stays at 16, track 2 moves from 12 → 14 → 11 across scenes. The polyrhythm engine does the heavy lifting via per-track length + rate, which already exists; scenes would parameterize it.

#### ❌ Tonal Center Shifts per Scene

Not shipped (depends on scenes). Quantizer already keeps things in key. Scenes that change root or mode mid-performance give harmonic motion in instrumental electronic without writing chord progressions.

Partial preview: harmonic motion macro (motion + drift) already does bar-aligned scale-degree jumps within the current key. Scenes would lift this to key changes.

#### ❌ Meter Shifts at Scene Boundaries

Not shipped (depends on scenes). 7/8 → 4/4 → 5/4 across a performance, with the generative engine handling metric modulation while you play over it.

#### ✅ Euclidean Rhythm Generator

Shipped in Phase 3. Per-track hits/steps/rotation entry mode; pairs with mutate.

---

### Tier 5: Polish & Workflow

#### 🟡 Pattern Variations / Snapshots

Partial. **Per-track A/B slots exist** for the morph knob (each track has `slotA` / `slotB` Step[] snapshots). **Pattern banks** give 16 full-pattern snapshots. The remaining gap from the original spec is per-pattern variation slots (each pattern slot holding A/B/C/D variations) — banks-as-flat-16 has been good enough in practice; revisit if the workflow asks for it.

#### ❌ Undo History for Mutations

Not shipped. "I liked the version two mutations ago" should be recoverable. Programming-time feature, not performance-time.

#### 🟡 Per-Track Swing / Groove Templates

Partial. **Per-step micro-timing** is shipped (each step has an offset in fractional steps), so groove can be programmed by hand. Templates (MPC swing, classic 808/909 shuffle, custom groove import) not shipped.

#### ❌ MIDI Clock In/Out

Not shipped. Sync to other gear and DAWs as clock master or slave.

---

### Beyond the original roadmap — landed since

Items that shipped and weren't on the original tier list:

- **Output FX section** — pre-saturation, tape (Morphagene-style real-time bed + grain spawner), glitch (clocked stutter, 8 random modes), reverb (FDN with deep diffusion), BOUM-inspired master stage (input gain, lo-cut, comp with negative-ratio, 4-mode distortion, gate, hi-cut, trim, presets). The full output stage is itself an instrument now — see memory entries for build history.
- **Per-track filter** — 4-pole Moog ladder worklet per internal-voice track (cutoff + resonance).
- **Per-track pan / gain / fxSend**.
- **Sampled voice library** with multi-zone melodic playback, round-robin per bank, kick/snare/hat choke groups.
- **Pad-type voice category** — custom mutation rules (voicing drift, tone dropouts, gate stagger) + built-in per-tone stereo pan motion LFO.
- **Melodic section redesign** — chord-master positional role with `ChordContext` published per chord step; followers via `chord-tone` / `scale-tone` / `root-follow` / `ignore` pitch-interp modes. Chord-aware mutation (borrow, shuffle-inversion, shift-spread, drop-chord-tone).
- **Init action + reusable ConfirmDialog**.

---

## What NOT to Build

Explicitly out of scope. Each of these would either pull toward "system" framing, scope-creep into DAW territory, or contradict the design principles.

- **Audio effects / mixer** — ~~DAW's job~~ partially superseded: the output FX section IS the sequencer's voice now, not a generic mixer. The principle still applies to *mixer-style channel strips with EQ/comp per track*; that remains DAW work.
- **Built-in synths** — sample playback yes, synthesis is scope creep. Active direction is phasing out the remaining browser-synthesized voices (`bass`, pad fallback) in favor of captured samples.
- **DAW-style timeline song mode** — the whole point is that this isn't a DAW; probability graph > timeline.
- **More pattern slots** — depth (plocks, conditions) > breadth (more patterns). 16 bank slots is enough.
- **Deterministic / seeded playback** — contradicts "capture is the artifact" principle.
- **Multiple-take rendering** — user takes multiple takes themselves; this is system thinking.
- **Batch export** — system thinking.
- **Scene markers / MIDI program change output** — capture is audio; markers unnecessary.
- **Auto-composition tools** — the user composes by playing the instrument; the instrument doesn't compose for them.
- **Special "macro save" operation** — pattern save already does this; macros are just a non-destructive lens. (Confirmed in practice — banks save the full state including macro values.)

---

## Architectural Priority

Keep the sequencer logic *completely separate* from audio playback and UI. A clean core that emits "at time T, play sample X at velocity V" or "send MIDI note N" wraps cleanly into:

- Browser (current)
- Electron / Tauri standalone
- JUCE / nih-plug VST (future)
- Hardware (hypothetical)

**Current state:** scheduler (`src/audio/scheduler.ts`) is independent of the audio backends — it emits step events via callbacks; dispatch (`App.tsx` `onStep`) translates events into `samplePlayer.trigger` / MIDI out / etc. Worklets isolate DSP. The store is Zustand and could in principle port. The largest entanglement is `App.tsx` doing dispatch in a React component instead of a pure module — worth extracting eventually.

---

## Future Platform Path

### Near-term: Web version remains primary

- Web MIDI API for hardware controller input and DAW/external gear output ✅ shipped
- Sample playback via `AudioBuffer` / `AudioBufferSourceNode` ✅ shipped
- This combination covers a surprising amount of real use cases without ever becoming a plugin

### Mid-term: Standalone wrapper

- **Tauri** (Rust-based, lighter) or **Electron** (familiar, heavier)
- Keeps existing code
- Tradeoff: audio timing is okay but not pro-tier; no path forward to VST from here

### Long-term: VST via JUCE or nih-plug

- **JUCE (C++)** — industry standard, standalone + VST3 + AU + AAX from one codebase
- **nih-plug (Rust)** — modern, avoids C++, smaller community
- Sequencing logic ports as math/state — UI and audio layer fully rewritten
- Sample engine is the hardest new learning: voice management, polyphony, anti-click envelopes, disk streaming
- Worth doing only if DAW integration (transport sync, project save) or distribution as a product becomes the goal

---

## What's next (post-2026-05-12)

Forward picks given current state. See `../IDEAS.md` for direction-blessed plans.

1. **LOCK** (parameter staging) — full plan in IDEAS.md item #1. Pattern banks shipping makes the workflow LOCK was designed for real.
2. **Finish phasing out browser-synth voices** — capture `bass` and pad fallback samples; delete the synth-fallback branch in `samplePlayer.ts`.
3. **Bank chain mode** — auto-advance through a slot list with per-slot bar counts. Bar-boundary commit infrastructure already exists.
4. **History / Grab** — rolling buffer of last N bars, single-button capture into a scratchpad. Distinct from banks (banks save authored snapshots; grab captures live evolution).
5. **Trig conditions** — per-step rules on top of probability. Cheap relative to expressive payoff.
6. **MIDI CC out from LFOs** — extend modulation surface to external gear.
7. **Very slow LFOs** — song-timescale modulation of macros.
8. **Performance Mode UI** — distinct layout when the surface area gets too big for the programming view.
9. **Scenes** — only after banks-with-chain has played out; scenes add LFO speed / key / scale / transition graph on top of the bank primitive.

Everything in Tier 5 + the dependent Tier 4 items stay parked until something pulls them forward.

---

## Open Questions

- ~~What does "Tension" actually control?~~ Resolved: tension biases mutation pitch-jump weights toward color tones at high tension.
- ~~Does morph operate between patterns, between scenes, or both?~~ Resolved: per-track A/B morph; pattern banks for full-state recall.
- Should slow LFOs (when built) be aware of scene position, or remain free-running?
- What's the right UI metaphor for the scene graph — node editor, list with arrows, matrix?
- History buffer length: fixed default, configurable, or auto-sized to musical context?
- Performance mode UI: separate page, overlay, or fully reconfigurable single layout?
