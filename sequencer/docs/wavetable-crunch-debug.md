# Wavetable voice — intermittent "crunch" debugging handoff

> **⚠️ CHECK THIS FIRST, before ANY audio-glitch debugging: is another audio app holding the
> interface?** The final stretch of the 2026-07-12 evening session chased mode-independent,
> level-independent glitches through the entire engine — read math clean, no clipping, no CPU
> overruns, fresh process, single stream — and the cause was **Logic Pro open alongside the app**,
> contending for the Apollo. Two hosts on one interface crackle EVERYTHING, from every app, at any
> level, surviving restarts. Symptom signature: glitches identical across playmodes and unrelated to
> engine metrics. One `pgrep -fl "Logic|Live|Reaper"`-class check costs five seconds.

**Status: CLOSED 2026-07-12, user-verified ("this is all fine"). All `[wt-dbg]`/`[wt-smooth]`
instrumentation described below has been REMOVED from `audio.rs`; the three fixes + the smoother
(strong kernel, wf/16 half-width per pass ≈ 4 harmonics kept) remain. Uncommitted at close of
session.** Three engine fixes + a diagnosis. The "crunch" was
three stacked causes, peeled in order with live instrumentation: (1) the k-rate scan-LFO zipper
(fixed), (2) box-average truncation stepping (fixed), (3) **the content itself — arbitrary,
non-wavetable-formatted samples looped as single cycles** (diagnosed, Chris concurs; the Tracker ships
a "wavetable smoother" tool for exactly this — an app-side equivalent is the open follow-up). Also
observed live: occasional master clipping (peak 1.25 > FS) in loud passages of `test-wave.seq` — trim
headroom, separate from the wavetable story. Companion: `docs/tracker-instrument-voice.md` → "Wavetable
mode — BUILT 2026-07-12". The original symptom write-up is preserved at the bottom.

## Evening session (same day) — what the live instrumentation showed

Widened the jump detector to ALL wt voices during sequenced playback of `~/Desktop/test-wave.seq`
(5 melodic tracks, monolith pad on 1/4s, wtPos LFO depth 0.04 / 0.0083 Hz — far too gentle for the
zipper to explain it):

- **Round 1 (post-zipper-fix build):** read jumps >0.1 FS at 6–114/s, magnitudes pinned ≈0.10 —
  audible as random crunch, not note-aligned. → **Fix 3a: continuous box average** (fractional
  endpoint weights in `read_avg`; the old integer-truncated bounds popped whole frames in/out of the
  average as the head strided, stepping the output ~|frame|/n at content positions).
- **Round 2 (post-fractional-box):** jumps >0.1 dropped to ZERO in quiet material; user: "less
  crunching." Added peak + callback-budget tracking: **no clipping in normal passages (peaks 0.12–0.8),
  callbacks ~4ms of 10.7ms budget even in debug, zero overruns** — CPU and clipping ruled out as
  primary causes (one 1.25 peak in a loud section noted above).
- **Round 3 (context capture):** jump bursts (up to 17k/2s, max ≈0.19) fire exactly when the slow LFO
  drifts the scan through **scan ≈ 0.01–0.03 — the first ~2% of the monolith sample, its attack
  transient region** — morph on, no slot-8/9 automation, seam not implicated. Quiet windows in
  between = the LFO sitting in tamer content. Conclusion: the residual crunch is the material —
  morphing/looping 2048-frame slices of transient-dense content is intrinsically rough. Purpose-made
  wavetables don't do this; hence the Tracker's smoother.

**Wavetable smoother — BUILT same session (Chris's go), pending audition.** Per-voice `smooth` toggle
(●/○ next to morph in the wavetable column, default off, persists on `WavetableEdit.smooth`). Chain:
`voiceEditsStore.voiceWavetable()` → `samplePlayer` wavetable block → IPC `wtSmooth` →
`TriggerSpec.wt_smooth` → `trigger_sample`. Engine (`audio.rs`):
- `wavetable_smoothed(src, windowFrames)` — bakes a cached copy per (sample identity, windowSize) on
  the COMMAND thread (audio thread only ever sees a normal Arc): each window circularly smoothed with
  a triangular kernel (2× circular moving average, total ≈ wf/16 → keeps ~16 harmonics; periodic
  filtering = exactly loop-continuous cycles + rounded transients), then RMS-matched to its source
  window (makeup capped 4×). Registry sample untouched.
- Baked windows are periodic but MUTUALLY discontinuous (independent gains/smoothing), so `wt_smooth`
  voices read with **circular in-window Catmull** (`read_cycle_baked`) — taps wrap inside the window,
  never crossing a neighbor; no seam blend; no AA box (content pre-band-limited); stepped switches
  fade A(ph)→B(ph) which lands the wrap exactly on B's continuation. Getting this wrong was measured:
  linear reads over the baked table clicked per cycle at small windows (the seam faded toward
  neighbor-window content that no longer splices) — the circular read zeroed every static outlier
  (harness: wf=64 hot-scan 331 clicks/s → 0, max Δ 0.017; wf=2048 hot region p99.9 0.10 → 0.06 and
  audibly far darker/rounder).
- Parity note: `.pti` export does NOT carry the toggle (the Tracker's smoother is a destructive
  sample-edit tool). Hardware plays the raw sample; local playback is approximate-not-parity as usual.
  The editor's waveform view also still draws the raw sample.

## What it was

**The k-rate `TrackWtPosition` write stepping the scan at block edges (zipper).** The global wtPos LFO
writes `TrackParams.wt_pos_mod` **once per audio block** (~94 Hz at 512 frames); the voice added it to
the scan raw. Every block edge therefore JUMPED the scan → the read landed in different window content
mid-cycle → a hard waveform discontinuity per block. Measured offline (exact port of the read branch,
real pad sample `pad-high-databent-C3.wav`, 0.5 Hz depth-0.5 sweep): **jumps up to 0.58 full-scale,
~25-27/s, at 64-frame windows, every one at block position 0** — morph on or off. That is loud,
irregular-feeling crackle = "intermittent crunch". It tracks the LFO's slope (dense where the sine moves
fast, gone at the extremes), affects every window size, only wavetable voices, and survives restarts —
matching every reported fact. NB the global LFO compute **free-runs with the transport stopped**, so a
routed wtPos LFO also crunches a held editor-preview note; and in stepped (morph-off) mode the
per-frame instrument automation (slots 8/9) caused the same mid-cycle window flips.

**The static read was exonerated.** The same offline port, static scan, all window sizes {64, 128,
2048} × scans {0, 0.5, 1} × morph on/off, renders with **zero discontinuities** (max sample-to-sample
delta ≤ 0.006 at 64/128). A truly static wavetable voice reads clean — the "logical puzzle" resolved on
the side of (b): the time-varying element was the block-stepped LFO write. (Large windows on hot
content are intrinsically harsh — 2048 frames crammed into one cycle at C4 is an 11× spectral
compression; med |Δ| ≈ 0.06 *uniform*, no outliers. That's downsampled-brightness character, not a
defect; the box-average AA keeps it bounded.)

## The fixes (both in the `if v.wt_on` read branch)

1. **Per-frame smoothing of the track LFO deviation** — `Voice.wt_track_scan`, a one-pole (~4 ms tau,
   coeff `wt_track_k` computed once per block) toward the k-rate `track_wtpos` target. NaN-seeded at
   trigger so a voice starting mid-sweep starts AT the LFO value (no onset slew). Static scan is
   bit-identical (state == target). Morph mode now glides: offline max Δ drops 0.45 → 0.12/frame during
   a full-speed sweep, and those are content-rate morphs, not splices.

2. **Stepped mode: window switches land on the phase wrap** — `Voice.wt_wi_cur` / `wt_wi_next`. The
   cycle in flight keeps ITS window (re-picking `round(wpos)` per frame flips content mid-cycle); the
   destination window is latched at **seam entry** (a target that moves mid-blend also clicks); the
   seam crossfade fades the tail toward the DESTINATION's pre-start frames (`read_cycle` gained a
   `seam_base` arg), so the wrap lands sample-continuously on the new window's start. Offline result at
   wf=64 under the same sweep: **27 clicks/s max 0.58 → 0 outliers, max Δ 0.023**. Static scan:
   cur == next == target — identical read to before. Also fixes slot-8/9 automation sweeps in stepped
   mode, and window switches now quantize to cycle boundaries (≤ one period of latency — inaudible).

## Instrumentation left in (remove once confirmed fixed)

RT-safe jump detector for the **monitored voice only** (`WT_DBG_*` atomics near `MONITOR_WT_SCAN`):
counts raw-read sample-to-sample deltas > 0.1 + non-finite samples per frame; the block-end monitor
publish logs `[wt-dbg] read jumps=N/0.5s max=M nonfinite=K` at most 2×/s, only when something tripped.
**How to use:** open the instrument editor on a wavetable voice, hold preview, watch the tauri dev log.
Silence = the read is clean (if crunch is still audible it's downstream of the read or elsewhere);
`jumps≈fundamental/2 per 0.5s` = per-cycle artifact; a handful/0.5s = still something intermittent.

## How to verify (Chris)

- Full Tauri rebuild (`npm run tauri:dev` picks up `src-tauri` edits; not HMR).
- Wavetable pad + global LFO routed to wtPosition, transport stopped, hold preview: the crackle that
  rode the sweep should be gone (morph = smooth glide; stepped = clean per-cycle window steps).
- Same voice, LFO unrouted, static position: should sound exactly as before (bit-identical path).
- Offline A/B renders (same read code, real pad, sweep + static grid) are in the session scratchpad
  `renders/` — `lfo_64_step_raw.wav` (old, crackles) vs `lfo_64_step_smooth_latch.wav` (fixed) is the
  starkest pair.

---

## Original symptom + confirmed facts (2026-07-12, pre-fix — for the record)

A crunchy/glitchy artifact audible ONLY on `wavetable`-playmode voices. Confirmed during the original
session: same voice/note via editor preview clean in `sample` mode, crunchy in `wavetable`; present on
a single sustained preview voice with transport stopped; **believed** scanning-free ("no LFO / no
automation / position held" — but a routed global wtPos LFO free-runs with the transport stopped and
was the likely unnoticed scanner); reported on 64/128 AND 2048-frame windows; not the cpal
zombie-stream issue (that was separately fixed by a clean restart); the seam-crossfade fix attempt
changed nothing audibly (consistent: the wrap was never the problem — the crossfade makes the read a
continuous periodic function of phase, verified in the offline port).

Fixes tried pre-diagnosis that did NOT resolve it: loop-seam crossfade (`WT_SEAM_FRAC`), adaptive
anti-alias box-average (`read_avg`/`aa_n` — a no-op at 64/128 where `step < 1.5`), forced morph while
scanning (later reverted), `deviation` self-morph removal (unrelated, cut by request).
