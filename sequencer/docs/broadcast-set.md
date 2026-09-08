# BROADCAST — design (Phases 0–1 done; next: interstitials + the face)

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

## Phase 0 — extract the engine out of App.tsx — ✅ DONE 2026-09-07 (commit 3053bb9, verified by ear)

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

## Phase 1 — the runner boots and plays a set — ✅ DONE 2026-09-08 (commit e843dfa, verified in dev)

Built so far (uncommitted): `sequence_lib::shared_builder()` + `install_media_permission` /
`spawn_level_emitter` / `buffer_opened_files` / `midi_exit_cleanup` in `src-tauri/src/lib.rs`
(`pub mod audio/midi/projectfs/samples`); `projectfs::list_seq_files(paths)` + `launch_args()`;
crate `src-tauri-broadcast/` (bin `broadcast`, product BROADCAST, `com.newspeechsound.broadcast`,
no updater, window `broadcast.html` 1920×1080, `.seqset` association); Vite second entry
`broadcast.html` → `src/broadcast/main.tsx`; `src/state/setLoader.ts` (expandSetPaths incl.
.seqset refs, readSongFile); `src/broadcast/setlist.ts` (zustand `useBroadcast`: entries /
current / next / recent / mode random|sequence; pre-loads the next pick into a free slot and
registers `ghost.setNextSongProvider`; frees the outgoing slot after each swap); `ghost.ts`
`setNextSongProvider` hook (Sequence unchanged when null); `src/broadcast/BroadcastApp.tsx`
(engine installs in App order, `--set/--samples/--device` flags, Finder open + drop → set,
now-playing strip, empty-state loading surface, Space play/stop, Cmd+. panic);
`nativeEngine.presetNativeDeviceName`; npm `broadcast:dev` / `broadcast:build`.
Also landed from the first runs: Ghost-rolled song length for scene-less songs (`maybeEndSongForSet`),
arrangement end → next song, `--song-bars N` dev flag (no UI — the runner has no human controls),
MIDI-only songs skipped, staged song's voices preloaded a song ahead, `js_log` console→Rust trail.
Test set: `~/Desktop/BROADCAST-TEST`. Not yet: Login Item docs, watchdog, `.seqset` written beside
the folder, setlist persistence, `--device` untested against the interface.

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

### The transmission (signal layer) — built 2026-09-08

The picture is a signal that degrades and comes back. `src/broadcast/os/signal.ts` is one envelope
(quality 0..1): a slow random walk (retargets every 30–90 s) plus Poisson-scheduled dropouts /
tears / long fades minutes apart, and the set's own hooks — the last bar of a song pulls the picture
down, the swap (= the incoming downbeat) fires a static burst then a lock flash, a bank count-in
fizzes 4·3·2·1, active-bank entropy leans the drift. `SignalOverlay.tsx` paints it on a canvas over
the whole desktop: 3 px scanlines, a rolling bar (~24 s), phosphor flicker, vignette, full-resolution
static from pre-rendered tiles (capped at 0.55 so the desktop always reads), thin tear strips. The
DOM is only ever tinted (brightness/contrast), never moved — whole-frame motion and full-screen static
were tried and cut (Chris: "awkward", "heavy handed"). `windows ▾ → signal` toggles it (persisted;
off when the physical CRT/camcorder chain does the job). Later tiers on the same envelope: SVG
displacement events, WebGL CRT sim on the visual window. Demo: `?demo=1` + `window.__nsSignal(kind)`.

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

### Interstitials + idents — BUILT 2026-09-08 (06fbb1a)

Shape changed from the plan above: interstitials fire **occasionally on a station clock** (first
14–22 min after boot, then every 18–30 min; `--gap-every N` songs for dev), never between every
song. `src/broadcast/gap.ts` intercepts a song end (`ghost.ts setSongEndInterceptor`), stops the
transport, fires one random WAV from `INTERSTITIALS/` (beside or inside the set folder — Chris's
layout is `BROADCAST/{SEQ_01, INTERSTITIALS, CARDS}`) as a one-shot, and when it ends `loadSong`s
the staged slot and restarts the transport. Phases `hold` → `reboot` (28 s) drive: the signal layer
(gap level → static ceiling 0.86: the OS collapses into noise), `Desktop.tsx` (windows fall away in
a rolled order, menubar + backdrop last; come back one by one), and the fixed-size **NEXT panel**
(`os/NextPanel.tsx`, above the overlay: roll settling on the pick, incoming name, progress bar).
**Station idents** (`src/broadcast/cards.ts`): `CARDS/*.txt` (header lines `kind:`/`weight:`/`url:`,
headline + ≤2 body lines, tokens `{uptime} {songs} {played} {song} {bpm} {time}`); a card every
5–9 min for 32 s in the draggable `ident` window (zxx scramble settles in); folders re-scanned
every minute. Rust `list_dir_files(dir, exts)`. Verified end to end in dev (gap → 64 s WAV →
now playing → reboot). Chris: "the system coming back online after an interstitial is absolutely
incredible."

## Status — 2026-09-08, end of day (the first real transmission)

Three test runs on Chris's machine; the third was the one: `NS_BROADCAST-test01.mov`, 24 min,
standby → GO → 8 songs → 2 interstitials → sign-off. Private YouTube POC. What exists now, all
local on `main`:

**Coming on air.** Launch lands in **standby** (`src/broadcast/boot.ts`, `os/BootPanel.tsx`): the
desktop collapsed, a panel with the set facts and one GO button (space works). GO replays the boot
log typed at 650 ms/line — version, engine, audio device, samples, set, mode, folders, first pick,
staged next — the set loader holds the first downbeat until the last line, then the OS reboots
window by window. `--autostart` (alias `--go`) skips standby for the unattended box.

**Signing off.** `--songs N` (`gap.ts runSignOff`): at the Nth song's end the transport stops, one
interstitial plays under the collapse, the station stays off (gap phase `off`, status `ended`) with
an end-of-transmission panel (`os/EndPanel.tsx`: songs, time on air, interstitials, idents, last).

**The window.** Frameless (`decorations: false`), 16:9 content lock via NSWindow
`contentAspectRatio` (`lock_content_aspect` in the shared lib), exactly 1920×1080 at launch, our
menubar is the drag handle (`data-tauri-drag-region`). Chris won't fullscreen: the layout scales
positions on a 5K display while type stays small (→ future: uniform CSS zoom of the 1512×850 design).

**Sound parity with Sequence.** Three fixes: (1) unsaved instrument edits live in Sequence's
localStorage — Chris "save all"s so they land in kit manifests; (2) `.seq` file-level FX (master
chain, reverb, delay, tape, glitch, saturation, NOISE knobs) were never in a Song snapshot →
`persist.ts parseGlobalFxFromSeq` + `setLoader.readSeqEntry` + `setlist.ts applyGlobalFx` at every
swap (loop unit excluded — no capture, no meaning); (3) `nativeEngine` floors the channel count at
stereo — BROADCAST's fresh storage had remembered a mono (HFP) open and every run was 1 ch.

**Song length.** An authored arrangement (song mode rows) IS the song: one full pass then hand to
the next song, loop flag ignored in a set; Ghost never rolls a length over it; the set loader
engages song mode when rows exist. Row 0 now starts at the swap step (`applySong
cursorStartStep: atGlobalStep`) — live swaps used to skip row 0 and end one-row songs in 2 s.

**Idents.** Cards were firing from the start but drew behind the raised visual window (z 8 vs 84);
a card now raises the ident window. `--first <name>` opens the set with a chosen song.

**Capture chain that works.** `--device BROADCAST` (a Loopback virtual device; Loopback Pass-Thru
+ a monitor to speakers) → QuickTime screen recording with that device as the mic. Loopback's
per-app capture of the dev binary did not work. A device tap for diagnosis:
`ffmpeg -f avfoundation -i ":BROADCAST" -t 20 tap.wav`. Both "audio collapse" reports traced to
files (piper-maru-EXT's master at comp 1.0 / drive 0.68; ns_1548 pan-modulated), not the runner.

**Launch recipe (dev):**
```
cd sequencer/src-tauri-broadcast && npx tauri dev -- -- \
  --set ~/Desktop/BROADCAST/SEQ_01 --samples "<Dropbox>/___NEWSPEECH/__SEQUENCE/SAMPLES" \
  --device BROADCAST --gap-every 3 --songs 8 --first piano-swell
```
Flags: `--set <dir|.seq|.seqset>…` · `--samples <dir>` · `--device <name>` · `--autostart` ·
`--songs N` · `--first <name>` · dev: `--gap-every N` · `--song-bars N`. Folder layout:
`BROADCAST/{SEQ_01, INTERSTITIALS, CARDS}` — the sibling folders are found beside the set.

**Open, in order:** (1) boot audio in-app (an interstitial under the boot log; the gate takes the
WAV's length); (2) a fixed safety limiter at the end of the chain — no file may clip the stream;
(3) uniform CSS zoom for big displays; (4) standalone app (below); (5) WebGL tube on the visual;
(6) unattended layer (LaunchAgent, watchdogs, file log, soak); (7) CRT-safe layout for the
physical chain.

## Standalone app — the next step

BROADCAST runs today only as `tauri dev` from a terminal with flags. To be a thing Chris
double-clicks:

1. **Remember the launch.** The app's own storage keeps the last set folder, samples dir, output
   device, `--songs`, `--first`, and pacing; a bare launch (no argv — that's what a double-click
   is) resumes them and lands in standby. Finder-open of the BROADCAST folder (drop on the icon)
   already reaches the set loader via PendingOpenFiles.
2. **Standby is the settings surface.** The one place operator controls belong: set folder
   (choose…), samples dir, output device (dropdown from the engine's device list — this is how the
   Loopback device gets picked without a flag), songs (∞ / N), first song, autostart. Saved on GO.
3. **A build path.** `npm run broadcast:build` (tauri build in `src-tauri-broadcast/`) already
   produces `BROADCAST.app`. Sequence's `release.sh` does codesign + notarize + dmg + updater
   publish; BROADCAST needs the same minus the updater (no updater plugin in the crate) — copy the
   script, drop steps 4–5, sign with the same Developer ID (team E2587RP7D9). Unsigned it runs
   with a right-click → Open once; notarized it just opens.
4. **Then** the unattended layer (LaunchAgent w/ `--autostart`, watchdogs, rotating file log — the
   log plugin is dev-only today so a release build leaves no trail).

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
