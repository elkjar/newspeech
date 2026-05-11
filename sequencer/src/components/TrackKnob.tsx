import { Knob } from './Knob';
import { findRouted, type LFODestKnobTrack } from '../audio/lfo';
import { useLFOValue } from '../hooks/useLFOValue';
import { useSequencerStore, type Track as TrackData } from '../state/store';
import { useMidiLearn } from '../hooks/useMidiLearn';
import type { MidiTarget, TrackKnobTargetName } from '../midi/midiMap';

const LABELS: Record<LFODestKnobTrack, string> = {
  mutation: 'mutation',
  rowRatchet: 'row ratchet',
  morph: 'morph',
  fxSend: 'fx send',
};

function readKnob(track: TrackData, knob: LFODestKnobTrack): number {
  switch (knob) {
    case 'mutation':
      return track.mutation;
    case 'rowRatchet':
      return track.rowRatchet;
    case 'morph':
      return track.morph;
    case 'fxSend':
      return track.fxSend;
  }
}

function writeKnob(trackId: string, knob: LFODestKnobTrack, value: number): void {
  const s = useSequencerStore.getState();
  switch (knob) {
    case 'mutation':
      s.setTrackMutation(trackId, value);
      return;
    case 'rowRatchet':
      s.setTrackRowRatchet(trackId, value);
      return;
    case 'morph':
      s.setTrackMorph(trackId, value);
      return;
    case 'fxSend':
      s.setTrackFxSend(trackId, value);
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
  // Track index for MIDI target naming. Bindings are positional, not by
  // trackId, so they survive across .seq files with the same shape.
  const trackIndex = useSequencerStore((s) =>
    s.tracks.findIndex((t) => t.id === track.id)
  );
  const learnTarget =
    trackIndex >= 0
      ? (`track:${trackIndex}:${knob as TrackKnobTargetName}` as MidiTarget)
      : undefined;
  const learn = useMidiLearn(learnTarget);

  const value = readKnob(track, knob);
  const routed = findRouted(lfos, track.id, knob);
  const displayValue = useLFOValue(value, routed, 1);
  const label = LABELS[knob];

  // Precedence: LFO-selecting mode > MIDI learn mode > normal drag.
  const onModulationClick =
    selectingLFO !== null
      ? () => {
          toggleLFODestination(selectingLFO, { trackId: track.id, knob });
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

  const titleParts: string[] = [`${label} ${Math.round(value * 100)}%`];
  if (routed.length > 0) titleParts.push(lfoLabels);
  if (learn.learning && learn.bound && learn.bindingLabel)
    titleParts.push(learn.bindingLabel);
  if (learn.isLearnTarget) titleParts.push('learning…');

  return (
    <Knob
      value={value}
      displayValue={displayValue}
      onChange={(v) => writeKnob(track.id, knob, v)}
      title={titleParts.join(' · ')}
      size={size}
      onModulationClick={onModulationClick}
      modulationLabel={modulationLabel}
    />
  );
}
