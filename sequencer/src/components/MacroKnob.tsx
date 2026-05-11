import { Knob } from './Knob';
import { findRouted, GLOBAL_TRACK_ID, type LFODestKnobGlobal } from '../audio/lfo';
import { useLFOValue } from '../hooks/useLFOValue';
import { useSequencerStore } from '../state/store';
import { useMidiLearn } from '../hooks/useMidiLearn';
import type { MidiTarget } from '../midi/midiMap';

export function MacroKnob({
  knob,
  value,
  onChange,
  size,
  label,
  bipolar = false,
  learnTarget,
}: {
  knob: LFODestKnobGlobal;
  value: number;
  onChange: (v: number) => void;
  size: number;
  label: string;
  bipolar?: boolean;
  learnTarget?: MidiTarget;
}) {
  const lfos = useSequencerStore((s) => s.lfos);
  const selectingLFO = useSequencerStore((s) => s.selectingLFO);
  const toggleLFODestination = useSequencerStore((s) => s.toggleLFODestination);

  const routed = findRouted(lfos, GLOBAL_TRACK_ID, knob);
  // LFOs run at their natural rates now (motion no longer scales them).
  const displayValue = useLFOValue(value, routed, 1);

  const learn = useMidiLearn(learnTarget);

  // Precedence: LFO-selecting mode > MIDI learn mode > normal drag.
  const onModulationClick =
    selectingLFO !== null
      ? () => {
          toggleLFODestination(selectingLFO, { trackId: GLOBAL_TRACK_ID, knob });
        }
      : learn.onLearnClick;

  const lfoLabels = routed.map((l) => `L${l.id + 1}`).join(',');
  // MIDI binding visuals only appear while learn mode is on. Outside learn
  // mode the knob looks the same whether it's bound or not — bindings are
  // an authoring concern, not a runtime concern.
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

  const titleValue = bipolar
    ? (() => {
        const pct = Math.round((value - 0.5) * 200);
        return pct === 0 ? '0' : pct > 0 ? `+${pct}%` : `${pct}%`;
      })()
    : `${Math.round(value * 100)}%`;

  const titleParts: string[] = [`${label} ${titleValue}`];
  if (routed.length > 0) titleParts.push(lfoLabels);
  if (learn.learning && learn.bound && learn.bindingLabel) titleParts.push(learn.bindingLabel);
  if (learn.isLearnTarget) titleParts.push('learning…');

  return (
    <Knob
      value={value}
      displayValue={displayValue}
      onChange={onChange}
      size={size}
      bipolar={bipolar}
      title={titleParts.join(' · ')}
      onModulationClick={onModulationClick}
      modulationLabel={modulationLabel}
    />
  );
}
