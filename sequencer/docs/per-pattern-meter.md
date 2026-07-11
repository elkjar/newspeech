# Per-pattern meter (variable time signature)

**Status:** spec / not built. Decided 2026-07-10.

## What & why

Let a **bank carry its own time signature** so a song can shift meter by section —
"the whole song moves into 3/4 here" — and have song mode count it natively as
*"8 bars of 3/4"* (8 × a 3-beat bar), with the grid, downbeat, and swap-quantize
all agreeing.

This is **global meter that changes per section**, NOT polymeter. Polymeter (each
track a different cycle length) already works today via `track.length × RATE_STRIDE`
and needs nothing. This feature is the opposite: every track in a bank shares one
bar, and the bar's length changes when you swap to a differently-metered bank.

Meter lives on the **bank** (`BankSlot`). A bank *is* a pattern; a pattern has a
meter. Song rows already reference a bank, so a row **inherits its bank's meter** —
no new arrangement-row field. "Shift to 3/4 here" = swap to a 3/4 bank. Fits the
existing authoring style (piper-maru = 8 banks of rising entropy in one scene; any
bank in a ramp can drop into 3/4 without splitting the scene).

**Song mode is NOT reworked (decided 2026-07-10).** No new column, no meter picker,
no changed interaction in the song view. Meter is set on the *pattern*; song mode is
left alone. The only quiet touch-point is the row-advance *counting unit* — see the
fork below. Whatever we pick, the song-view UX is unchanged from the user's seat.

### Row-advance respects the pattern's meter — DECIDED (A), 2026-07-10

`arrangementAdvance` counts the row in the active bank's `barTicks`, so "8 bars" of a
3/4 bank = 8 × 24 ticks and the swap lands on a 3/4 downbeat. This is an **invisible**
change — the user still types a bars number as always; because the pattern is 3/4,
that number now counts 3/4 bars. Song mode is identical to operate; it just makes
musical sense at section boundaries. This is what makes meter *real* (vs. a
display-only label). No song-view UI change.

## Model

The scheduler tick grid is **unchanged**: 8 ticks per beat (a 32nd-note grid).
Meter only regroups beats into bars:

```
barTicks = meterBeats × 8      // 3/4 → 24, 4/4 → 32, 5/4 → 40, 6/4 → 48, 7/4 → 56
```

v0 supports **N/4** (integer quarter-note beats): 3/4, 4/4, 5/4, 6/4, 7/4. Compound
/8 meters (6/8, 7/8) are a beat-grouping/accent nuance with the same tick math —
deferred.

## The one load-bearing change: bar-boundary detection

Today (`App.tsx:~599`):

```ts
if (!redispatch && globalStep % 32 === 0) {   // <-- fixed 4/4 bar
  commitPendingScene(globalStep);
  commitPendingBank(globalStep);
  ghostTickBar(globalStep);                    // ghost + arrangementAdvance + harmonic
}
```

Becomes anchored to the active bank's start (`sceneStartStep`, already reset on
every swap) with the active bank's `barTicks`:

```ts
const barTicks = activeBankMeterBeats(state) * 8;   // default 4 → 32 (identical to today)
if (!redispatch && (globalStep - state.sceneStartStep) % barTicks === 0) { ... }
```

**Why this is safe/equivalent in 4/4:** swaps only ever commit on bar boundaries, so
`sceneStartStep` is always a multiple of 32 today; `(globalStep − sceneStartStep) % 32
=== globalStep % 32`. The anchored form is identical for uniform 4/4 and correctly
handles a 3/4 section whose downbeats fall at `sceneStartStep + k·24`, not at absolute
multiples of 24.

## Site-by-site (all counting/display — never audio)

1. **Bar-boundary cadence** — above. `App.tsx` scheduler dispatcher.
2. **Song-mode row advance** — `ghost.ts` `arrangementAdvance`:
   `elapsed = floor((globalStep − cursorStartStep) / barTicks)`; queue next swap at
   `setArrangementCursor(next, globalStep + barTicks)`. `row.bars` now counts the
   referenced bank's bars → "8 bars of 3/4" = 8 × 24 ticks, swap lands on a 3/4
   downbeat. `pendingEnd` end-of-song boundary uses `barTicks` too.
3. **Harmonic-motion boundary** — `harmonicMotion.ts` `globalStep % 32 === 0` →
   `(globalStep − sceneStartStep) % barTicks === 0`.
4. **Beat/downbeat readout + transition count-in** — `App.tsx:~1260`
   `beatInBar = floor(((globalStep − sceneStartStep) % barTicks) / 8)`. Metronome
   *click* stays `% 8` (per-beat, meter-independent); only a downbeat *accent* uses
   `barTicks`.
5. **Grid guide-lines** — `PianoRoll.tsx:~161` (and the main step grid) draw bar
   lines at the meter instead of `i % 4`. Annotate only — do **not** force
   `track.length`; the engine plays any length. For clean song counting, author a
   3/4 bank's tracks to a bar multiple (12 steps @ 1/16 = one 3/4 bar).
6. **Ghost arc/phrase math** — `ghost.ts`/`shape.ts` `STEPS_PER_BAR`. Can adopt
   `barTicks`, or stay nominal (it's an envelope, not beat-critical). Low priority.

## Explicitly untouched

Audio engine, the 24-PPQN **clock stream** (beat-based, not bar-based), clock-follow,
and future SPP (a 16th-note count from song start — meter-agnostic). The external rig
(Mutant Brain, Bluebox, followers) sees no change. The show/lights timeline stays
deterministic: variable-but-authored bar lengths are exactly reproducible.

## Data model

- `BankSlot.meterBeats?: number` (default 4). `store.ts`.
- Persist in `.seq` (round-trips in the bank object). Hydrator defaults missing →
  4, so every existing file is unchanged.
- Helper `activeBankMeterBeats(state)` → `banks[activeBank]?.meterBeats ?? 4`, and
  during a pending swap the boundary should use the **outgoing** bank's meter (the
  swap commits on the outgoing bank's boundary; the incoming bank re-anchors at
  `sceneStartStep = swap step`).

## Authoring / UI

- Small **N/4 meter picker** on the bank (bank/pattern controls). Monochrome, in
  keeping with the UI. This is the ONLY new control — it lives with the pattern.
- Grid bar-lines at the meter (site 5).
- **Song view: unchanged.** No meter column, no picker, no new interaction.

## Edge cases

- **Meter change at a section swap** — clean for free: phase already resets on swap
  (`applyBankSlot` sets `sceneStartStep = swapStep`), so the incoming bank's downbeat
  anchors at the swap and each row counts in its own `barTicks`.
- **Perform / redispatch path** — the `redispatch` branch is already excluded from
  the bar-boundary block; unchanged.
- **Free-play / Ghost autonomous (no song)** — bank dwell + Ghost picks use the same
  anchored boundary; a bank's dwell is now measured in its own bars.

## v0 cut

BankSlot field + persist/hydrate → the anchored bar-boundary (sites 1–2, the audible
half) → meter picker + song-view label → grid guide-lines (site 5) → harmonic +
count-in (sites 3–4). Ghost arc math (6) and compound /8 meters last.
