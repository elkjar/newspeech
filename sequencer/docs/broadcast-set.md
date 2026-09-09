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

**Open (updated 2026-09-09, evening):** (1) tune the tube and the 4:3 arrangement by eye on real
runs; (2) unattended layer
(LaunchAgent with `--autostart`, silence + heartbeat watchdogs, overnight soak, hot-unplug policy)
— **future state** per Chris 09-09: "the use case of me running a set and capturing the output
works for now". Closed since: boot audio (boot static, 09-08), uniform zoom (the 1512×850 stage,
09-08), standalone app (09-08), safety limiter (09-09), Ghost density vs the per-track lock
(lock exempts thin/fill, 8228c92, 09-09), CRT picture (4:3 format, 09-09, below), the tube +
clean looks (09-09, below). Declined 09-09:
row mutes releasing ringing voices — Chris: "having the longer things ring out is the behavior
i'd expect"; mutes and row masks stay scheduler-only.

## Status — 2026-09-09 (v0.1.5)

**Safety limiter.** `audio.rs` `SafetyLimiter`: a fixed brick-wall at the very end of the master
path — after the master stage, before the recorder tap and the device, so recordings match the
stream. Stereo-linked lookahead design: per-frame target gain `min(1, ceiling/peak)` → sliding
minimum over the 2 ms window → exponential release (120 ms) toward unity → moving average over the
same window, applied to audio delayed window−1 frames. Min-then-average makes the gain a linear
ramp that arrives with the peak (no step, no overshoot), and the average of window minimums is ≤
the target of the frame being output, so the ceiling (−1 dBFS) holds by construction; a clamp
stays behind it for float rounding only. OFF by default — Sequence never calls it (one atomic load
per block). BROADCAST enables it once at boot (`BroadcastApp` → `setSafetyLimiter(true)`), before
anything plays, so there is no enable click. Telemetry: `audio:limiter` event (gain reduction in
dB, 30 Hz, only while enabled) → the **sys** window's `limit` row (bar + held peak, 12 dB scale).
Commands: `audio_set_safety_limiter`, `audio_safety_limiter_gr`.

**Boot static crossfade.** The boot WAV is no longer a texture voice with a scheduled
`fadeTextures` (which either cut at the file's end for WAVs under the 32 s cap, or fully faded
before the downbeat — static, a beat of nothing, then song). It is a plain voice on its own
envelope (`boot.ts` `BOOT_WAV_*`): 1.5 s attack, hold, 8 s release, and the gate lands the first
downbeat **1 s into the release** — the song emerges out of the static. Long files hold at most
32 s; short files spend their own tail on the release.

**Interstitials RC000099 / RC000100.** Both originals (Dropbox `___DEBRIS`) carry a constant
+0.22 FS DC offset on both channels, start to end — a DC-coupled source (the drones) into a
DC-coupled recorder input; the other RC files are AC-clean, so the offset is in the source, not the
recorder. The 09-09 normalization pass (5 Hz one-pole highpass) removed the offset but turned the
step at t=0 (and the file end) into a 32 ms decaying thump. Re-derived from the originals with
the constant removed first (`dcshift`), then the same highpass + two-pass loudnorm to −18 LUFS;
DC now 0.000, no start transient.

**Ghost density on melodic tracks (Chris, 09-09: "a bit weird").** Facts: Ghost holds density at
0.5 (= as authored) and gestures +0.05 for 1 bar every ~10–14 bars and +0.1 over the 2-bar
pre-transition build; above 0.5 authored-OFF steps fill in (melodic at half the drum rate), below
0.5 authored-ON steps thin. Anchored tracks (first two melodic slots, root-follow) are exempt;
any further melodic track is not. The per-track **lock** (`lockTiming`, saved in the .seq) exempts
mutation flips ONLY — density thin/fill in `tick.ts` checks `harmonicAnchor` but not
`lockTiming`, so locking a track in the .seq does not stop density touching it, though the
button's tooltip promises a fixed pattern. Candidate fix: `lockTiming` also exempts thin/fill
(two conditions in `tick.ts`). Decision pending.

## Status — 2026-09-09 (v0.1.7) — the 4:3 picture

Chris: "the CRT thing would just be swapping from 16:9 to 4:3 right? … the way sequence detected
the size of the external display would be great to match." So the picture's aspect follows the
display the window is on; nothing is chosen by hand.

**Rust (`src-tauri-broadcast/main.rs`).** `aspect_class(monitor)` = (4, 3) when the display is
narrower than 1.45:1 (a 4:3 CRT is 1.33, 5:4 is 1.25; a MacBook is 3:2 = 1.54 and stays 16:9),
else (16, 9). `fit_to_monitor` sizes the frameless window to that format's full size (1920×1080
or 1440×1080) where it fits the work area, else the largest of that aspect inside it, centres it
in the work area, and locks the content aspect. Runs at launch and again on `WindowEvent::Moved`
when the window lands on a display of the other class (not while fullscreen). **`f`** toggles
fullscreen on the current display (capabilities: `core:window:allow-set-fullscreen` /
`allow-is-fullscreen`) — on the CRT that is the whole tube.

**Frontend (`os/layout.ts`).** `formatFor(innerWidth, innerHeight)` with the same 1.45 threshold →
`Format` `'16:9' | '4:3'`. `FORMATS` carries each picture: 16:9 is the 1512×850 stage exactly as
before (windows under the 28 px menubar, zoom 1, layout key `broadcast.layout.v2`); 4:3 is an
**800×600** picture with a **title-safe area 10% in from every edge** (80,60 → 640×480) that the
windows clamp to (CRT overscan + camcorder framing both eat the border), window **content zoom
1.5** (CSS `zoom` on the window body; the header grows half as fast) so 9–10 px type is ~2.4% of
the picture height, **no menubar on air** (it shows while arranging for the windows menu),
backdrop on by default, layout key `broadcast.layout.43.v1`. Each format keeps its own windows,
backdrop and zoom; `useStage` now carries `{format, w, h, scale, ox, oy}` and a window resize
that changes class swaps the layout (`setFormat`). The 4:3 default arrangement: ghost tall on the
left (300×480), now playing / banks / ident stacked on the right (324 wide); set, shape and sys
closed. Arrange mode draws the safe rectangle with the format label, and in 4:3 a **type −/+**
control (1–3 in 0.25 steps, saved). `SignalOverlay` reads the picture size from the stage. In
4:3 the window body is also the container for the `cqw` headline sizes (NowWindow/CardWindow) so
a title fits its window instead of sizing off the viewport; 16:9 keeps viewport semantics so
nothing moves there. Small squeeze fixes that hold in both formats: GhostWindow's hearing block
yields to decisions (min 60 / 46 px) instead of the two labels overlapping; BanksWindow's header
row is nowrap so the chart keeps its height.

**Moving the window (Chris 09-09: "with the borderless frame you cant drag the window").** The
menubar was the only drag handle and standby collapses it. Now: the empty desktop ground and the
station panel's title bar are `data-tauri-drag-region` (the attribute applies to the element
itself, so windows/panels keep their pointer behaviour), and **`d`** hops the window to the next
display — the frontend emits `broadcast:cycle-display`, `main.rs` listens and runs
`fit_to_monitor` on the next monitor (leaving fullscreen first). Standby shows "d display · f
fullscreen".

**How to use it.** Plug the CRT chain in (Mac → HDMI-to-composite → CRT), press `d` until
BROADCAST lands on that display: it re-fits to 4:3, the 4:3 layout comes up. `f` for fullscreen. Standby → arrange
windows to tune; the arrangement is logged (`[layout] 4:3 stage 800x600 … zoom=…`) like the
desktop one. If macOS drives the converter at a 16:9 mode, pick a 4:3 resolution for that display
(System Settings → Displays, option-click Scaled shows them) — a 16:9 frame squashed to 4:3 by
the converter would distort the picture. Verified in a browser build at 800×600 and 1512×850
(`?demo=1`); the display-follow and fullscreen paths are Tauri-only and need the app.

## Status — 2026-09-09 (v0.1.8) — the tube, and broadcasting clean

Chris: "I do like the idea of making the 'glitchy' style stuff within OpenGL and then also having
the ability to broadcast 'clean' if we're using a CRT. the subtle grain and such isn't going to
render on a CRT anyways so we may as well drop that … setting up the camcorder, TV etc is a lot
of effort vs. just doing a screen capture so having the best version possible for that does
still make sense." And: "we can do it flat and just focus on the tear / shimmer / bloom etc."

**The look** (`os/layout.ts` `Look`, per format, `windows ▾ → look`): **clean** = nothing over
the picture — no signal overlay, no grain SVG, no tube (for the CRT chain: a real tube does all
of it and grain would not survive the trip); **signal** = the 09-08 2D overlay only; **tube** =
the overlay + the WebGL treatment on the visual. Defaults: 16:9 → tube, 4:3 → clean, saved with
the format's layout (`<lsKey>.look`; the old `…v2.signal = 0` migrates to clean).

**The tube** (`os/TubeLayer.tsx`, wrapping the source inside `ReactiveVisual`'s `GlitchWrap`, so
the breathing filter, onset animations, drift and count-in glitch still land on top). FLAT, mono.
The source element (pool video/image — now `crossOrigin="anonymous"` so WebGL may sample it; the
asset protocol answers CORS — camera video, or the demo canvas) keeps playing at opacity 0 and
the canvas draws over it. Per frame: upload the frame as a texture; **bloom** = threshold at
quarter res → two separable gaussian passes → added back, opening with level; **tears** = the
signal envelope's tear bands (`lastSignal()`, the overlay's frame — sampled once, not twice)
displace rows sideways (no static of their own since 0.1.11), and an onset adds a band of its own; **interlace
shimmer** = alternate lines shifted ~0.7 px with the parity flipping every frame, more with weak
reception and level, plus a sub-pixel field jitter on weak reception; **ghost** = a faint echo
shifted right; scanline mask, brightness/contrast from
the envelope, a mild flat vignette. Level/onset arrive via `os/reactiveLevel.ts`, written by
ReactiveVisual's `audio:level` listener. Backing store = device pixels (× stage scale) so the
per-line effects sit on real lines (a resampled 1-px mask moirés), capped at 3072 on the long
side; bloom buffers at 1/4. Strengths in the `TUBE` constant — tune by eye. Falls back to the
plain source when WebGL is missing or a clip's texture upload throws (tainted; logged once).
Verified on the demo page (headless Chrome + SwiftShader): scanlines, bloom on the bright bars,
ghosting visible; 4:3 clean shows no overlay and no grain.

**Tube, second pass (0.1.10).** Chris on 0.1.9: tube vs signal "not seeing much difference" —
every effect was sub-pixel on real footage — and both looks "REALLY hurting the framerate".
Visible now: scanline mask is a 3-device-px cosine at 0.42 (1-px lines vanish at 1080), bloom
threshold 0.42 / rest 0.55, ghost 0.26 at 1.6%, shimmer 1.4 px, static ×0.8, plus a **tracking
wobble** — a band of horizontal drift crawling up the picture (3 px, 9 px on weak reception).
Performance: the ground grain is a 256² noise tile rendered once and repeated (the live SVG
`feTurbulence` + `mix-blend-mode` it replaces was re-rasterised by WebKit whenever the layers
above it moved — the likely reason the *signal* look was slow too); the overlay's static canvas
is capped at 1600 px on the long side and repaints at ≤ 30 fps (the composited bar/veil/flash
layers still move every frame); the tube's backing is capped at 1280, it draws at ≤ 30 fps, and
the video → texture upload (WebKit's expensive step) happens only when the video has a new frame.
`[tube] drawing WxH from video …` is logged once so the app log confirms the tube is live.

## Standalone app — BUILT 2026-09-08 (v0.1.0 in /Applications)

`bash scripts/release-broadcast.sh <version> [--install] [--no-notarize]` → universal
`BROADCAST.app` + dmg, signed with the Developer ID (team E2587RP7D9), notarized via
`sequencer/.release-env` credentials, stapled, optionally copied to `/Applications`. No updater, no
GitHub Release, **no git push**. First build: 0.1.0, notarization Accepted, `spctl` accepted,
installed. Release builds log to `~/Library/Logs/com.newspeechsound.broadcast/broadcast.log`
(8 MB rotation, old files kept); dev logs to the terminal as before. Gotcha: `tauri build` refuses
a workspace where an npm plugin and its Rust crate differ in minor version — the broadcast lock had
resolved `tauri-plugin-updater` to 2.11.0 against npm 2.10.1; pinned with
`cargo update -p tauri-plugin-updater --precise 2.10.1` in `src-tauri-broadcast/`. The installed app
shares the dev app's storage (same bundle identifier), so remembered settings carry over: a
double-click lands in standby with the last set / samples / device / songs.

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
