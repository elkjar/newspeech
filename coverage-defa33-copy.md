# copydoc — coverage (wave farm 2027)

source of truth for the words on `coverage-defa33.html`. rewrite anything below in
your own voice, then hand the file back and claude reloads it into the page.

ground rules for the reload to stay mechanical:

- keep the `##` / `###` headings and the `field:` labels — they're the reimport keys.
- paragraphs under a heading map to `<p>` tags in order; add or delete paragraphs freely.
- `**bold**` becomes the bright-ink emphasis; `[text](url)` becomes a link; `*italic*` is a title.
- table sections are `label — text` lines; edit the text at will, add or remove rows.
- **coverage** is a working title. rename it here and everything follows (title, h1,
  og, statement).
- the statement block is the text that goes into wave farm's form. their word limit
  isn't published — the draft runs ~190 words; expect to cut.
- facts about wave farm / wgxc / the fcc rules were checked 2026-09-20 against their
  site and the ecfr. if you change one, flag it.

---

## meta

the hero is a black field of receiver static. the title sits in it and wears: every few
seconds is one pass through the air — characters drop to noise glyphs and don't come
back, the readout counts the generation — until the word is gone, holds, and the loop
re-seeds. hover holds the current generation and cycles the zxx faces.

- **page title:** coverage
- **osd left (top of screen):** newspeech
- **osd right:** wave farm 2027 · transmission art residency
- **title (h1):** coverage
- **readout (under the title):** gen 00 · 90.7 fm
- **dek (bottom left):** a loop is broadcast, received off-air, and broadcast again until the music has worn away and only the station and the landscape it covers remain. a proposal for wave farm's 2027 transmission art residency.
- **hero right:** acra, ny · crestline, ca
- **og description:** a loop broadcast, received, and broadcast again until only the station remains. proposal for wave farm 2027. private draft.

## figure caption — wear across generations (under the hero)

twelve generations of a simulated channel: top end eroding, noise floor rising, the curve leaning. an illustration of the mechanism, not a measurement — the real numbers come off wgxc.

## premise

- **h2:** what remains is the place

a tape loop wears out because the tape passes over the head. this loop wears out because it passes through the air. it is transmitted, received off-air, and transmitted again, and every trip is one generation. the transmitter's modulation ceiling takes something, the path across the valley takes something, the receiver's front end takes something, and what comes back is what goes out next. nothing is processed between generations. the transmitter, the air, and the receiver are the only instruments of change.

run long enough, the music is gone. what's left is the station: its processing, its terrain, its weather that afternoon, the neighbour on the next channel bleeding in at the fade. lucier let a room replace a voice. this lets a coverage area replace a song.

it is audio only. there is no picture. the receiver is the screen.

## the statement

- **note:** the application text. ~190 words; wave farm's limit isn't published, expect to cut.

*coverage* is a loop broadcast, received off-air, and broadcast again. each pass through the air is one generation: the transmitter's modulation ceiling, the path across the valley, and the receiver's front end each take something, and what comes back becomes the next transmission. no processing is applied between generations. the transmitter, the air, and the receiver are the only instruments of change.

over the residency i would run the loop through wgxc 90.7-fm: from the acra studio to the tower, across the coverage area, back into a receiver at wave farm, and out again. new layers are played live over the loop and committed to it by ear, one at a time. under the deviation limit a new layer can only be broadcast instead of the old ones, never in addition, so each commit pushes the earlier layers further down. after enough generations the music is gone and what remains is a recording of the station and the landscape it covers.

the piece culminates in a live evening transmission with no loudspeakers. audiences in the art park listen on handheld radios, and each hears a different generation depending on where they stand. every sound released, on air or on record, has passed through the air at least once.

## the loop

- **h2:** the antenna is the tape head

the loop is a fixed-length buffer on a laptop. it plays out through the transmitter. a receiver picks it up and the return is recorded. when a pass is allowed to **take**, the return replaces the buffer and the next pass goes out one generation older. between takes the loop plays unchanged, so it wears when i decide a pass counts, not on a clock.

a live feedback path would howl in seconds; the air is only milliseconds long. the buffer is what makes it a loop rather than a larsen tone, and it is the same structure basinski and lucier used: discrete passes, each one a complete trip through the medium.

### what compounds per pass

- top end — the transmitter stops at 12.5 khz, fm itself at 15, and the receiver rolls off below that. the ceilings stack. highs go first, like tape.
- noise floor — every reception adds the path's hiss. it never leaves.
- tilt — pre-emphasis at the transmitter and de-emphasis at the receiver never cancel exactly. the tone leans a little further each time.
- the receiver's own reflexes — soft-mute, stereo blend and agc act on a weak signal and are re-recorded as part of it.
- the dial — at the fade, whatever is on the adjacent channel comes in. once it is in the loop it is in for good.
- level — the gain applied between takes is the composition. under unity the loop dies. at unity it wears but persists. over unity it climbs to noise.


## why radio

- **h2:** it can't be made anywhere else

**it is a portrait of the station.** at wave farm the loop runs through wgxc's own studio-to-transmitter link, its processor, its tower and its coverage area, and back into its studio. every generation re-inscribes the station's signal chain onto the material. a plugin could model a channel. it cannot be wgxc.

**the wear is public.** a tape loop decays alone in a studio. this one decays on a frequency anyone can tune to. everyone in range hears the same generation at the same moment on their own radio, and none of it can be rewound.

**the wear is made of the place.** terrain, weather, time of day and the rest of the dial all write into the loop. the same seed run in the san bernardino mountains and in the catskills gives two different pieces, because two different places composed them.

**a frequency carries one signal.** there is a fixed deviation budget. adding a layer means the limiter fits everything under the same ceiling, so new material pushes old material down through the transmitter itself. you cannot broadcast more. you can only broadcast instead. no other medium composes that way.

## the instrument

- **h2:** three controls

### controls

- take — which passes are allowed to replace the buffer. a rate, or by hand.
- ride — a live layer played over the loop and out through the same transmitter. listeners hear it. it is not in the buffer, so it is not yet aging.
- commit — the current pass takes with the ride included. the layer is now in the loop and starts to wear with everything else. the next layer can ride on top.

everything else is the air. every return is recorded whether or not it takes, so the whole stratigraphy exists afterwards: each layer at every age, every committed sum.

## the broadcast

- **h2:** no loudspeakers

the culminating event is a live evening transmission on wgxc 90.7-fm and wavefarm.org/listen, two to three hours, from the acra studio. the only way to hear it in the art park is through a receiver. the audience walks with handheld radios and each hears a different piece: a different generation, a different fade, a different neighbour bleeding in, depending on where they stand.

over the evening i add five or six layers by ear and let the first ones disappear underneath. the listening is the performance. each commit is audible: the loop lurches as the new sum comes back through the air.

## ten days

- **h2:** shape of the residency

### schedule

- before — the loop tool, the seed, and generation zero are built and tested at home against a part 15 transmitter. nothing that can be done in advance is left for acra.
- days 1–3 — wire into wgxc's chain. place the receiver. calibrate what comes back against what was sent. this is the part that is impossible anywhere but here.
- days 4–8 — sessions. short transmissions at different times of day and in different weather, a handful of generations each. between sessions, listen and decide what commits.
- days 9–10 — the evening transmission, recorded off-air. documentation: receiver positions, generation counts, the wear scores.

the ten days are working time with the transmitter, the library and the engineers. the broadcast is something that happens during the residency, not the residency itself.

## generation zero

- **h2:** crestline first

the seed is made at home in crestline, california, at 4,700 feet in the san bernardino mountains, and passed through the air there first: a part 15 fm transmitter, legal without a licence at a couple of hundred feet, into a sampler whose only input is its radio. the mountain gives real terrain shadowing within that range. by the time the loop reaches the catskills it already carries one landscape.

a signal that has crossed the country by being broadcast twice.

this is also the work sample. twenty generations at the desk and twenty from the far edge of the property, side by side, so the panel hears the mechanism rather than reads about it.

## lineage

- **h2:** a room, a tape, a county

alvin lucier, *i am sitting in a room*, 1969: a voice re-recorded through a room until only the room's resonances remain. william basinski, *the disintegration loops*, 2001: tape loops played until the oxide has gone. and wave farm's own history, which began as free103point9, a microradio collective, in 1997.

*coverage* takes the structure of the first, the material of the second, and the medium of the third. the room becomes a county. the tape head becomes an antenna. the transmitter is the one the station already owns.

## rig

- **h2:** a transmitter, a sampler with a radio, a laptop

### rig table

- transmitter — at wave farm, wgxc 90.7-fm through the station's own chain. at home, a rolls hr70, fcc-certified under part 15.239.
- receiver — a polyend tracker, first generation: fm radio in, line out. off-air and mono by design.
- the loop — a browser page on the laptop: buffer, take, ride, commit. built on the studio's existing loop-wear tool.
- limiter — in front of the transmitter, so nothing over-deviates. the only processing anywhere in the chain, and it sits before the air, not after.
- ride layers — sequence, the studio's sequencer, or a small instrument. whatever is played live over the loop.

nothing sits between receiver and buffer. every artifact in the recording is defensible as the transmitter, the air, or the receiver.

## outputs

- **h2:** what comes out

### outputs table

- the transmission — the live evening broadcast on wgxc and the web stream, recorded off-air at the receivers.
- the record — every session's returns, released through newspeech. tracks are generations. the sleeve carries the frequency, the dates, the receiver positions and the weather. offered to wave farm's transmission art archive.
- the wear scores — the pattern rendered as a graphic score at every generation, side by side, so the erosion can be seen. the one place a visual layer belongs.
- a long version — a multi-day run of the loop, seeded from the residency's last generation, proposed for standing wave radio after the residency.
- the study — the simulated channel used for home testing, published as a public tool so anyone can hear how the mechanism works. labelled a study. the work is the one that went through the air.

## newspeech

- **h2:** who is asking

newspeech is chris elkjar's studio: a sequencer, a set of destruction and loop-wear tools, a 24/7 generative broadcast programme, and the records made with them. the practice runs on unsynced systems intersecting and on wear as material. the radio path is the wear source this piece has been missing.

- [broadcast](https://www.newspeechsound.com/) — the studio's autonomous set programme: idents, interstitials, standby, a picture that follows the display.
- [decay](https://www.newspeechsound.com/decay.html) — disintegration loops: a wear map applied to a loop on every pass. the loop tool for this piece starts here.
- [drone](https://www.newspeechsound.com/drone.html), [glitch](https://www.newspeechsound.com/glitch.html), [slice](https://www.newspeechsound.com/slice.html) — the tool pages.
- [news](https://www.newspeechsound.com/news.html) — the record of the work.


## footer

newspeech · [newspeechsound.com](https://www.newspeechsound.com/) · private draft — please don't circulate the link beyond its recipient
