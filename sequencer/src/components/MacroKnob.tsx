import { Knob } from './Knob';
import { findRouted, GLOBAL_TRACK_ID, type LFODestKnobGlobal } from '../audio/lfo';
import { useLFOValue } from '../hooks/useLFOValue';
import { useSequencerStore } from '../state/store';

export function MacroKnob({
  knob,
  value,
  onChange,
  size,
  label,
  bipolar = false,
}: {
  knob: LFODestKnobGlobal;
  value: number;
  onChange: (v: number) => void;
  size: number;
  label: string;
  bipolar?: boolean;
}) {
  const lfos = useSequencerStore((s) => s.lfos);
  const selectingLFO = useSequencerStore((s) => s.selectingLFO);
  const toggleLFODestination = useSequencerStore((s) => s.toggleLFODestination);

  const routed = findRouted(lfos, GLOBAL_TRACK_ID, knob);
  // LFOs run at their natural rates now (motion no longer scales them).
  const displayValue = useLFOValue(value, routed, 1);

  const onModulationClick =
    selectingLFO !== null
      ? () => {
          toggleLFODestination(selectingLFO, { trackId: GLOBAL_TRACK_ID, knob });
        }
      : undefined;

  const labels = routed.map((l) => `L${l.id + 1}`).join(',');

  const titleValue = bipolar
    ? (() => {
        const pct = Math.round((value - 0.5) * 200);
        return pct === 0 ? '0' : pct > 0 ? `+${pct}%` : `${pct}%`;
      })()
    : `${Math.round(value * 100)}%`;

  return (
    <Knob
      value={value}
      displayValue={displayValue}
      onChange={onChange}
      size={size}
      bipolar={bipolar}
      title={
        routed.length > 0
          ? `${label} ${titleValue} · ${labels}`
          : `${label} ${titleValue}`
      }
      onModulationClick={onModulationClick}
      modulationLabel={routed.length > 0 ? labels : undefined}
    />
  );
}
