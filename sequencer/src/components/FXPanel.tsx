import { useSequencerStore } from '../state/store';
import { Knob } from './Knob';
import { findRouted, GLOBAL_TRACK_ID, type LFODestKnobGlobal } from '../audio/lfo';
import { useLFOValue } from '../hooks/useLFOValue';
import { useMidiLearn } from '../hooks/useMidiLearn';
import type { MidiTarget } from '../midi/midiMap';

const KNOB_SIZE = 44;

function LabeledKnob({
  label,
  value,
  onChange,
  bipolar = false,
  format,
  lfoKnob,
  midiTarget,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  bipolar?: boolean;
  format?: (v: number) => string;
  // When set, the knob participates in the LFO routing system: clicks during
  // LFO-select toggle a destination assignment, and the visual swings with
  // any routed LFOs. Same pattern as MacroKnob.
  lfoKnob?: LFODestKnobGlobal;
  // When set, the knob is a MIDI learn target.
  midiTarget?: MidiTarget;
}) {
  const display = format ? format(value) : value.toFixed(2);
  // Knob component is unipolar 0..1; for bipolar params we map externally.
  const knobValue = bipolar ? (value + 1) / 2 : value;
  const handleKnobChange = (v: number) => onChange(bipolar ? v * 2 - 1 : v);

  const lfos = useSequencerStore((s) => s.lfos);
  const selectingLFO = useSequencerStore((s) => s.selectingLFO);
  const toggleLFODestination = useSequencerStore((s) => s.toggleLFODestination);
  const learn = useMidiLearn(midiTarget);

  const routed = lfoKnob ? findRouted(lfos, GLOBAL_TRACK_ID, lfoKnob) : [];
  const displayValue = useLFOValue(knobValue, routed, 1);

  // Precedence: LFO-selecting mode > MIDI learn mode > normal drag.
  const onModulationClick =
    lfoKnob && selectingLFO !== null
      ? () => {
          toggleLFODestination(selectingLFO, { trackId: GLOBAL_TRACK_ID, knob: lfoKnob });
        }
      : learn.onLearnClick;

  const lfoLabels = routed.map((l) => `L${l.id + 1}`).join(',');
  const modulationLabel =
    selectingLFO !== null
      ? lfoLabels || undefined
      : learn.learning
        ? learn.isLearnTarget
          ? '?'
          : learn.bound
            ? learn.bindingLabel
            : undefined
        : routed.length > 0
          ? lfoLabels
          : undefined;

  const titleParts: string[] = [label];
  if (routed.length > 0) titleParts.push(lfoLabels);
  if (learn.learning && learn.bound && learn.bindingLabel)
    titleParts.push(learn.bindingLabel);
  if (learn.isLearnTarget) titleParts.push('learning…');

  return (
    <div className="flex flex-col items-center gap-1">
      <Knob
        size={KNOB_SIZE}
        value={knobValue}
        displayValue={displayValue}
        onChange={handleKnobChange}
        bipolar={bipolar}
        title={titleParts.join(' · ')}
        onModulationClick={onModulationClick}
        modulationLabel={modulationLabel}
      />
      <span className="text-[10px] uppercase tracking-[0.14em] opacity-70">
        {label}
      </span>
      <span className="text-[10px] tabular-nums opacity-40">{display}</span>
    </div>
  );
}

function ToggleButton({
  label,
  active,
  onToggle,
  midiTarget,
}: {
  label: string;
  active: boolean;
  onToggle: () => void;
  midiTarget?: MidiTarget;
}) {
  const learn = useMidiLearn(midiTarget);
  const handleClick = () => {
    if (learn.onLearnClick) {
      learn.onLearnClick();
      return;
    }
    onToggle();
  };
  const titleSuffix =
    learn.learning && learn.bindingLabel ? ` · ${learn.bindingLabel}` : '';
  return (
    <div className="flex flex-col items-center gap-1">
      <button
        onClick={handleClick}
        aria-pressed={active}
        title={
          learn.isLearnTarget
            ? `${label} — learning…`
            : `${label}${titleSuffix}`
        }
        style={{ width: KNOB_SIZE, height: KNOB_SIZE }}
        className="relative flex items-center justify-center bg-transparent cursor-pointer group"
      >
        <span
          style={{ width: KNOB_SIZE * 0.36, height: KNOB_SIZE * 0.36 }}
          className={[
            'block rounded-full border transition-colors',
            active
              ? 'bg-white border-white'
              : 'border-white/30 group-hover:border-white',
          ].join(' ')}
        />
        {learn.learning && (learn.isLearnTarget || learn.bound) && (
          <span
            className="absolute inset-2 pointer-events-none border border-white/70 rounded"
            style={{
              boxShadow: learn.isLearnTarget ? '0 0 0 1px #fff inset' : undefined,
            }}
          />
        )}
      </button>
      <span className="text-[10px] uppercase tracking-[0.14em] opacity-70">
        {label}
      </span>
      <span className="text-[10px] tabular-nums opacity-40">
        {active ? 'on' : 'off'}
      </span>
    </div>
  );
}

function StageDivider({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center px-2 self-stretch">
      <span className="text-[10px] uppercase tracking-[0.16em] opacity-40 [writing-mode:vertical-rl] rotate-180">
        {label}
      </span>
    </div>
  );
}

export function FXPanel() {
  const tape = useSequencerStore((s) => s.tape);
  const setTape = useSequencerStore((s) => s.setTape);
  const glitch = useSequencerStore((s) => s.glitch);
  const setGlitch = useSequencerStore((s) => s.setGlitch);
  const reverb = useSequencerStore((s) => s.reverb);
  const setReverb = useSequencerStore((s) => s.setReverb);
  const saturation = useSequencerStore((s) => s.saturation);
  const setSaturation = useSequencerStore((s) => s.setSaturation);

  return (
    <div className="flex flex-wrap items-start justify-end gap-5 px-4 py-4">
      <StageDivider label="pre" />
      <LabeledKnob
        label="drive"
        value={saturation.preDrive}
        onChange={(v) => setSaturation({ preDrive: v })}
        lfoKnob="preSaturationDrive"
        midiTarget="fx:saturation.preDrive"
      />
      <StageDivider label="tape" />
      <LabeledKnob
        label="position"
        value={tape.position}
        onChange={(v) => setTape({ position: v })}
        lfoKnob="tapePosition"
        midiTarget="fx:tape.position"
      />
      <LabeledKnob
        label="length"
        value={tape.length}
        onChange={(v) => setTape({ length: v })}
        lfoKnob="tapeLength"
        midiTarget="fx:tape.length"
      />
      <ToggleButton
        label="reverse"
        active={tape.reverse}
        onToggle={() => setTape({ reverse: !tape.reverse })}
      />
      <ToggleButton
        label="hold"
        active={tape.hold}
        onToggle={() => setTape({ hold: !tape.hold })}
        midiTarget="fx:tape.hold"
      />
      <LabeledKnob
        label="grain rate"
        value={tape.grainRate}
        onChange={(v) => setTape({ grainRate: v })}
        lfoKnob="tapeGrainRate"
        midiTarget="fx:tape.grainRate"
      />
      <LabeledKnob
        label="grain mix"
        value={tape.grainMix}
        onChange={(v) => setTape({ grainMix: v })}
        lfoKnob="tapeGrainMix"
        midiTarget="fx:tape.grainMix"
      />
      <LabeledKnob
        label="mix"
        value={tape.mix}
        onChange={(v) => setTape({ mix: v })}
        lfoKnob="tapeMix"
        midiTarget="fx:tape.mix"
      />
      <StageDivider label="glitch" />
      <LabeledKnob
        label="chance"
        value={glitch.chance}
        onChange={(v) => setGlitch({ chance: v })}
        lfoKnob="glitchChance"
        midiTarget="fx:glitch.chance"
      />
      <LabeledKnob
        label="mix"
        value={glitch.mix}
        onChange={(v) => setGlitch({ mix: v })}
        lfoKnob="glitchMix"
        midiTarget="fx:glitch.mix"
      />
      <StageDivider label="reverb" />
      <LabeledKnob
        label="size"
        value={reverb.size}
        onChange={(v) => setReverb({ size: v })}
        lfoKnob="reverbSize"
        midiTarget="fx:reverb.size"
      />
      <LabeledKnob
        label="mix"
        value={reverb.mix}
        onChange={(v) => setReverb({ mix: v })}
        lfoKnob="reverbMix"
        midiTarget="fx:reverb.mix"
      />
      <StageDivider label="post" />
      <LabeledKnob
        label="drive"
        value={saturation.postDrive}
        onChange={(v) => setSaturation({ postDrive: v })}
        lfoKnob="postSaturationDrive"
        midiTarget="fx:saturation.postDrive"
      />
    </div>
  );
}
