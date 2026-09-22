# BROADCAST — the director layer

Design, 2026-09-22. Companion to `broadcast-set.md` (the runner, the OS, the signal layer, records,
the gap). D0 + D1 built the same day (status at the end).

## Ask

Chris, 2026-09-22, prepping the second MacBook for the NIGHT SCHOOL stream:

> "the UI / design … relies on very high fidelity. It might be worth us looking at making this
> something that can be more reliably streamed without requiring a very high speed connection"

> "I do want to keep the level of destruction that we have, the signal degrading and failing being a
> compression artifact still does read exactly as that"

> "this wreckage system stream is basic and runs 24/7. the novelty is in the length. I'd like to be
> able to create more visual interest within something that feels like something you'd watch for
> 30-50 minutes"

> "the director layer thing makes a lot of sense to me, changing the whole layout and focusing in on
> specific windows or features"

## What the stream can carry (measured)

Wreckage Systems live, 2026-09-22 10:23, 1080p60 YouTube variant, ten seconds captured:

| | Wreckage | BROADCAST today (1080) |
|---|---|---|
| body text cap height | 13–14 px | ~6 px (8 px font, 69 of 71 size rules are 8–10 px) |
| line pitch | 18 px | ~10–12 px |
| stroke width | 2–3 px | 1 px |
| mean frame-to-frame luma diff | 0.6 / 255 | grain + flicker + scanlines move every frame |
| bitrate YouTube spent | ~1.2 Mbps | — |

Their type survives at a 480p talking-head bitrate because it is big, bold, and still. Ours is
1 px strokes under 1 px grain under a flickering overlay. A fast upload does not fix this: YouTube
re-encodes to ~4–6 Mbps at 1080p regardless of what is sent. The target is "survives a re-encode".

The encoder is the CRT. What was cut for the tube chain (grain would not survive the trip) is cut
for the stream for the same reason. The *events* are different: a macroblocked static burst still
reads as a failing signal, so the destruction stays.

## Principle

**Interest comes from structure in time, not texture on screen.** A hard cut costs one keyframe; a
flickering grain costs every frame forever. Wreckage is wallpaper — three panes, one shot, forever.
A 30–50 minute watch is a program: it changes scale, it cuts on the music, it has things to wait
for. Those are all cheap to encode and all absent today.

## The director

Ghost picks banks and fills for the sound. The director picks **shots** for the picture, from the
same signals, with the signal layer as its punctuation. It never writes the saved layout — the saved
arrangement is one shot (`home`) and everything else is a transient override the desktop renders
over it. When the director is off, the picture is exactly today's.

### Shots

Rects are computed per shot from the stage (`useStage`) and the saved layout (`useLayout.windows`),
in stage px, both formats.

| shot | picture | type |
|---|---|---|
| **home** | the saved arrangement, as designed | as saved (zoom per format) |
| **close `<win>`** | one window fills the safe area, chrome kept, others closed | as saved — more of the same-size content (Chris: per-shot type sizes "awkward") |
| **pair `<a> <b>`** | two windows split the safe area (ghost + visual, now + banks) | as saved |
| **bleed** | the visual with no chrome, full picture, menubar off | — |
| **inset** | the visual full-bleed, the desktop scaled to ~40% in a corner over it | as saved |
| **title** | black, one line of text at ≥ 40 px stage: song title / seed / record id / bank name / a Ghost pick | huge |
| **black** | nothing (sign-off, the beat before a title) | — |

Close-shot candidates: `ghost` (the log becomes narration), `visual`, `now`, `banks`. `set`, `shape`,
`sys` are close-worthy only as a `pair` partner. `card` is never a shot — the ident stays a
lower-third and forces `home` or `bleed` while up.

### Triggers (what cuts)

All read from what already flows: the 10 Hz `state` snapshot, `StreamEvent`s, `useGap`, `useBroadcast`
station, `recordClock`, `cards`.

| signal | cut |
|---|---|
| song lands (swap → downbeat, the signal lock) | `title` (song name, 2 bars) → `home` |
| bank swap (`pendingBank` count-in lands) | a cut. Which shot depends on density (below) |
| fill / Ghost `ghost` event with high weight | `close ghost` for 1–2 bars, then back |
| `mutate` / `param` / `lfo` bursts | `close banks` or `close shape`, short |
| record starts | `title` (record id, seed) → `bleed`; `recordClock` turns the clip; every clip change is a cut between `bleed` / `inset` / `close visual` |
| card shown (`showCard`) | force `home` or `bleed` until `hideCard` |
| gap `hold` / `swap` / `reboot` / `boot` | director stands down; the gap owns the picture (windows fall away, static ceiling) |
| gap `off` (sign-off) | `black` → `title` (sign-off card) → `black` |
| Poisson ambient (like `signal.ts` ambient events) | a cut with no cause, rate ∝ density — keeps a sparse passage alive |

### Holds (how long)

Per-shot `[min, max]` seconds; the actual hold is drawn like `RECORD_CLIP_SECS`, bar-quantised where
a tempo is running so cuts land on downbeats.

| shot | hold |
|---|---|
| home | 30–120 s |
| close | 8–40 s |
| pair | 20–60 s |
| bleed | 15–90 s |
| inset | 20–60 s |
| title | 1–2 bars (2–6 s) |
| black | 1 bar |

Density (the snapshot's curve) scales the cut rate: dense → shorter holds, more `close`; sparse →
long `home` / `bleed`. Active-bank entropy leans the *choice*: calm banks → wide shots, chaos →
close and pair. Same lean the signal layer already uses for drift.

### Interrupts

- Signal events (`dropout`, `tear`, `sync`, `fade`) fire during any shot — they are the punctuation
  and never move the shot. Director may *cause* a `tear` on a hard cut (one `forceSignalEvent`).
- Gap phases override the director entirely (above).
- `arranging` (standby + windows menu) pins `home` so layout work sees the saved picture.

### Transitions

Hard cut is the default — it is the cheapest thing an encoder does and it is the television
grammar. Two moves, used sparingly: **grow** (a window animates from its saved rect to the close
rect, ~600 ms, for slow passages) and **fall** (the reverse, or the gap's existing "windows fall
away"). CSS transitions on the window rects; the desktop already positions windows absolutely and
applies one stage transform.

## The stream look (small, separate)

Next to `clean` / `signal` — or a `stream` flag on `signal`:

- resting grain tile off (`Desktop.tsx` GRAIN_TILE at 0.07), phosphor flicker off, scanlines off or
  6 px pitch;
- signal *events* unchanged, but event static at 2–3 stage px grain (1 px static averages to grey
  under an encoder; 2 px holds as texture);
- gap static ceiling as is — a full-frame texture reads as broken video however it lands;
- type: one uniform step up for the whole picture, never per shot (Chris 2026-09-22: "fonts
  changing size is going to be awkward, but … increase the size across the board in a uniform
  way"). Done as the 16:9 content zoom default 1 → 1.5 (`layout.ts`, saved 1 migrates once); the
  saved arrangement needs re-laying since every window now holds 2/3 of the content it did.

Bitrate starvation during a full-frame static burst is correct behaviour for this piece. If it goes
too far, lower `STATIC_MIN_MS` repaint rate during events.

## Shape of the code

- `os/director.ts` — `useDirector` store `{ shot, since, until, auto }`; `shotRects(shot, layout,
  stage): Record<WindowId, WinRect | null>`; `installDirector(): () => void` subscribing to
  `useStreamState`, `useGap`, `useBroadcast`, `useCards`. Pure scheduling, no DOM.
- `Desktop.tsx` renders `shotRects` when `shot !== 'home'`, saved layout otherwise; per-shot zoom
  passed to `Window`. `Window.tsx` gets a `transition` prop for grow/fall.
- `os/windows/TitleWindow.tsx` (or a `Title` layer, not a window) — the one new surface.
- `windows ▾ → director` on/off (persisted); while arranging, keys `1–7` force each shot so the rects
  are tunable by eye; `?demo=1` + `window.__nsShot(kind)` like the signal demo.

## Increments

- **D0 shots by hand** — rects for every shot, forced by key, both formats. Everything visible before
  anything is automatic. Tune the close zooms here.
- **D1 cuts from the song** — song-land title, bank-swap cut, record bleed, card pin, gap stand-down.
- **D2 holds and lean** — Poisson ambient, density → rate, entropy → choice, bar quantise.
- **D3 title content** — what the title shot says and when (song / seed / record / Ghost pick).
- **D4 stream look** — resting texture off, event grain 2–3 px, 12 px type floor in home.

D4 is independent of D0–D3 and can land first if the stream date needs it.

## Open

- Chris's screen recording → ffmpeg at 1.5 / 3 / 6 Mbps decides the D4 numbers.
- Which windows earn a close shot on the 4:3 picture (only ghost / visual / now are open there).
- Whether `home` should be redesigned sparser once every window has its own shot.
- Second MacBook: BROADCAST fullscreen on one, HDMI capture into OBS on the other. Screen share /
  NDI over the LAN adds a second compression stage before YouTube's.

## Status — 2026-09-22 (D0 + D1 built, local commit, not pushed)

- `os/director.ts` — `Shot`, `frameFor()` (rects per shot from the saved layout + safe area),
  `useDirector` (`on` persisted at `broadcast.director.on`, default on; `auto`), the schedule
  (holds per kind × density, downbeat quantise off `globalStep % 32`, entropy leans the pick,
  never the same shot twice), the event cuts (song landed → title → home; bank swap landed;
  record → title → bleed; ident pins home/bleed; gap stands down, home on return), `forceShot` /
  `resumeAuto`, keys, `demoShot`.
- `os/TitleLayer.tsx` — the title / black shot: zxx sans at up to 96 px stage (64 on 4:3), the
  card scramble settling in, one small mono line under.
- `Desktop.tsx` renders the frame: window rects from the shot (`OSWindow` `rect` + `locked`),
  bleed = the `VisualWindow` full-bleed at full strength (the layout's backdrop mode is the same
  layer at 0.55), inset = the window layer scaled 0.38 bottom-left, menubar off in bleed / inset /
  title / black, `windows ▾ → director` (on, auto · current shot, the nine shots).
- Keys on air (and in `?demo=1`): `1` home · `2` close ghost · `3` close visual · `4` close now ·
  `5` pair ghost+visual · `6` bleed · `7` inset · `8` title · `9` black — each pauses auto;
  `a` toggles auto (resume = home, then the schedule). Standby keeps its digits.
- `window.__nsShot(kind, arg)` on the demo page; every cut logs `[director] <shot> — <reason>`.
- Verified: `tsc -b` clean; all eight shots screenshotted on the demo page (headless Chromium);
  a 150 s auto soak with an ident and a gap hold (log in the session).
- Not yet: D2's Poisson ambient cuts with no cause (holds alone drive the schedule for now), D3
  title content beyond song / record / bank, D4 the stream look (waits for the screen recording),
  grow/fall transitions (every cut is hard).
