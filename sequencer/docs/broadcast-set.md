# BROADCAST — design (Phase 0 in progress)

*2026-09-07. Chris: "a 'broadcast' version … create a series of seq files and we could load them
up and have a 'set' of ever changing variations on the .seq files broadcasting out." Then: "I'd like
all of this to live outside of Sequence … booted outside the sequence app and just loaded up with a
boatload of seq files and set loose." Face: "a visual of the decisioning that is happening within
the .seq files … tie in the visualizer aspects … the wreckage systems visual feel of this being
'65dos OS' … a desktop / terminal window."*

The app is **BROADCAST** (Chris, 2026-09-07). "The runner" below means BROADCAST.

## What it is

A second app, not a mode of Sequence. Point it at a folder of `.seq` files (or drop files on it),
it boots straight into playback and never stops: Ghost walks each song's banks, drives density,
fills and per-lead mutation, swaps songs at composition end, wraps at the end of the set. Audio
leaves through the interface to whatever captures it (OBS → YouTube, Bluebox, a room). The window
is the stream face: a fake operating system, a desktop of terminal-style windows each showing one
thing about the running system, plus the visualizer.

Sequence stays the editor. Chris authors and tunes songs there. The runner only consumes `.seq`.
Both cannot run at once on the same interface (the cpal engine is process-global).

## Why it's tractable (coupling audit, 2026-09-07)

The engine layers are already clean enough to share:

- **Rust** (`src-tauri/`, single crate `sequence_lib`, 12.4k lines, 9.8k in `audio.rs`): the audio
  engine is process-global `OnceLock` state with **no `tauri::State`**. Tauri touches it in only
  two places — the 58 `#[tauri::command]` wrappers at the end of `audio.rs` (~830 lines) and the
  recorder's `AppHandle` for `recorder:finalized`. `reverb.rs` / `delay.rs` / `reverb_dsp.rs` have
  zero Tauri. `audio:level` / `audio:time` are emitted by a poll thread in `lib.rs:449-464`, not
  from inside audio.
- **TS engine** is React-free and never imports `src/components/`: `src/audio` (7.3k), `src/engine`
  (1.1k, `tick.ts` header literally says "the caller (App.tsx, or a future native / VST shell) owns
  all I/O"), `src/ghost` (1.3k), `src/state` (5.2k), `src/instruments` (1.9k), `src/midi` (4.7k).
  The zustand store is used by the engine only via `getState/setState/subscribe`.
- **Stream visuals** (`src/stream/*`, 1.2k + `StreamWindow.tsx`) never import the store; they
  consume `StreamEvent` batches over Tauri events, and the presence handshake already makes
  same-webview self-emits work (`streamEvents.ts:136-143`). They render in the runner unchanged.
- **Entry fork** exists: `main.tsx` switches on `?window=stream`. A `?window=broadcast` branch costs
  no build config. `capabilities/default.json` needs the new window label.

What is NOT clean: **`App.tsx` (2,408 lines) holds ~1,400 lines of engine wiring** that must move
into modules before a thin entry can exist. That extraction is the real work; the app shell after
it is a few hundred lines.

## Phase 0 — extract the engine out of App.tsx (Sequence-only refactor, no behavior change)

Mechanical moves, each verified by playing the same `.seq` in Sequence before/after. Order matters:
the dispatcher last, because it's the delicate one.

| from `App.tsx` | to | notes |
|---|---|---|
| 1995-2075 native sample preload + store subscription | `src/engine/samplePreload.ts` | already a queue, trivially portable |
| 1872-1950 LFO snapshot → `setLfos()` | `src/engine/lfoPush.ts` | |
| 1457-1859 rAF loop pushing base params to Rust | `src/engine/paramPush.ts` | **switch rAF → `setInterval`**; WKWebView throttles rAF on occluded windows |
| 1433-1446 mix-routing push · 1220-1224 `scheduler.setBpm` · 1147-1218 live chord re-voicing · 1959-1974 glitch dice | `src/engine/boot.ts` (subscriptions) | |
| 357-443 boot (`initMIDIOut`, `initGhost`, `initProject`, midi maps, `initMIDIIn`, controllers) · 582-603 kit scan → `bootDone` · 1416-1427 `initEngineClock` → `initNativeAudio` → rate watch → recorder | `src/engine/boot.ts` `bootEngine(opts)` | `bootDone` becomes a store field, not `useState`; `initProject` and `subscribeNativeRecorder` become opt-in |
| **618-1138 the dispatcher** (`dispatchTick`, bar-boundary commit order at 635-698, `runTick`, batch build → `triggerBatch`, MIDI out, `emitStreamEvents`, `scheduler.onStep('app:dispatcher')`, perform edge handler) | `src/engine/dispatcher.ts` `installDispatcher(): () => void` | the heart; closure-captured `harmonic` state → module state; keep the ordering comments |
| set loading inlined in `PerformanceDialog.tsx:400-450` | `src/state/setLoader.ts` | read → `parseSongFromSeq` → `replacePerformance`; call `persist.importProject` directly, not `Transport.tsx:112` |

Rust side of Phase 0: `pub mod audio; pub mod samples; pub mod projectfs;` in `lib.rs:1-6`, and
factor the 100-entry `invoke_handler` list (`lib.rs:337-433`) into a reusable `register(builder)`.

Ships as a Sequence point release with zero user-visible change. Soak it a few days before Phase 1.

## Phase 1 — the runner boots and plays a set

- **Crate**: `src-tauri-broadcast/` (product name BROADCAST, identifier `com.newspeechsound.broadcast`) with its own `tauri.conf.json`, `capabilities/`,
  and `sequence_lib = { path = "../src-tauri" }`. Add a root workspace `Cargo.toml` (one lock, one
  target dir). Skip the updater, dock-icon and WKUIDelegate code; register the shared handlers.
- **Entry**: `?window=broadcast` in `main.tsx` → `<BroadcastApp/>`: `bootEngine({ initProject:
  false, recorder: false, controllers: false })` → load set → Ghost on → `togglePlayback()`.
  No `scheduleUpdateCheck()` — nothing may ever pop over a live stream.
- **Set = folder**: Rust `list_seq_files(dir)` (mirror of `pool_list_visuals`) → `setLoader`.
  Beyond `PERFORMANCE_SLOT_COUNT = 8`: a `setlist: SeqsetSongRef[]` queue that pages songs into
  slot rotation one song ahead (parse cost paid early, slots stay 8). `.seqset` written beside the
  folder so it reopens; `.seqset` file association on the runner, not Sequence.
- **Loop, random by default** (Chris: "load this with as many ideas as possible and then let it
  go"). `findNextSong` (`ghost.ts:920`; the comment at :917 invites a loop) grows a pick mode:
  `random` (default) — uniform over the setlist minus the last N played (N = min(setlist/2, 8)) so
  nothing repeats soon and everything gets heard; `sequence` — folder order, wrapping. Same
  Polinski trick applies for weighting: drop a song in twice and it plays twice as often. Ghost
  `enabled` carried by the set and forced on at boot.
- **Launch**: `--set <path>` CLI arg and Finder open of a `.seqset` / folder. Login Item for
  power-loss recovery (`open -a <Runner> --args --set …`). Watchdog: cpal stream death or
  `audio:level` flat zero for N s while playing → `process:allow-restart`.
- **Window must stay visible.** The scheduler is `setTimeout(25ms)` with a 250 ms horizon
  (`scheduler.ts:16,163`); WKWebView throttles occluded windows and would starve the trigger
  queue. The runner's window IS the stream output on the capture display, so this holds by
  construction — but never "hide to tray".

Audible test: a folder of 8+ songs at the studio, boot from the Login Item, walk away overnight.

## Phase 2 — the face: "65dos OS"

A desktop of windows, monochrome, zxx fonts, the site's grid + grain, invented window chrome (not
macOS). Windows are draggable/closable by hand, but the app boots into a **saved broadcast layout**
so unattended it always looks the same. Everything below reads the existing 10 Hz `state` snapshot
+ `StreamEvent` log, or the store directly (same webview) — rendering work, not engine work.

| window | shows | source |
|---|---|---|
| **set** | the folder's songs as rows: current lit, next queued, elapsed / dwell per song, each song's Ghost range (shape, minBars–maxBars, phaseLength). Drop target: folder or `.seq` files join the set live. | `Performance` + setlist + `sceneGraph` per song |
| **ghost** | the pick log as a scrolling terminal (bank picks with weights, fills, macro moves, mutation spotlight), density + 5 macro meters | `ghostPickLog`, `StreamEvent` `ghost/param/mutate`, `state.macros` |
| **banks** | current song's 16-slot bank map, entropy per slot as bars, the walk drawn as a path, pending bank + 4·3·2·1 count-in | `state.bankSummary`, `activeBank`, `pendingBank`, `transitionCountIn` |
| **shape** | the arc curve with phase cursor and target entropy | `shape.ts` `phaseAt`/`targetEntropy` (already used by Datafeed) |
| **now** | song name, bpm, key/scale, set position, uptime. Same data the sidecar writes. | `applySong` |
| **next** | shown only during an interstitial: candidates, recent-N greyed, the roll settling on the pick, then the incoming song's bank map + Ghost range. The decision, on screen. | setlist + pick mode + `sceneGraph` of the pick |
| **visual** | visualizer (core.js pages, audio + beat reactive) or pool video; the one window that can go full-bleed behind the others | `src/stream/Visualizer.tsx`, `Pool.tsx` |
| **sys** | audio device + sample rate, CPU, active voices, buffer underruns, watchdog state, last restart | `audio_output_level`, engine stats (add a small `audio_stats` command) |

The existing `Datafeed.tsx` (density trace, entropy histogram, breakdown, shape preview, event
log) is the seed for **ghost**, **banks** and **shape** — split it into windows rather than rewrite.

## Phase 3 — interstitials: the gap is a moment

- Today: `fadeTextures` 6 s, then a hard `swapSongImmediate` into bar one. Over a night the gap is
  the seam you hear.
- **Interstitial WAVs** (Chris): an `interstitials/` folder beside the set. When a song ends the
  runner fades textures, fires one random interstitial WAV through the engine as a one-shot voice
  (`audio_load_sample` + a trigger on a reserved bus, no grid), and shows the **next** window while
  it plays: the set's candidates listed, the recent-N greyed out, a roll that settles on the pick,
  then that song's bank map and Ghost range fade in. The swap lands when the WAV ends (or at a
  minimum of N bars if it's short). The interstitial's length IS the gap — Chris authors the pacing
  by what he puts in the folder. Interstitials are the WS "static between systems", made visible.
- Fallback when the folder is empty: a set-level **static bed** voice held low across the swap,
  ducked under a running song. Same mechanism, one file.
- **Intro / outro bank kinds** (`BankSlot.kind` already has `transition`): Ghost uses them only as
  first / last pick of a song → each song gets the Wreckage Beginning/Ending arc without a state
  machine.
- Per-song `tailOutBars` so a drone rings 8 bars and a beat cuts at 1.

## Phase 4 — the sidecar and the capture chain

- `now-playing.txt` (or JSON) in the set folder, rewritten by `applySong`: song, bpm, key, shape,
  elapsed. OBS reads it as a text source. This is Polinski's `StreamMetadata` and it's all his
  overlay needs.
- Audio routing is outside the app: interface → OBS (or Bluebox → OBS). No code.
- Optional later: the runner captures its own audio as rolling hourly WAVs for Bandcamp harvesting
  (the recorder today has a 15 s tail cap and no rotation — a new path, not a tweak).

## Phase 5 — running for days

- Soak with Activity Monitor: `ghostPickLog` ring cap, `StreamEvent` log DOM growth, decoded
  buffers per song swap (kits are shared, verify), the setlist paging.
- Sample-rate watch (2 s poll, auto-reopen) exists; confirm it recovers a device flip mid-set.
- Mac side: sleep off, display never sleeps, interface on mains, Login Item, OBS auto-start.
  Same kiosk layer the climate installation needs ([[project-climate-ep]]) — build once.

## Later, if the sound wants it

- **Per-hit sample pools** — a voice with N alternates, one picked per trigger. Polinski's one
  primitive we lack; small `samplePlayer` change, big variety payoff on beds.
- **Weighted song transitions** — a `next` distribution per song. Only after shuffle feels aimless.
- **Free-time tracks** — Poisson-fired steps with a rate range (Scatterer texture).

## Hard parts that aren't code

- **The songs.** Each `.seq` needs its Ghost range set so it stays interesting for its dwell
  without falling over. Listening work, per song, in Sequence.
- **The seams.** Whether a static bed is enough or the swap wants a real crossfade — decidable only
  by ear after Phase 3.
- **The machine.** A studio Mac running the runner + OBS for days.

## Order

Phase 0 → 1 → 2 → 3 → 4 → 5. Phase 0 is invisible but is the whole cost; once it lands the runner
is a shell. Phase 2's face can start in parallel with Phase 1 since it reads the same snapshot the
stream window already gets. The **next** window and the interstitial player ship together (Phase 3).
