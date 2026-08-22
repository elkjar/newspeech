# a hurricane in 4 centuries — canon transforms

The mapping document. Every rule that turns the climate record into sequencer
data lives here; anything not listed is a human decision made in the app
(stage two). Rules are only added or changed by Chris's explicit call, and the
date of each call is kept — this file ships with the EP as sleeve notes.

## locked (2026-08-22, by ear against hurricane-arcs.seq)

| rule | transform | source |
|---|---|---|
| tempo | `bpm = round(co2_ppm × 0.35)` → movement anchors 277 / 289 / 312 / 427 ppm = **97 / 101 / 109 / 149 bpm** | law dome + mauna loa annual mean |
| melody pitch | **max sustained wind**, absolute 40–165 kt scale → 15 scale degrees (two octaves) of the session's root+scale, quantized | HURDAT2 per-fix wind |
| melody velocity | same absolute wind scale → 0.30–1.00 | HURDAT2 per-fix wind |
| rhythm placement | fix *k* of *n* lands on step `floor(k × 64 / n)` — E(n, 64) spread across one 64-step pattern at 1/16 | fix count |
| step probability | record confidence per era: **satellite = 100**, **ship-log (pre-1900) = 70**; aircraft era (1944–~1970s) TBD, expected between | era of the storm |
| storms > 64 fixes | compress to 64 (resample policy decided at first occurrence — Dog 1950 is 74 fixes) | — |

## rejected

- **latitude → pitch** (2026-08-22): hurricane tracks ascend latitude almost
  monotonically, so every storm rendered as an ascending scale. Kept as a
  candidate *bass* behavior — a storm supplying both its own melody
  (intensity) and its own slow ascending bass (position) is on the table.

## reserved / unassigned

- latitude — register shifts, filter, or visual layer only
- central pressure — timbre (filterCutoff / fxSend), unassigned
- longitude / forward speed / heading — unassigned
- billion-dollar disaster ledger — movement iv event triggers, not yet built
- september sea-ice extent — movement iv arrangement subtraction, not yet built

## human domain (stage two, never generated)

root note, scale, voice/kit assignment, macro settings, fx, arrangement,
and every edit made to a candidate after generation.
