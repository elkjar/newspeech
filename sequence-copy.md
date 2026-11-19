# copydoc — sequence (release page)

the words on `sequence.html`, top to bottom. rewrite anything below, save, and tell
claude — the words get reloaded into the page as written.

ground rules so the reload stays mechanical:

- keep the `##` / `###` headings and the `- **field:**` labels. they're the keys.
- under a heading, plain lines are paragraphs, in order. add or delete paragraphs freely.
- lines starting with `- ` (no bold label) are the small ruled list under the paragraphs.
  add or delete lines freely.
- `[text](url)` becomes a link.
- the six feature words (sequence / mangle / polish / arrange / record / control) can be
  renamed with the `word:` field. to add, drop or reorder a feature, add, drop or move
  its whole `###` block.
- the version history cards are not here: they fill themselves from the release notes
  on github.
- facts in the feature copy were taken from readme.txt. if a rewrite changes what the
  app is said to do, that's yours to get right.

---

## meta

what shows in the browser tab, search results and link previews.

- **page title:** newspeech - sequence
- **description:** a free step sequencer for macos. samples + midi, chord-relative harmony, mutation, song mode, stem recording.

## hero

full-screen video with these over the lower left.

- **title:** sequence
- **download button:** download for macos
- **readme button:** readme.txt

a sample driven (but also midi!) step sequencer with a chord-relative harmonic engine. place steps on a grid like any sequencer, or let it be harmonically aware and shift your patterns around.

## features

the pinned section: six words on the left, the copy for the current word on the right.

### 1

- **word:** sequence

sixteen channels - up to 64 steps each with pitch, velocity, chance, ratchet, timing and gate.

the first melody row is the chord master: pick chords by degree and extension, and it publishes them to the rest. the second is the bass. the others follow the chord, walk the scale, drone on the root, or ignore direction and just do whatever they want.

- change root or scale mid-play and everything reharmonizes
- per-row length, euclidean hits, rotation and step rate
- per-step chord overrides, slice choice and an accumulator

### 2

- **word:** mangle

every row has a mutation dial: velocity jitter, pitch jumps, gate wobble, ties flipping. on the chord master it drops tones, borrows chords from the parallel mode and reshuffles voicings.

six macros move the whole sequence: density, motion, drift, chaos, tension, voicing. also just let auto mode or ghost run the whole thing - you'll figure it out

- the grid stays static, piano roll shows the changes
- freeze holds the current state
- a timing lock per row keeps the rhythm and mutates only the notes

### 3

- **word:** polish

every voice is a sample, played four ways: sample, slice, wavetable or granular. each has trim, tuning, a filter, drive and bit-crush, plus an lfo or envelope per target.

the send chain is a tape stage, glitch, reverb and a synced delay. the loop unit grabs the last 1–8 bars of the mix and plays them back at any speed with a granular layer on top. the noise unit is clocked digital noise through a wasp-style filter.

- a compressor, saturator and eq on every track
- four global lfos, routable to any knob
- a master chain with compressor, distortion and inflate

### 4

- **word:** arrange

song mode gives you an arrangement window to quickly vary and organize patterns into actual songs. break out of the standard sequencer loop. 

- loop a section, drag rows to reorder
- a next-pattern cue with a count through the last bar
- perform pads for live punch-ins: repeat, filter, bits, scrub, chop, reverse

### 5

- **word:** record

record whatever you're doing both as audio and midi. quick demos or final stems, either way works. 

- a .mid beside every stem and for every hardware synth
- export a whole song as midi without playing it
- export any voice as a .pti for a polyend tracker

### 6

- **word:** control

any row can be set to trigger outboard gear via midi. connect your interface and plug in all your fun hardware

- bind any hardware cc to any knob or pad with learn mode
- a launchpad in programmer mode edits the grid directly
- a launch control xl3 preset gives a full pre-built surface

## cards

a grid of small cards, four across. each line is `name — text`. add or remove lines freely.

- **heading:** other cool shit

edit modes — notes, velocity, chance, ratchet, timing, gate — keys 1–6.
ties — shift-click ties a run of steps on melodic rows.
slicing — auto or grid slices, with a slice per step or random per hit.
accumulator — a per-step climbing ladder: wrap, bounce or hold.
kits — any folder of wavs is a kit. note-named files map themselves.
loop to kit — bounce the loop unit into the library as a new voice.
count-in + metronome — a one-bar count and a click that never reaches the recording.
output routing — per-row outputs on a multi-channel interface.
lfo routing — select an lfo, click a knob. grab the knob to override it.
.seq files — songs save as plain json.
panic — ⌘. stops the transport, kills every voice, clears the tails.
updates — checks on launch and asks before installing.

## download

- **heading:** download free
- **download button:** download for macos

the line beside the button is built by the page: version · size · macos 10.15+ · apple silicon + intel · readme.txt · source · discord.

### install

open the dmg, drag sequence to applications.

on first run macos asks for microphone access. that is how the app lists audio devices — say yes.

updates arrive in the app: it checks on launch and asks before installing.

### samples

the app reads kits from `~/documents/sequence/samples`, sorted into `drums/ bass/ instruments/ pads/ textures/ breaks/ loops/` — one folder of wavs per kit.

grab kits from [newspeech samples](samples.html) and unzip each into its category folder. to use another folder: settings → user samples → change…

## elsewhere on the site

two places outside the page that describe sequence. edit here and they change too.

### homepage block

- **badge:** free · macos
- **button:** sequence →

a step sequencer with a chord-relative harmonic engine. set a root and a scale, author chords by degree — the rest of the band harmonizes against whatever played last.

built to play itself, mostly: mutation dials on every row, six global macros, song mode, stem recording.

### link-in-bio row (/start)

- **title:** sequence
- **line:** a free step sequencer for macos
