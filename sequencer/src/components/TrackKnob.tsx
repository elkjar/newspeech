import { Knob } from './Knob';
import { findRouted, type LFODestKnobTrack } from '../audio/lfo';
import { useLFOValue } from '../hooks/useLFOValue';
import { useSequencerStore, type Track as TrackData } from '../state/store';

const LABELS: Record<LFODestKnobTrack, string> = {
  mutation: 'mutation',
  rowChance: 'row chance',
  rowRatchet: 'row ratchet',
  morph: 'morph',
};

function readKnob(track: TrackData, knob: LFODestKnobTrack): number {
  switch (knob) {
    case 'mutation':
      return track.mutation;
    case 'rowChance':
      return track.rowChance;
    case 'rowRatchet':
      return track.rowRatchet;
    case 'morph':
      return track.morph;
  }
}

function writeKnob(trackId: string, knob: LFODestKnobTrack, value: number): void {
  const s = useSequencerStore.getState();
  switch (knob) {
    case 'mutation':
      s.setTrackMutation(trackId, value);
      return;
    case 'rowChance':
      s.setTrackRowChance(trackId, value);
      return;
    case 'rowRatchet':
      s.setTrackRowRatchet(trackId, value);
      return;
    case 'morph':
      s.setTrackMorph(trackId, value);
      return;
  }
}

export function TrackKnob({
  track,
  knob,
  size,
}: {
  track: TrackData;
  knob: LFODestKnobTrack;
  size: number;
}) {
  const lfos = useSequencerStore((s) => s.lfos);
  const selectingLFO = useSequencerStore((s) => s.selectingLFO);
  const toggleLFODestination = useSequencerStore((s) => s.toggleLFODestination);

  const value = readKnob(track, knob);
  const routed = findRouted(lfos, track.id, knob);
  const displayValue = useLFOValue(value, routed, 1);
  const label = LABELS[knob];

  const onModulationClick =
    selectingLFO !== null
      ? () => {
          toggleLFODestination(selectingLFO, { trackId: track.id, knob });
        }
      : undefined;

  const labels = routed.map((l) => `L${l.id + 1}`).join(',');

  return (
    <Knob
      value={value}
      displayValue={displayValue}
      onChange={(v) => writeKnob(track.id, knob, v)}
      title={
        routed.length > 0
          ? `${label} ${Math.round(value * 100)}% · ${labels}`
          : `${label} ${Math.round(value * 100)}%`
      }
      size={size}
      onModulationClick={onModulationClick}
      modulationLabel={routed.length > 0 ? labels : undefined}
    />
  );
}
