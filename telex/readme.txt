# TELEX field card

Short scripts typed on the pads. They play TELEX's test voice and send MIDI notes and CC to the rack: ten scripts of six lines
(1-8, M for the metro, I for when a scene loads) and four patterns of up to 64 numbers. The language is Teletype's, cut down and
pointed at MIDI (box/script/lang.h). Every code line here compiles with TELEX's own parser. The same card as a page, with an
emulator that runs the firmware in a browser: https://www.newspeechsound.com/telex/

## First minutes

1. Song, Down to TELEX, F1. The tabs are the scripts; the encoder picks one.
2. Script 1, line 1: type `NOTE 60`, Insert. F1 plays it. F1-F8 run scripts 1-8.
3. Change it to `NOTE + 60 RAND 12`, Insert, F1 a few times.
4. Encoder to M: `NOTE DEG RAND 7`, Insert. Play runs M every 500 ms; Play again stops.
5. Sparser: M's line becomes `PROB 40: NOTE DEG RAND 14`.
6. Faster: script 1, line 2: `M 125`, F1. (Settings like this belong in I, which runs when a scene loads.)
7. Keep it: Pattern (SCENES), an empty slot, F2.

## How a line reads

From the right: each word takes the values to its right and gives one back.
`NOTE + 60 RAND 12`: RAND takes 12 and gives 0..12 (say 7); + takes 60 and 7, gives 67; NOTE plays 67.

- A variable or setting first on its line with a value after it is set (`X 5`); anywhere else it is read (`NOTE X`).
- `;` splits commands: `X + X 1; Y 2`.
- A mod starts the line, then its values, then `:` and the command: `PROB 30: NOTE 72`. One mod a line.
- Whole numbers, -32768..32767; division by zero is 0; lower case reads as capitals.

## Keys

The pads (Shift: the top row's symbols, `! @ # $ % ^ & * ( ) _ |`):

```
1 2 3 4 5 6 7 8 9 0 - +
Q W E R T Y U I O P * /
A S D F G H J K L : < >
Z X C V B N M . % = ; space
```

| Key | Does |
|---|---|
| Insert | enters the line (it runs from then on); a line with an error is not entered, the error shows in red |
| Shift + Insert | an empty line at the cursor, the lines below moved down (only while line 6 is empty) |
| Delete / Shift + Delete | the letter before the cursor / the whole line |
| Left, Right (Shift: start, end) | the cursor |
| Up, Down | the line; a changed line is entered on the way, one with an error keeps you on it |
| Shift + Up, Down | move the line up or down a row (lines run top to bottom: settings before the note they change) |
| encoder | the script: 1-8, M, I |
| Copy / Shift + Copy | copy the line / paste over it |
| F1-F8 | run scripts 1-8 |
| Shift + F1, twice | init: start from nothing (scripts and patterns empty, settings at their defaults, metro stopped; saved scenes stay) |
| Shift + F2 / Shift + F3 | undo / redo: the lines as they were before the last edit, or forward again (16 steps; the cursor goes to the line that changed). A line being typed goes first: Shift + F2 gives it back as entered. Loading a scene starts the history over |
| Play | the metro on and off (MIDI start and stop too) |
| Shift + Play | runs I again now (its settings take effect; variables, patterns, metro stay) |
| Shift + F8, then encoder | MIDI out channel: off, 1-16 (DIN and USB); any key, or 3 s without a turn, gives the encoder back |
| Master + Shift + encoder | TELEX's level |
| Pattern | SCENES |
| Rec | RACK: the LFOs and clocks as they run (Rec again: back) |

SCENES: Up/Down or the encoder choose a slot (Left/Right the other column); F1 loads (variables reset, I runs, back to the
scripts; Play starts the metro); F2 saves (twice when the slot holds a different scene); F3 renames (the slot's title typed on
the pads, lower case unless Shift; F1 or Insert keeps it, F8 cancels); F4 twice deletes (the slot empties; the card keeps its
last scene as `Scripts/NN.txt.bak` until the slot is saved again); Pattern or F8 back. The scene being played saves itself and
comes back at power-up. From the console: `telex rename <slot> <text>` (`_` for spaces), `telex delete <slot> yes`.

## Words

| Word | Does |
|---|---|
| `A B C D X Y Z T` | eight shared numbers, 0 at the start; set |
| `I` | L's counter, each script its own |
| `NOTE n` | plays MIDI note n on the voice, and out when CH is set |
| `VEL` | velocity, 1-127 (100); set |
| `LEN` | MIDI note length, ms (200); set |
| `CH` | MIDI out channel, 0 off, 1-16; set |
| `CC n v` | controller n, value v, on CH |
| `INST` | the instrument the next notes play: the `Instruments/` folder starting with that number (`015 rhodes-mk1` = 15); 0 the test voice; set |
| `PAN` | where the next notes sit: 0 left, 50 centre, 100 right (50); set |
| `ROOT` | the scale's root, MIDI note (48 = C3); set |
| `SCALE` | 0 major, 1 minor, 2 dorian, 3 phrygian, 4 lydian, 5 mixolydian, 6 pent maj, 7 pent min, 8 chromatic; set |
| `DEG d` | the note d scale steps from ROOT (7 = an octave in a 7-note scale; below 0 goes down) |
| `Q n` | the scale note nearest n |
| `WAVE` | 0 sine, 1 triangle, 2 saw, 3 square (1); set |
| `DEC` | decay, ms (400); set |
| `TONE` | brightness, 0-100 (60); set |
| `RAND n` / `RRAND a b` | random 0..n / a..b |
| `TOSS` | 0 or 1 |
| `DRUNK` | steps -1, 0 or +1 each read; set to place it. `DRUNK.MIN`, `DRUNK.MAX` its range (0..255) |
| `ER f l s` | 1 if step s is a hit of f hits over l steps (Euclidean) |
| `P.NEXT` / `P.PREV` | next / previous step of the pattern, its number |
| `P.HERE` | the current step's number; set |
| `P i` | step i (below 0 from the end); `P i v` first on a line writes it |
| `P.I`, `P.L`, `P.N` | current step, length, which pattern (0-3); all set |
| `M` | metro time, ms (500, at least 10); set |
| `M.ACT` | metro on (1) / off (0); set |
| `M.RESET` | the metro counts again from now |
| `BEAT`, `BPM` | a beat in ms at the box's tempo; the tempo |
| `+ - * / %` | ADD SUB MUL DIV MOD |
| `MIN MAX`, `LIM x lo hi`, `WRAP x lo hi`, `ABS` | smaller, larger, held in range, wrapped round, without sign |
| `== != < > <= >=` | EQ NE LT GT LTE GTE: 1 true, 0 false |
| `&& \|\| !`, `EZ`, `NZ` | AND OR NOT, is zero, is not zero |
| `SCRIPT n` | runs script n (1-8), 4 deep |
| `DEL.CLR` | drops waiting DELs |

## Mods

| Mod | The command runs |
|---|---|
| `PROB n:` | n % of the time |
| `IF x:` / `ELIF x:` / `ELSE:` | when x is not 0 / when nothing above took and x is not 0 / when nothing above took |
| `L a b:` | for each I from a to b (at most 64) |
| `EVERY n:` / `SKIP n:` | every nth time / all but every nth |
| `OTHER:` | when the EVERY or SKIP above did not run |
| `DEL ms:` | ms from now (16 can wait) |

## Instruments

`INST n` plays the card's instruments as WAVE picks the test voice's shape; switch every line (`INST 3; NOTE 72`, then
`INST 15; NOTE DEG RAND 7`). Four at once: the first time a scene names one (best in I) it loads from the card in a second or
two, silent until it is in; the "inst" row shows each slot (filled in, outlined loading, red no such folder); a fifth replaces the
one played longest ago. One-shots, kept mono (half the memory; PAN places each note); 8 zones at most each, from the one nearest C3
outwards. WAVE / DEC / TONE shape the test voice only. The memory is SAMPLER's and GLITCH's pool, borrowed while TELEX is in use:
leaving TELEX gives it back (SAMPLER reloads its sound; GLITCH and LOOP start empty, an unsaved LOOP reel is lost), coming back
loads the instruments again.

## Rack

Four LFOs and four clocks, set from the scripts (usually I). Each fires a script on its own timing and gives a value; an LFO can
stream itself out as a MIDI CC on CH (TELEX as a modulation source for the rack). Play starts and stops what fires scripts (metro,
clocks, LFO cycle triggers); the LFOs never stop moving, so their values and CC streams carry on. Rec shows them.

| Word | Does |
|---|---|
| `LFO n` | LFO n's value now, 0-100 |
| `LFO.R n ms` | its cycle (4000, 6100, 9300, 15700 at first) |
| `LFO.W n w` | shape: 0 sine, 1 triangle, 2 saw, 3 square, 4 steps (random each cycle), 5 drift (gliding random) |
| `LFO.S n s` | the script (1-8) its cycle fires at the top; 0 none |
| `LFO.CC n c` | streams it as CC c on CH; 0 off |
| `LFO.RESET n` | to the start of its cycle |
| `CLK.T n ms` | ticks every ms (0 stops it), free of the others and the metro |
| `CLK.S n s` | the script (1-8) each tick fires; 0 none |
| `CLK n` | its tick count (`CLK n v` first on a line sets it) |
| `CLK.RESET n` | the next tick now, the count to 0 |

| Where | Lines | Does |
|---|---|---|
| I | `CLK.T 1 700; CLK.S 1 1; CLK.T 2 1100` / `CLK.S 2 2; CLK.T 3 1300; CLK.S 3 3` | three clocks colliding |
| I, 1 | `LFO.R 1 20000` / `PROB LFO 1: NOTE DEG RAND 5` | density that breathes |
| I (CH set) | `LFO.R 2 9000; LFO.W 2 5` / `LFO.CC 2 74` | a slow filter for the rack |
| I, 4 | `LFO.R 3 4000; LFO.S 3 4` / `VEL 127; NOTE ROOT` | an accent each cycle |

Scene 05, "collisions", is built only from the rack.

## Recipes

| Where | Lines | Does |
|---|---|---|
| M | `NOTE DEG RAND 7` | random notes in key |
| M | `PROB 40: NOTE DEG RAND 14` | sparse, two octaves |
| I | `M / BEAT 4` | sixteenths at the box's tempo |
| M | `IF ER 3 8 T: NOTE ROOT` / `T + T 1` | Euclidean 3 in 8 |
| M | `NOTE DEG X` / `X WRAP + X 2 0 6` | arpeggio up the chord |
| I, M | `DRUNK.MIN 0; DRUNK.MAX 14` / `NOTE DEG DRUNK` | drunk melody |
| 1 | `L 0 2: NOTE DEG * I 2` | a chord on F1 |
| 1 | `NOTE 60` / `DEL 250: NOTE 72` | a note and its echo |
| M | `EVERY 4: VEL 127` / `OTHER: VEL 60` / `NOTE DEG RAND 7` | accent every fourth |
| M | `IF TOSS: NOTE + 12 DEG RAND 7` | octave jumps by coin toss |
| M (CH set) | `CC 74 Y` / `Y WRAP + Y 4 0 127` | a filter sweep on the rack |
| 2 | `SCALE WRAP + SCALE 1 0 8` | next scale on F2 |
| M | `NOTE P.NEXT` | walk pattern 0 |

## Errors and limits

| You see | It means |
|---|---|
| unknown word FOO | not a TELEX word, or a typo |
| NOTE needs more values | a word lacks the values to its right |
| a value left over (set a variable, or NOTE it) | a value nothing uses (`X` alone) |
| a ':' after the mod's values | `PROB 50 NOTE 60` |
| DEL goes first, with ':' after it | a mod mid-line: give it its own line |
| nothing after ':' | a mod with no command |
| too long | over 40 characters |
| too much at once | the scripts needed more than a block of audio allows (1.5 ms); the run that passed the budget stopped there, the rest of it dropped. Shows while it happens and 4 s after; the box log says the budget it had ("telex: 2 cut short, budget 440 words") |

Ten scripts, six lines, 40 characters. Six voices (a seventh note takes the oldest). About 990 words of work a block (less with
the delay or reverb running).

## Scene files

`Scripts/01.txt` .. `16.txt` on the card (scenes/ in this repo holds the demos). The title is the first line; then `#1` .. `#8`,
`#M`, `#I` each followed by its lines; `#P` with a pattern a line (`0: 48 51 55`). Not a Teletype: there is no CV or TR;
Teletype scenes translate once those become NOTE and CC.
