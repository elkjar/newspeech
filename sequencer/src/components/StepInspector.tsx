import { useSequencerStore, type Track, type Step } from '../state/store';
import { midiToName, quantize, octaveDegrees } from '../audio/scale';
import { sourceIsMelodic, sourceLabel } from '../instruments/library';
import {
  CHORD_DEGREES,
  CHORD_EXTENSIONS,
  CHORD_INVERSIONS,
  CHORD_SPREADS,
  DEGREE_LABELS,
  EXTENSION_LABELS,
  SPREAD_LABELS,
  DEFAULT_CHORD_VOICING,
  type ChordDegree,
  type ChordExtension,
  type ChordInversion,
  type ChordSpread,
  type ChordVoicing,
} from '../audio/chords';
import { getChordContext } from '../audio/chordContext';

const PANEL = 'border border-white/15 px-4 py-3 w-[320px] min-h-24 flex flex-col';

// Music-theory names for chord-tone indices, used by chord-mode tracks
// so step.pitch reads as the chord position the user authored rather than
// the misleading note name from `midiToName(quantize(...))`. Indices past
// the current chord's tone count wrap with an octave-shift suffix.
const TONE_NAMES = ['R', '3', '5', '7', '9', '11'];
// Returned as [tone, octaveSuffix] so the inspector can render the tone
// prominently and the octave shift as a subordinate annotation. Suffix is
// empty when octaveShift === 0.
function chordToneLabel(pitchIndex: number, toneCount: number): [string, string] {
  if (toneCount <= 0) return [String(pitchIndex), ''];
  const octaveShift = Math.floor(pitchIndex / toneCount);
  const idx = ((pitchIndex % toneCount) + toneCount) % toneCount;
  const base = TONE_NAMES[idx] ?? `T${idx}`;
  if (octaveShift === 0) return [base, ''];
  return [base, `${octaveShift > 0 ? '+' : '−'}${Math.abs(octaveShift)}`];
}

// Scale-degree label for scale-mode tracks. 1-indexed (musician convention):
// pitch=0 → ["1", ""], pitch=6 → ["7", ""], pitch=7 → ["1", "+1"], pitch=-1 → ["7", "−1"].
function scaleToneLabel(pitchIndex: number, scaleLength: number): [string, string] {
  if (scaleLength <= 0) return [String(pitchIndex), ''];
  const octaveShift = Math.floor(pitchIndex / scaleLength);
  const idx = ((pitchIndex % scaleLength) + scaleLength) % scaleLength;
  const base = String(idx + 1);
  if (octaveShift === 0) return [base, ''];
  return [base, `${octaveShift > 0 ? '+' : '−'}${Math.abs(octaveShift)}`];
}

function displayedStep(track: Track, i: number): Step | undefined {
  const len = track.length;
  const self = track.steps[i];
  if (len <= 0) return self;
  let originator: Step | undefined = self;
  let cur = i;
  while (cur > 0) {
    const prev = cur - 1;
    const prevStep = track.steps[prev];
    if (!prevStep?.tieToNext) break;
    cur = prev;
    if (prevStep.on) originator = prevStep;
  }
  return originator;
}

export function StepInspector() {
  const selectedStep = useSequencerStore((s) => s.selectedStep);
  const tieAnchor = useSequencerStore((s) => s.tieAnchor);
  const tracks = useSequencerStore((s) => s.tracks);
  const rootNote = useSequencerStore((s) => s.rootNote);
  const scale = useSequencerStore((s) => s.scale);
  const setStepChordVoicing = useSequencerStore((s) => s.setStepChordVoicing);

  // tieAnchor (the white square in the grid) acts as a click-pin: once set,
  // the inspector locks to that step so hover/mouse-leave can't yank it away
  // while the user reaches for the chord-voicing dropdowns. Hover-driven
  // `selectedStep` is the fallback when nothing's pinned.
  const activeSelection = tieAnchor ?? selectedStep;
  const track = activeSelection
    ? tracks.find((t) => t.id === activeSelection.trackId) ?? null
    : null;
  const step =
    track && activeSelection ? displayedStep(track, activeSelection.index) ?? null : null;

  let big = '—';
  let bigOctave = '';
  let velStr = '—';
  let probStr = '—';
  let ratchetStr = '—';
  let timingStr = '—';
  let gateStr = '—';
  let dim = true;
  let velActive = false;
  let probActive = false;
  let ratchetActive = false;
  let timingActive = false;
  let gateActive = false;

  if (track && step) {
    if (sourceIsMelodic(track.source)) {
      // The right label for the big text depends on how this track reads
      // step.pitch at dispatch — none of these are pure "note names":
      //   - Chord master with a chord voicing: roman numeral (the chord
      //     master uses its own voicing for chord assembly).
      //   - Follow mode: step.pitch is a chord-tone index, so show the
      //     music-theory tone name (R / 3 / 5 / 7 with octave suffix).
      //   - Drone mode: step.pitch is ignored, always plays chord root.
      //   - Ignore mode (semitones): show the resolved note name.
      const voicing = step.chordVoicing ?? track.defaultChordVoicing;
      if (voicing.degree > 0) {
        big = DEGREE_LABELS[voicing.degree];
      } else if (track.pitchInterp === 'chord-tone') {
        const toneCount = getChordContext().intervals.length;
        [big, bigOctave] = chordToneLabel(step.pitch, toneCount);
      } else if (track.pitchInterp === 'scale-tone') {
        [big, bigOctave] = scaleToneLabel(step.pitch, octaveDegrees(scale));
      } else if (track.pitchInterp === 'root-follow') {
        big = 'R';
      } else {
        big = midiToName(quantize(rootNote, scale, step.pitch));
      }
    } else {
      big = sourceLabel(track.source).toUpperCase();
    }
    velStr = step.velocity.toFixed(2);
    probStr = `${step.probability}%`;
    ratchetStr = `${step.ratchet}`;
    timingStr = `${step.microTiming >= 0 ? '+' : ''}${step.microTiming.toFixed(2)}`;
    gateStr = step.gate.toFixed(2);
    dim = !step.on;
    velActive = step.velocity !== 1;
    probActive = step.probability !== 100;
    ratchetActive = step.ratchet !== 1;
    timingActive = step.microTiming !== 0;
    gateActive = step.gate !== 1;
  }

  // Chord picker is meaningful only where dispatch actually reads
  // `step.chordVoicing`: the chord master (first melodic row, always uses
  // voicing) and `semitones`-mode followers. Other follower modes
  // (chord-tone / root-follow / scale-tone) derive harmony from the chord
  // master's published chord context and ignore the per-step override, so
  // showing the picker there would let users set a degree the dispatch
  // throws away.
  const isChordMaster =
    track !== null && tracks.find((t) => t.section === 'melodic')?.id === track.id;
  const showChord =
    track !== null &&
    step !== null &&
    sourceIsMelodic(track.source) &&
    (isChordMaster || track.pitchInterp === 'semitones');
  const effectiveVoicing: ChordVoicing =
    step?.chordVoicing ?? track?.defaultChordVoicing ?? DEFAULT_CHORD_VOICING;
  const isPlocked = !!step?.chordVoicing;
  const hasChord = effectiveVoicing.degree > 0;

  const updateVoicing = (next: ChordVoicing) => {
    if (!track || !activeSelection) return;
    setStepChordVoicing(track.id, activeSelection.index, next);
  };
  const clearPlock = () => {
    if (!track || !activeSelection) return;
    setStepChordVoicing(track.id, activeSelection.index, undefined);
  };

  return (
    <div className={`${PANEL} ${dim ? 'opacity-50' : ''}`}>
      <div className="flex items-center gap-4">
        <span className="text-2xl tracking-wider text-white inline-block min-w-[88px]">
          {big}
          {bigOctave && (
            <span className="ml-1 text-xs tracking-widest text-white/40 align-top">
              {bigOctave}
            </span>
          )}
        </span>
        <div className="flex flex-col gap-0.5 text-[10px] uppercase tracking-widest leading-tight">
          <div className="flex gap-3">
            <Field label="v" value={velStr} active={velActive} />
            <Field label="c" value={probStr} active={probActive} />
          </div>
          <div className="flex gap-3">
            <Field label="r" value={ratchetStr} active={ratchetActive} />
            <Field label="t" value={timingStr} active={timingActive} />
            <Field label="g" value={gateStr} active={gateActive} />
          </div>
        </div>
      </div>
      {showChord && (
        <div className="flex items-center gap-2 mt-3 pt-2 border-t border-white/10 text-[10px] uppercase tracking-widest">
          <LabeledSelect
            label="C"
            value={String(effectiveVoicing.degree)}
            onChange={(v) =>
              updateVoicing({ ...effectiveVoicing, degree: Number(v) as ChordDegree })
            }
            plocked={isPlocked}
            title="chord — scale degree (— = single note)"
          >
            {CHORD_DEGREES.map((d) => (
              <option key={d} value={d} className="bg-[#050505]">
                {DEGREE_LABELS[d]}
              </option>
            ))}
          </LabeledSelect>
          <LabeledSelect
            label="E"
            value={effectiveVoicing.extension}
            onChange={(v) =>
              updateVoicing({ ...effectiveVoicing, extension: v as ChordExtension })
            }
            plocked={isPlocked}
            disabled={!hasChord}
            title="extension — triad / 7 / 9 / 11 / sus2 / sus4"
          >
            {CHORD_EXTENSIONS.map((e) => (
              <option key={e} value={e} className="bg-[#050505]">
                {EXTENSION_LABELS[e]}
              </option>
            ))}
          </LabeledSelect>
          <LabeledSelect
            label="I"
            value={String(effectiveVoicing.inversion)}
            onChange={(v) =>
              updateVoicing({ ...effectiveVoicing, inversion: Number(v) as ChordInversion })
            }
            plocked={isPlocked}
            disabled={!hasChord}
            title="inversion"
          >
            {CHORD_INVERSIONS.map((i) => (
              <option key={i} value={i} className="bg-[#050505]">
                {i}
              </option>
            ))}
          </LabeledSelect>
          <LabeledSelect
            label="S"
            value={effectiveVoicing.spread}
            onChange={(v) =>
              updateVoicing({ ...effectiveVoicing, spread: v as ChordSpread })
            }
            plocked={isPlocked}
            disabled={!hasChord}
            title="spread — close / open / wide"
          >
            {CHORD_SPREADS.map((s) => (
              <option key={s} value={s} className="bg-[#050505]">
                {SPREAD_LABELS[s]}
              </option>
            ))}
          </LabeledSelect>
          {isPlocked && (
            <button
              type="button"
              onClick={clearPlock}
              className="ml-auto text-white/40 hover:text-white text-[10px] uppercase tracking-widest"
              title="clear per-step plock — revert to track default"
            >
              ×
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function Field({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <span>
      <span className="text-white/40">{label}:</span>
      <span className={`tabular-nums ${active ? 'text-white' : 'text-white/55'}`}>{value}</span>
    </span>
  );
}

function LabeledSelect({
  label,
  value,
  onChange,
  children,
  plocked,
  disabled,
  title,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  plocked: boolean;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className="flex items-center gap-1" title={title}>
      <span className="text-white/40">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`bg-transparent border border-white/15 px-1 text-[10px] focus:outline-none focus:border-white disabled:opacity-30 ${
          plocked ? 'text-white' : 'text-white/55'
        }`}
      >
        {children}
      </select>
    </label>
  );
}
