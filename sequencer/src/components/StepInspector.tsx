import { useEffect, useState } from 'react';
import { useSequencerStore, type Track, type Step } from '../state/store';
import { midiToName, quantize, octaveDegrees } from '../audio/scale';
import { sourceIsMelodic, sourceLabel } from '../instruments/library';
import { voiceSlices } from '../instruments/voiceEditsStore';
import {
  peekStepAccRung,
  type AccumulatorCfg,
  type AccumulatorShape,
} from '../audio/accumulator';
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

// Per-step accumulator authoring. Curated step set (degrees per rung); range
// 1..8; shape wrap/bounce/hold. Defaults applied when a step gains a plock.
const ACC_STEPS = [-2, -1, 1, 2, 3, 4, 5, 7];
const ACC_RANGES = [1, 2, 3, 4, 5, 6, 7, 8];
const ACC_SHAPES: AccumulatorShape[] = ['wrap', 'bounce', 'hold'];
const ACC_SHAPE_LABELS: Record<AccumulatorShape, string> = {
  wrap: 'wrap',
  bounce: 'bnce',
  hold: 'hold',
};
const ACC_DEFAULT: AccumulatorCfg = { step: 1, range: 4, shape: 'wrap' };
const signed = (n: number) => (n > 0 ? `+${n}` : `${n}`);

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
  const rootNote = useSequencerStore((s) => s.rootNote);
  const scale = useSequencerStore((s) => s.scale);
  const setStepChordVoicing = useSequencerStore((s) => s.setStepChordVoicing);
  const setStepAccumulator = useSequencerStore((s) => s.setStepAccumulator);
  const setStepPitch = useSequencerStore((s) => s.setStepPitch);
  const setStepSliceRandom = useSequencerStore((s) => s.setStepSliceRandom);

  // tieAnchor (the white square in the grid) acts as a click-pin: once set,
  // the inspector locks to that step so hover/mouse-leave can't yank it away
  // while the user reaches for the chord-voicing dropdowns. Hover-driven
  // `selectedStep` is the fallback when nothing's pinned.
  const activeSelection = tieAnchor ?? selectedStep;
  const activeTrackId = activeSelection?.trackId ?? null;
  // Narrow selector: pull only the resolved track, not the whole tracks array.
  // Returns the same Track reference unless that specific track changes, so
  // unrelated step toggles / knob twists / mutation rolls on other tracks
  // don't re-render the inspector.
  const track = useSequencerStore((s) =>
    activeTrackId ? (s.tracks.find((t) => t.id === activeTrackId) ?? null) : null,
  );
  // Chord master = first melodic track. ID is a primitive, so selector
  // short-circuits unless track reordering shifts which row is first.
  const chordMasterId = useSequencerStore(
    (s) => s.tracks.find((t) => t.section === 'melodic')?.id ?? null,
  );
  const step =
    track && activeSelection ? displayedStep(track, activeSelection.index) ?? null : null;

  // Slice-mode (break) voice: a per-step chop selector replaces the melodic
  // note editors. sliceCount 0 → not a slice voice, UI stays hidden. slice
  // index is stored in step.pitch (0-based, wrapped); sliceRandom overrides it.
  const sliceCount =
    track && track.source.kind === 'voice' ? voiceSlices(track.source.id).length : 0;
  const sliceVoice = sliceCount > 0;
  const sliceRandom = step?.sliceRandom === true;
  const sliceIdx =
    sliceVoice && step ? ((step.pitch % sliceCount) + sliceCount) % sliceCount : 0;

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
    } else if (sliceVoice) {
      big = sliceRandom ? 'RND' : `SL ${sliceIdx + 1}`;
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
  const isChordMaster = track !== null && chordMasterId === track.id;
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

  // Per-step accumulator — available on any melodic step. S sets degrees-per-
  // rung (and toggles the plock on/off); R/shape are live once plocked.
  const showAcc = track !== null && step !== null && sourceIsMelodic(track.source);
  const accPlocked = !!step?.accumulator;
  const effectiveAcc: AccumulatorCfg = step?.accumulator ?? ACC_DEFAULT;
  const updateAcc = (next: AccumulatorCfg) => {
    if (!track || !activeSelection) return;
    setStepAccumulator(track.id, activeSelection.index, next);
  };
  const clearAcc = () => {
    if (!track || !activeSelection) return;
    setStepAccumulator(track.id, activeSelection.index, undefined);
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
      {sliceVoice && step && track && activeSelection && (
        <div className="flex items-center gap-3 mt-3 pt-2 border-t border-white/10 text-[10px] uppercase tracking-widest">
          <LabeledSelect
            label="slice"
            value={String(sliceIdx)}
            onChange={(v) => setStepPitch(track.id, activeSelection.index, Number(v))}
            plocked={!sliceRandom}
            disabled={sliceRandom}
            title="which chop this step fires (of the voice's slices)"
          >
            {Array.from({ length: sliceCount }, (_, i) => (
              <option key={i} value={i} className="bg-[#050505]">
                {i + 1}
              </option>
            ))}
          </LabeledSelect>
          {/* Modifier toggle — labeled circle, no border (see project convention). */}
          <button
            type="button"
            onClick={() => setStepSliceRandom(track.id, activeSelection.index, !sliceRandom)}
            className={`text-[10px] uppercase tracking-widest transition-colors ${
              sliceRandom ? 'text-white' : 'text-white/45 hover:text-white/80'
            }`}
            title="random — re-roll a fresh slice each time this step fires (overrides the picked slice)"
          >
            {sliceRandom ? '● random' : '○ random'}
          </button>
        </div>
      )}
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
      {showAcc && (
        <div className="mt-3 pt-2 border-t border-white/10">
          <div
            className={`text-[10px] uppercase tracking-widest mb-1.5 ${
              accPlocked ? 'text-white' : 'text-white/40'
            }`}
          >
            accumulator
          </div>
          <div className="flex items-center gap-2 text-[11px] uppercase tracking-widest">
            <LabeledSelect
              label="S"
              value={accPlocked ? String(effectiveAcc.step) : 'off'}
              onChange={(v) =>
                v === 'off' ? clearAcc() : updateAcc({ ...effectiveAcc, step: Number(v) })
              }
              plocked={accPlocked}
              title="accumulator — degrees per rung each fire (— = off)"
              textSize="text-[11px]"
            >
              <option value="off" className="bg-[#050505]">
                —
              </option>
              {ACC_STEPS.map((n) => (
                <option key={n} value={n} className="bg-[#050505]">
                  {signed(n)}
                </option>
              ))}
            </LabeledSelect>
            <LabeledSelect
              label="R"
              value={String(effectiveAcc.range)}
              onChange={(v) => updateAcc({ ...effectiveAcc, range: Number(v) })}
              plocked={accPlocked}
              title="range — rungs before it turns / resets (setting it turns the accumulator on)"
              textSize="text-[11px]"
            >
              {ACC_RANGES.map((n) => (
                <option key={n} value={n} className="bg-[#050505]">
                  {n}
                </option>
              ))}
            </LabeledSelect>
            <LabeledSelect
              label="⟳"
              value={effectiveAcc.shape}
              onChange={(v) => updateAcc({ ...effectiveAcc, shape: v as AccumulatorShape })}
              plocked={accPlocked}
              title="shape — wrap (saw) / bounce (triangle) / hold (climb + stay) (setting it turns the accumulator on)"
              textSize="text-[11px]"
            >
              {ACC_SHAPES.map((s) => (
                <option key={s} value={s} className="bg-[#050505]">
                  {ACC_SHAPE_LABELS[s]}
                </option>
              ))}
            </LabeledSelect>
            {accPlocked && (
              <button
                type="button"
                onClick={clearAcc}
                className="ml-auto text-white/40 hover:text-white text-[11px] uppercase tracking-widest"
                title="clear per-step accumulator"
              >
                ×
              </button>
            )}
          </div>
          {accPlocked && track && activeSelection && (
            <AccLadder
              trackId={track.id}
              index={activeSelection.index}
              cfg={effectiveAcc}
            />
          )}
        </div>
      )}
    </div>
  );
}

// Live ladder visualization for the selected step's accumulator: one cell per
// rung, labeled with its degree offset, current rung filled. The traversal
// makes the shape legible in motion — wrap saws home, bounce walks back and
// forth, hold climbs and parks. Polls the ephemeral counter (not in the store)
// via RAF while playing; static otherwise. Isolated so the RAF ticks don't
// re-render the inspector.
function AccLadder({
  trackId,
  index,
  cfg,
}: {
  trackId: string;
  index: number;
  cfg: AccumulatorCfg;
}) {
  const playing = useSequencerStore((s) => s.playing);
  const [rung, setRung] = useState(0);
  useEffect(() => {
    if (!playing) {
      setRung(peekStepAccRung(trackId, index, cfg));
      return;
    }
    let raf = 0;
    let stopped = false;
    const tick = () => {
      setRung(peekStepAccRung(trackId, index, cfg));
      if (!stopped) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
    };
  }, [playing, trackId, index, cfg.range, cfg.shape, cfg.step]);
  return (
    <div className="flex gap-1 mt-2" title="accumulator ladder — current rung · degree offset per rung">
      {Array.from({ length: cfg.range }, (_, r) => (
        <span
          key={r}
          className={`flex-1 h-7 flex items-center justify-center border text-[11px] tabular-nums tracking-wider transition-colors ${
            r === rung
              ? 'bg-white text-black border-white'
              : 'border-white/15 text-white/45'
          }`}
        >
          {signed(cfg.step * r)}
        </span>
      ))}
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
  textSize = 'text-[10px]',
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  children: React.ReactNode;
  plocked: boolean;
  disabled?: boolean;
  title?: string;
  textSize?: string;
}) {
  return (
    <label className="flex items-center gap-1" title={title}>
      <span className="text-white/40">{label}:</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={`bg-transparent border border-white/15 px-1 ${textSize} focus:outline-none focus:border-white disabled:opacity-30 ${
          plocked ? 'text-white' : 'text-white/55'
        }`}
      >
        {children}
      </select>
    </label>
  );
}
