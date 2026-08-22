# copydoc — a hurricane in 4 centuries

source of truth for the words on `hurricane-8e62f3.html`. rewrite anything below in
your own voice, then hand the file back and claude reloads it into the page.

ground rules for the reload to stay mechanical:

- keep the `##` / `###` headings and the `field:` labels — they're the reimport keys.
- paragraphs under a heading map to `<p>` tags in order; add or delete paragraphs freely.
- `**bold**` becomes the bright-ink emphasis; `[text](url)` becomes a link.
- data values are quoted from the real record — change the framing at will, but if you
  change a *number*, flag it so we can re-check it against the source.

---

## meta

- **page title:** a hurricane in 4 centuries — proposal
- **kicker:** newspeech — proposal · private draft
- **h1:** a hurricane in 4 centuries
- **dek:** an EP in four movements, composed from the climate record. each track is generated from what the data says about one year — 1750, 1880, 1950, 2026 — and from how much of a record exists at all. every figure on this page is drawn live from the primary datasets.
- **og description:** an EP in four movements, composed from the climate record. private proposal draft.

## figure caption — warming stripes (header)

global mean surface temperature, 1850–2025, one stripe per year — brightness is the annual anomaly against the 1901–2000 mean (−0.42 °C … +1.26 °C). the hatched zone is the century before the instrumental record begins: for 1750 we have ice, not thermometers. source: NOAA NCEI global land+ocean time series, retrieved august 2026. hover for values.

## 01 premise

- **kicker:** 01 — premise
- **h2:** the historical record is the score

four tracks, four years. each anchor year contributes its own numbers — the carbon in its air, the heat in its oceans, its storms, its losses — and those numbers set the starting conditions of the music: tempo, disorder, density, melody. nothing on the record is invented; the sleeve notes can cite every value.

two things escalate across the four movements: the first is the climate signal itself: from a stable pre-industrial baseline to the first calendar year more than 1.5 °C above it. the second is the record — humanity's measurement of the problem — which sharpens from air bubbles trapped in antarctic ice (one smeared value per decade) to satellites logging the whole planet every six hours. **disorder in the music follows the climate; density in the music follows the measurement.**

so the EP grows progressively more unhinged, but none of it is metaphor. track one is sparse because 1750 is sparse — we barely know it. track four is overwhelming because 2026 is overwhelming — we know it from hundreds of data sources, in full resolution, and it is all fucking coming apart anyway.

## 02 the studio

- **kicker:** 02 — the studio
- **h2:** who is newspeech

newspeech is an audio/visual studio led by chris elkjar — musician, designer, and toolmaker. it builds its own instruments and releases them: the sequencer below, browser-based audio tools, open-source audio plugins, a free sample library recorded from its modular system, and the audio-reactive visualizer system whose language this page borrows. the output is recorded music, live performance, and the working archive at [newspeechsound.com](https://www.newspeechsound.com/).

a hurricane in 4 centuries is built as a collaborative work, not a solo record. the staging asks for more hands than one: players responding live to the generative beds, an operator on the score and visual systems, and — deliberately — research partners. the datasets deserve collaborators who work with them professionally: climate scientists and data stewards invited to review the mappings, challenge the interpretations, and be credited in the finished work. institutional partners are welcomed into the making, not just the booking — a residency, a seminar alongside the performance, students inside the pipeline.

what already exists is the infrastructure: the sequencer, the score engine, the visualizer system and the render pipeline all run daily at the studio. what the collaboration builds is the work itself — the composition, the human pass, and the room it happens in.

## 03 the instrument

- **kicker:** 03 — the instrument
- **h2:** what is sequence

sequence is a generative step sequencer built at this studio, shipped as a native macos app and in daily use here. it has a chord-relative harmonic engine — set a root and a scale, author chords by degree, and every voice harmonizes against whatever played last — and it is built to play itself, mostly: mutation dials on every row, five global macros, sixteen pattern banks, and an orchestration layer whose principal controls are named **entropy** and **density**. it drives its own sample engine and external hardware over midi, so the same sessions run the studio rig on stage.

two properties make it the right instrument for this work. first, its performance vocabulary — entropy, density, mutation — is already the vocabulary the climate record needs; nothing is bolted on to make the mapping fit. second, its session format is a plain data file: a pipeline can write a session the way a scientist writes a table, and the human edit that follows happens inside the same file. the boundary between the two stages of the method — described below — stays inspectable forever.

## 04 the constant

- **kicker:** 04 — the constant
- **h2:** one measurement under everything

a single line runs beneath all four movements: atmospheric CO₂, spliced from antarctic ice (law dome, to 1958) into direct measurement (mauna loa, 1959–). it maps to the one parameter that never resets between tracks — tempo. 277 ppm to 427 ppm; the EP literally accelerates.

### figure caption — CO₂ splice

atmospheric CO₂, 1743–2025, parts per million. each dot is one measurement — the spacing of the dots is itself the story of the record: sparse ice-core samples, then annual instrumental readings from 1959. sources: law dome ice core (CSIRO / NOAA paleoclimatology), mauna loa annual means (NOAA GML). hover for values.

## 05 four anchors

- **kicker:** 05 — four anchors
- **h2:** the movements

### movement i — 1750

- **numeral label:** i — baseline
- **co₂:** 277 ppm — law dome ice core, ±1 ppm
- **temperature:** the pre-industrial baseline. the uncertainty is wider than the signal.
- **the record:** air bubbles in antarctic ice; a handful of thermometers in europe. effectively one value per decade.
- **the storm:** none. no storm record exists for 1750.
- **the music:** near-static. long tones, a pattern that barely mutates, disorder held at zero. the only movement is the uncertainty itself — the width of what we don't know about the year, played as slow detune. no storm appears, because none was written down. the lack of movement is the lack of understanding we have for this period.

### movement ii — 1880

- **numeral label:** ii — instrument
- **co₂:** ≈289 ppm
- **temperature:** −0.19 °C vs the 20th-century mean
- **the record:** the global instrumental temperature record opens in exactly this year. ships log storms by hand; positions are estimates.
- **the storm:** unnamed hurricane no. 2 of 1880 — 130 kt, 931 mb, reconstructed entirely from ship logs.
- **the music:** a clock appears. periodic structure, a grid, monthly resolution — the world starts keeping time. the first storm contour enters as melody, transcribed from a track that is itself a 19th-century data reconstruction.

### movement iii — 1950

- **numeral label:** iii — acceleration
- **co₂:** ≈312 ppm — the postwar plateau (~310 ppm, 1937–1955) is about to break upward
- **temperature:** −0.13 °C vs the 20th-century mean — flat on the surface, loaded underneath
- **the record:** daily readings; aircraft now fly into hurricanes to measure them; direct CO₂ measurement begins eight years later.
- **the storm:** hurricane dog — 125 kt. the 1950 season held the atlantic activity record for half a century.
- **the music:** density rises. mutation opens up, fills arrive mid-pattern, and a second rhythmic system starts to slip against the first — the mismatch is the music. everything still resolves.

### movement iv — 2026

- **numeral label:** iv — saturation
- **co₂:** 427 ppm — mauna loa annual mean, 2025
- **temperature:** +1.26 °C in 2024, the warmest year in the record and the first more than 1.5 °C above pre-industrial
- **the record:** satellites, six-hourly everything; sea ice measured daily; a running ledger of billion-dollar disasters.
- **the storm:** hurricane melissa, 2025 — 165 kt / 892 mb, among the strongest atlantic hurricanes ever measured.
- **the music:** maximum disorder at maximum resolution. the disaster ledger fires events at its true density; voices drop out of the arrangement at the rate the september ice does; the mutation system runs fully open. unhinged, but exact — every extremity on the track is a measured and mappable value.

### figure caption — september sea ice (inside movement iv)

arctic sea ice, september mean extent, 1979–2025, million km². one bar per year; in the fourth movement, this curve is the arrangement — instruments leave as the ice does. source: NSIDC sea ice index v4. hover for values.

## 06 sonification

- **kicker:** 06 — sonification
- **h2:** a storm is already a sequence

the hurricane database records every storm as six-hourly rows — position, maximum wind, central pressure. that is a monophonic sequence: latitude is pitch, wind is velocity, pressure is timbre, six hours is one step. no interpretive layer is needed to make a storm playable; it arrives pre-notated. below, the anchor storms as recorded, and one of them transcribed.

### storm panel labels

- **panel 1:** 1880 · unnamed no. 2 / 130 kt · 931 mb · ship logs
- **panel 2:** 1950 · hurricane dog / 125 kt · aircraft reconnaissance
- **panel 3:** 2025 · hurricane melissa / 165 kt · 892 mb · satellite + aircraft

### figure caption — storm tracks

best tracks from NOAA HURDAT2 (1851–2025). dot size is maximum sustained wind at each six-hour fix. the 1880 track was reconstructed from ship logs; melissa was measured continuously from satellite and aircraft.

### figure caption — melissa transcription

hurricane melissa (2025), transcribed: each column is one six-hour fix, pitch row follows latitude (14.0°N → 46.6°N across two octaves), mark weight follows wind speed (40 → 165 kt). this is the raw material of the fourth movement's lead voice, before any human arrangement. hover for the underlying fix.

## 07 method

- **kicker:** 07 — method
- **h2:** the machine transcribes, the human responds

the work is made in two deliberate stages, and the seam between them is the point.

**stage one is mechanical.** an AI-assisted pipeline pulls each dataset from source, normalizes it into a profile of the anchor year, and writes the initial sequencer session files programmatically — tempo from CO₂, disorder from temperature, pattern density from the resolution of the record, melody from a storm's best track. no taste is applied at this stage. the output is the record, stated as pattern: what the data sounds like before anyone has feelings about it.

**stage two is human.** those sessions are then edited, shuffled, rearranged and orchestrated by hand — the emotional reaction to what the data actually says, made audible. the machine states the facts; the person decides how they land. every departure from the generated material is a documented, intentional act of interpretation, which means the finished tracks carry both layers at once: the measurement, and the response of one person who sat with its ramifications.

the instrument is [sequence](#sequence), described above. its sessions are plain data files — which is what makes stage one possible at all.

### mapping table (parameter / driven by / source)

| musical parameter | driven by | source |
|---|---|---|
| tempo | atmospheric CO₂ (ppm) | law dome + mauna loa |
| entropy / disorder | temperature anomaly and its variance | NOAA globaltemp · berkeley earth |
| pattern density, mutation | resolution of the record itself, per era | all sources |
| lead melody | one storm's best track — latitude → pitch, wind → velocity, pressure → timbre | HURDAT2 |
| event triggers, fills | billion-dollar disaster ledger, at true event density | NCEI / climate central |
| subtraction — voices leaving | september arctic sea-ice minimum | NSIDC sea ice index |

every mapping that survives into the finished music is documented — source, transform, destination — and the mapping document ships with the EP. the data is structural, never decoration.

## 08 visuals

- **kicker:** 08 — the visual program
- **h2:** the same data, drawn

every figure on this page is rendered live in the browser from the embedded record — nothing here is an illustration. the same discipline extends to the performance visuals:

**graphic scores.** the studio's existing score engine renders sequencer sessions as monochrome graphic-score plates (composition, stack and figure views, with alpha-channel video renders for projection). for this work, the underlying data curve for each movement is drawn into the score as its own layer — the notation and its cause on one page.

**storm fields.** the site's audio-reactive visualizer system gains a hurricane-track piece: best tracks drawn as slow monochrome polylines at each era's true storm frequency, intensity driven by the live audio.

**the year as an instrument.** in performance, one physical control scrubs the timeline 1750 → 2026, driving sound and image together — entropy, density, the visible epoch, all from a single gesture. an audience watches the operator move through 276 years by hand.

## 09 datasets

- **kicker:** 09 — sources
- **h2:** datasets

table rows (dataset / covers / resolution / role / access):

| dataset | covers | resolution | role | access |
|---|---|---|---|---|
| [berkeley earth land temperature](https://berkeleyearth.org/data/) | 1750 – | monthly | the only instrumental record reaching the first anchor; uncertainty bounds used as material | open (CC BY-NC) |
| [NOAA globaltemp / climate at a glance](https://www.ncei.noaa.gov/access/monitoring/climate-at-a-glance/global/time-series) | 1850 – | monthly, REST API | global anomaly backbone; the stripes above | public domain |
| [law dome ice core CO₂](https://www.ncei.noaa.gov/access/paleo-search/study/9959) + [mauna loa](https://gml.noaa.gov/ccgg/trends/) | 0 – / 1958 – | ~decadal → annual | tempo, spliced across the whole EP | public domain |
| [HURDAT2 atlantic hurricane database](https://www.nhc.noaa.gov/data/) | 1851 – 2025 | six-hourly per storm | melodies; the title | public domain |
| [NSIDC sea ice index](https://nsidc.org/data/g02135/versions/3) | 1978 – | daily | subtraction in movement iv | open |
| [billion-dollar weather + climate disasters](https://www.ncei.noaa.gov/access/billions/) | 1980 – | per event | event triggers in movement iv | open (NCEI / climate central) |

## 10 formats

- **kicker:** 10 — formats
- **h2:** where it lives

**the recorded EP** — four movements, released with the mapping document as sleeve notes.

**lecture-performance** — the pipeline runs on stage: data pulled, mapped and sounded in front of the audience, with the graphic scores projected. built for university halls, science venues and festivals with a discourse program — the format explains itself to a science-literate audience because every number in it is from the primary record.

**installation** — the year-scrub instrument left running, or handed to visitors: 276 years under one hand.

the project is designed to hold up in front of scientists. all sources are public, the pipeline is reproducible end-to-end, and the boundary between what the data determined and what the artist chose is documented rather than blurred — which is precisely the question the human/AI moment keeps asking, answered in practice.

## 11 status

- **kicker:** 11 — status
- **h2:** where it stands

concept stage, august 2026. all datasets sourced and verified — the figures on this page are drawn from them. next: the data pipeline and the first generated sessions for movements i and iv, then the human pass. the score engine, the sequencer and the visualizer system already exist and are in daily use at this studio.

## footer

newspeech · [newspeechsound.com](https://www.newspeechsound.com/) · private draft — please don't circulate the link beyond its recipient

## index labels (floating nav)

top · premise · the studio · the instrument · the constant · movements · sonification · method · visuals · datasets · formats · status

## labels drawn inside the figures

these live in the canvas-drawing code, not the markup — edit here and claude updates the JS:

- stripes hatch zone: "no instrumental record"
- transcription header: "peak: 165 kt / 892 mb"
- transcription corners: "oct 21 2025 · 14.0°N · 40 kt" / "nov 1 · 46.6°N · 65 kt"
- sea ice marks: "1979 · 7.05" / "2012 · 3.57" / "2025 · 4.75"
