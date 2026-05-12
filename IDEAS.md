# IDEAS

Things in flight for newspeech. Stable conventions and decided direction live in `CLAUDE.md`; this file is for in-progress ideas with open questions. Items here may shift, get reordered, or get killed.

---

## Done — moved out of IDEAS

- **Custom sample library** — landed across drums (`blck_noir`), pads (`sinewaves-at-the-scope`, `encounter`, `pulsed`), and 7 instruments (`hydrasynth_plaits`, `mini-moog`, `rhodes_mk1`, `root_grain`, `soft_piano`, `tape_piano`, `under_piano`). Remaining synth-only voices: `bass`, plus the pad synth-fallback path. See `memory/project_sequencer.md`.
- **Audio file showcase / pseudo-filesystem browser** — landed as `samples.html`, wired to real samples from `sequencer/public/samples/` grouped drums/pads/instruments.

---

## 1. LOCK — parameter staging toggle for the sequencer

Single global toggle that **stages parameter changes** during performance — the aesthetic complement to `freeze`. Where freeze captures the **output** (the cycle that was playing keeps repeating), LOCK captures the **inputs** (knob / macro / LFO values get staged in a buffer; the engine continues evolving but reads from a frozen parameter snapshot until release). They compose orthogonally.

**Performance use:** "I want to navigate to a different musical state without the audience hearing the journey." Twist new macro / LFO / key / tempo settings while engaged; on release, the staged values commit instantly and the engine continues evolving from there.

Pattern banks landing (2026-05-10) makes the workflow LOCK was designed for real — banks give you destinations to stage *into*.

### Scope

**Lockable (commits on release):**
- *Globals:* `density`, `motion`, `drift`, `chaos`, `tension`, `bpm`, `rootNote`, `scale`
- *Per-track knobs:* `mutation`, `morph`, `rowRatchet`, `fxSend`, `pan`, `gain`, `filterCutoff`, `filterResonance`, `mute`, `solo`
- *LFOs:* `depth` per LFO, `destinations` per LFO (full re-routing stages)

**Always live (bypasses LOCK):**
- Authored `steps` and per-step values (note, velocity, chance, ratchet, timing, gate)
- Track `length`, `rate`, `source` (instrument selection — structural)
- Per-row `rhythmLock` toggle (renamed from `lockTiming` — see Phase 0)
- `viewPage`, editor selections, `editMode`

**Visual treatment:** no per-control diff indicators. The contract is "LOCK is engaged, you're staging — release commits everything." Knobs continue to display their live values. The only visible state is the LOCK toggle button itself (filled when engaged, outlined when live), positioned next to `freeze` in the macro strip.

### Phase 0 — rename `lockTiming` → `rhythmLock`

Internal-only rename to free up "LOCK" for the new feature. The per-row `lockTiming` is a narrow toggle (stops mutation from flipping which steps trigger, but lets timbre/pitch jitter happen) — `rhythmLock` is a more accurate musical name.

Touchpoints:
- [`sequencer/src/state/store.ts`](sequencer/src/state/store.ts) — `Track.lockTiming` field → `rhythmLock`. Action `setTrackLockTiming` → `setTrackRhythmLock`. Initial track state values.
- [`sequencer/src/state/hydrate.ts`](sequencer/src/state/hydrate.ts) — `hydrateTrack` reads either `rhythmLock` (new) OR `lockTiming` (old) and writes `rhythmLock`. Backward compat for existing `.seq` files.
- [`sequencer/src/App.tsx`](sequencer/src/App.tsx) — dispatch reads `track.rhythmLock` instead of `track.lockTiming`.
- [`sequencer/src/components/Track.tsx`](sequencer/src/components/Track.tsx) — `setTrackLockTiming` call site → `setTrackRhythmLock`.
- [`sequencer/src/state/defaultPreset.json`](sequencer/src/state/defaultPreset.json) — leave field name as-is if present; hydrate handles it. Optional cleanup.
- Memory `project_sequencer.md` — update references.

Land as its own commit before Phase 1 so blame is clean.

### Phase 1 — state + types

`state/store.ts` additions:

```ts
locked: boolean;
committed: CommittedSnapshot | null;
setLocked: (v: boolean) => void;
toggleLocked: () => void;
```

`CommittedSnapshot` shape:

```ts
interface CommittedSnapshot {
  density: number;
  motion: number;
  drift: number;
  chaos: number;
  tension: number;
  bpm: number;
  rootNote: number;
  scale: Scale;
  tracks: Record<string, {
    mutation: number;
    morph: number;
    rowRatchet: number;
    fxSend: number;
    pan: number;
    gain: number;
    filterCutoff: number;
    filterResonance: number;
    mute: boolean;
    solo: boolean;
  }>;
  lfos: LFO[];  // full deep copy — depth + destinations
}
```

`toggleLocked` semantics:
- false → true: snapshot current live state into `committed`
- true → false: discard `committed` (set to null)

**Persistence:** `locked` and `committed` do NOT persist in `.seq`. Same as `freeze` and `hold`.

### Phase 2 — effective-parameter helper

New module `sequencer/src/audio/lockSnapshot.ts`. Pure functions, no React:

```ts
export function effectiveGlobals(state: SequencerState): {
  density, motion, drift, chaos, tension, bpm, rootNote, scale
};
export function effectiveTrackKnobs(track: Track, state: SequencerState): Track;
  // returns a Track-shaped object with locked knob values overlaid; authored
  // steps + length + rate + source all come from the live track verbatim
export function effectiveLFOs(state: SequencerState): LFO[];
```

Each returns the committed snapshot when `state.locked && state.committed`, else returns the live values.

### Phase 3 — dispatch wiring (`App.tsx`)

In the scheduler `onStep` callback:
- Replace `useSequencerStore.getState()` destructure with helper-driven reads:
  - `effectiveGlobals(state)` → globals for all `modulated()` calls and harmonic motion.
  - `effectiveLFOs(state)` → passed into every `modulated()` call (replaces `lfos`).
  - Per-track loop: `effectiveTrackKnobs(track, state)` returns a track view with locked knob values overlaid. Use that for `mut, trackMorph, trackRowRatchet, mute, solo, fxSend, pan, gain, filterCutoff, filterResonance`.
- `anySolo` is recomputed against the effective track-knob view.
- Authored `steps`, `length`, `rate`, `rhythmLock`, `source`, `midi` continue to come from the live `track` directly (they're not lockable).

### Phase 4 — BPM plumbing

The scheduler / transport currently reads `bpm` directly. Audit needed:
- Path 1: scheduler subscribes to store `bpm` changes and updates its internal tempo eagerly.
- Path 2: scheduler reads `bpm` at scheduling time per tick.

Decision after audit:
- If Path 1 → add a Zustand subscription on `(bpm, locked, committed.bpm)` that pushes the effective BPM into the scheduler. Effective = `committed.bpm` when locked, else live.
- If Path 2 → scheduler reads via the `effectiveGlobals` helper directly. Simpler.

Goal: tempo changes during LOCK don't affect the running scheduler; on release, scheduler re-reads and updates tempo.

### Phase 5 — LFO + UI hook plumbing

- `audio/lfo.ts:modulated()` already accepts `lfos` as a parameter. Dispatch passes `effectiveLFOs(state)`.
- `hooks/useLFOValue.ts` (RAF-based UI display) keeps using **live** lfos. The visual previews of routing changes during LOCK are intentional — user sees what they're staging.
- Knobs (`MacroKnob`, `TrackKnob`) keep displaying their live values via `useLFOValue`. No change. Only the audio path uses committed.

### Phase 6 — UI

`sequencer/src/components/MacroStrip.tsx` — add `LockButton` next to `FreezeButton`. Same chrome treatment as freeze:
- 56×56 hit area, ~20px circle dot in center
- Filled white when engaged, hairline white/30 outline when live, hover brightens border
- Tooltip: `lock · staged` / `lock · live`

Layout becomes `[freeze] [lock] | [density] | [motion · drift] | [chaos · tension]`.

### Phase 7 — manual test plan

Verify on `localhost:5173`, in order:
1. **Knob staging:** LOCK on, twist density → audio doesn't change. Release → audio jumps to staged density.
2. **Multi-macro:** LOCK on, twist density + tension + drift → audio stays at original. Release → all three commit at once.
3. **BPM:** LOCK on, change BPM → playback tempo unchanged. Release → tempo updates.
4. **Key change:** LOCK on, change root note + scale → melodic tracks stay in old key. Release → new key takes effect on next note.
5. **Mute/solo:** LOCK on, unsolo or unmute a track → mix unchanged. Release → mix updates.
6. **LFO routing:** LOCK on, re-route LFO 3 from `mutation` to `density` → still uses old routing. Release → new routing active.
7. **Freeze + LOCK composition:** freeze on, LOCK on, twist macros → silent. Release freeze (LOCK still on) → resumes evolving from **committed snapshot**, not the twists. Release LOCK → twists commit.
8. **Authored steps still editable:** LOCK on, click steps on/off → next dispatch reflects edits.
9. **`rhythmLock` per-row still works:** sanity check the Phase 0 rename didn't break per-row mutation gating.
10. **`.seq` round-trip:** open an old saved file with `lockTiming` field; confirm it loads as `rhythmLock`. Save fresh; confirm new field name in JSON.

### Edge cases / decisions

| Case | Default behavior | Notes |
|---|---|---|
| Track source change during LOCK | **Bypass** (commits immediately) | Structural, like authored steps. Stage if pushback. |
| Track length / rate change during LOCK | **Bypass** | Structural. |
| New track spawned during LOCK | N/A | UI doesn't allow (fixed 8 per section). |
| LOCK released mid-cycle | Instant commit | No bar-aligned quantization in v1. Future option. |
| LOCK toggled while not playing | Allowed | No audible effect either way; release-on-play behaves normally. |
| LFO destination removed during LOCK | Stages | `committed.lfos` keeps old routing until release. |

### Open questions to confirm before starting

1. **Track source change** — bypass or stage? Default plan is bypass (structural). Confirm.
2. **Naming** — `rhythmLock` for the renamed per-row flag. Alternatives: `pulseLock`, `triggerLock`. Pick one.
3. **Per-track filter / pan / gain coverage** — added to Phase 1 / Phase 3 since the original draft (those knobs all landed after the plan was written). Confirm they should be lockable (default yes, since they're mix controls a performer would want to stage).

### Land each phase as its own commit

So partial progress is recoverable. Push when Phase 7 passes.

---

## 2. Multi-block Strudel arrangements

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
