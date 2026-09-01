---
title: three new browser tools - slice, decay, drone
date: 2026-09-01
dek: TODO one line. e.g. three more ways to break audio in the browser — a morse rhythm slicer, a tape-rot loop, and a breathing drone that exports sampler kits
image: assets/browser-tools.png
image_alt: the newspeech nav with the tools panel open — texture, slice, decay, drone
---

TODO intro — why three tools showed up in a week. (the texture post framed it as "textural assets from sequence ended up in the DAW more than expected" — these three came out of the same pull: decay's demo voice became drone; slice came from wanting rhythm from text/data rather than a grid.)

## slice

TODO — the pitch in your words. what it's for, how you've used it.

![slice](assets/slice-screen.png "slice — NEWSPEECH as a morse phrase, tempo-locked")

TODO — the controls worth calling out: PATTERN / MORSE / BITS / DATA sources · CLOCK (bpm, dah/gap/letter/word lengths, rate 1/4–1/32, straight/triplet/dotted) · SHAPE envelope · SOURCE (internal tone or a dropped loop — gate / chop / scan) · MANGLE (flip, ratchet, drop, scramble-the-message pass by pass).

[try slice](../slice.html)

## decay

TODO — the basinski reference, or not. the "nothing is immediate, everything accumulates" idea.

![decay](assets/decay-screen.png "decay — the demo loop a few passes in, wear map building")

TODO — controls: WEAR (wear / accel / spread) · FAILURE (drop / glitch / smear / repeat) · CHARACTER (wobble / air / room) · RENDER WAV at ×4 / ×8 / ×16 / ×32 passes or TO SILENCE. tape keeps its damage until you reset it.

[try decay](../decay.html)

## drone

TODO — where it came from (decay's demo voice), what "one tone, six harmonics, each on its own slow clock" means in practice, the seed idea.

![drone](assets/drone-screen.png "drone — six harmonics breathing on their own clocks")

TODO — controls: VOICE (tilt / detune) · BREATH (rate / depth) · OUT · AUDITION across nine notes (C3–G#4) · REROLL SEED · EXPORT KIT (nine note-named single-tone wavs, 48k/24-bit, seamless loops, peak −3dB — built for sequence's pad instruments, works in any sampler).

[try drone](../drone.html)

## the nav

TODO — optional short paragraph: four browser tools now live under one "tools" menu (hover on desktop, slide-in panel on mobile). could also just be a sentence in the intro.

---

<!-- ============================================================
     NOTES FOR CHRIS — delete everything below before publishing
     ============================================================

  timeline
    slice   live 2026-08-30
    decay   live 2026-08-31
    drone   live 2026-09-01 (with the tools nav + start-page refresh)

  homepage vignette copy you already wrote (reuse / cannibalize):

  slice — a pattern slicer — type a message and it plays as morse rhythm,
  locked to a clock you set. run the internal tone, or drop a loop and let
  the phrase gate, chop, or scan it. a mangle stage flips, ratchets, and
  drops symbols — or scrambles the message itself pass by pass until it
  erodes into noise. feed it a dataset and the numbers play instead.

  decay — disintegration loops — drop a loop and let the tape rot. wear
  lands where it already hurts, pass after pass: dropouts, stutters,
  muffled patches, until the loop plays itself to silence. nothing is
  immediate; everything accumulates. print the whole collapse as one wav —
  a handful of passes, or the full run to silence.

  drone — a breathing drone instrument — one tone, six harmonics, each
  swelling on its own slow clock, never twice the same balance. twist the
  spectrum, the width, the breath; reroll the seed for a new performance
  of the same tone. when it's right, export the kit: nine note-named
  single-tone wavs, seamless loops — built for sequence's pad instruments,
  ready for any sampler.

  assets
    browser-tools.png   hero candidate — nav with tools panel open, 2880×600
                        (wide strip; the other post heroes are ~1280×800 3:2,
                        so you may want a different hero or a crop)
    slice-screen.png    1440×900 @2x, tool running (morse NEWSPEECH)
    decay-screen.png    1440×900 @2x, demo loop mid-decay
    drone-screen.png    1440×900 @2x, harmonics breathing
    texture-screen.png  existing, from the texture post

  publishing
    move this file to posts/ (drop the _drafts/) — build-news only reads
    top-level posts/*.md, so nothing in _drafts/ ever builds.
    then: bash build.sh, check news/browser-tools.html locally, commit, push.
-->
