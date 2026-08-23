---
title: sequence as a data-audioizer
date: 2026-08-23
dek: visualizers turn data into pictures. sequence turns data into behavior which, it turns out, sounds pretty cool
image: assets/data-audioizer.jpg
image_alt: three hurricane tracks drawn as dotted lines on a dark screen — 1880 from ship logs, 1950 from aircraft, 2025 from satellite — above a piano-roll transcription of the storm's wind arc
---

everyone knows what a data visualizer is. you take a dataset, map values to pixels, and if you're lucky you learn something. i've been spending the last while doing the same thing in the other direction — mapping datasets into sound — and i keep wanting a word for it. so: data-audioizer. visualizer, but audio. i'll see myself out.

the thing is, sonification is usually terrible. I have been playing around with an as of yet undecided project idea based around available climate data mapped over time. It's easy enough to map temperature to pitch, press play on a spreadsheet, and you get a sad midi flute climbing a scale for three minutes. technically the data is music, but it just fucking sucks. 

## behaviors, not notes

this is where sequence turned out to be accidentally perfect for this, because sequence was never really built around notes. it's built around **behaviors** — a step has a note, sure, but it also has velocity, probability, ratchet, micro-timing, gate, ties. tracks have roles that shape how mutation treats them. the ghost layer has entropy and density curves that make patterns drift and fill on their own. chords aren't fixed voicings, they're tension positions that the melodic tracks reharmonize against.

which means a dataset doesn't have to map to *what plays*. it can map to *how the system behaves*:

- a value can set a parameter — co2 concentration becomes tempo, a storm's wind arc becomes pitch and velocity contour
- **confidence can become probability** — this is my favorite one. old records are uncertain: three pressure readings from a ship's log in 1880 versus satellite fixes every six hours today. map confidence to per-step probability and uncertainty becomes *audible* — the old data flickers and drops steps, the modern data plays solid. you can hear how well we knew something.
- **the resolution of the record can become density** — sparse records make sparse music, dense records make dense music. the shape of the archive itself is reflected in the output.

none of this requires the sequencer to know anything about climate or hurricanes or whatever else. it just requires an instrument whose parameters are already musical. the data proposes dispositions; the scale quantization, the velocity floors, the role rules — all the musicality that's already baked into the instrument — keeps the output from being a science demo.

## also let's be real, the data probably sounds boring so it should be augmented

the other half of this, and honestly the more important half: the pipeline generates *seeds, not songs*. in this concept workflow the machine's job is transcription — deterministic, documented, reproducible, no taste applied. my job is to respond to what comes back — edit it, orchestrate it, react to it and turn it into my voice. the seam between those two stages is documented, and the seam is kind of the whole point. i don't want a system that writes music from data, nobody wants to fucking hear that. i want a system that hands me something true and lets me be a musician about it.

(every generated pattern traces back to its source values — the provenance chain matters if you're going to claim the music is "made of" the data. receipts or it didn't happen.)

## where this is going

there's a bigger project brewing that uses all of this against a very specific set of datasets — more on that soon. but the general shape is the part i wanted to write down: any experimental dataset with values, confidence, and resolution can drive this instrument. those three axes exist in basically every measurement humans have ever taken. which means basically everything is "playable".