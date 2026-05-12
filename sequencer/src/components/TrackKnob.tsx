import { Knob } from './Knob';
import { findRouted, type LFODestKnobTrack } from '../audio/lfo';
import { useLFOValue } from '../hooks/useLFOValue';
import { useSequencerStore, type Track as TrackData } from '../state/store';
import { useMidiLearn } from '../hooks/useMidiLearn';
import type { MidiTarget, TrackKnobTargetName } from '../midi/midiMap';

const LABELS: Record<LFODestKnobTrack, string> = {
  mutation: 'mutation',
  rowRatchet: 'row ratchet',
  fxSend: 'fx send',
  pan: 'pan',
  gain: 'gain',
  filterCutoff: 'cutoff',
  filterResonance: 'res',
};

// Knobs operate in 0..1 space (LFO pipeline, MIDI dispatch). Gain stores
// 0..2 because unity should be near the center of the dial — we map at the
// read/write boundary so the rest of the system sees the standard range.
function readKnob(track: TrackData, knob: LFODestKnobTrack): number {
  switch (knob) {
    case 'mutation':
      return track.mutation;
    case 'rowRatchet':
      return track.rowRatchet;
    case 'fxSend':
      return track.fxSend;
    case 'pan':
      return track.pan;
    case 'gain':
      return track.gain / 2;
    case 'filterCutoff':
      return track.filterCutoff;
    case 'filterResonance':
      return track.filterResonance;
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
    case 'fxSend':
      s.setTrackFxSend(trackId, value);
      return;
    case 'pan':
      s.setTrackPan(trackId, value);
      return;
    case 'gain':
      s.setTrackGain(trackId, value * 2);
      return;
    case 'filterCutoff':
      s.setTrackFilterCutoff(trackId, value);
      return;
    case 'filterResonance':
      s.setTrackFilterResonance(trackId, value);
      return;
  }
}

// Pan reads as `L45 / C / R45` rather than `50%` — bipolar value space
// is the natural mental model even though we store it as 0..1 internally.
// Gain shows the underlying 0..2 multiplier (`unity` at 1.00) since that's
// the value designers actually think in.
function formatKnobValue(knob: LFODestKnobTrack, value: number): string {
  if (knob === 'pan') {
    const bipolar = Math.round((value - 0.5) * 200);
    if (bipolar === 0) return 'C';
    return bipolar < 0 ? `L${-bipolar}` : `R${bipolar}`;
  }
  if (knob === 'gain') {
    const mul = value * 2;
    if (Math.abs(mul - 1) < 0.005) return 'unity';
    return `${mul.toFixed(2)}x`;
  }
  return `${Math.round(value * 100)}%`;
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

  const titleParts: string[] = [`${label} ${formatKnobValue(knob, value)}`];
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
      bipolar={knob === 'pan' || knob === 'gain'}
    />
  );
}
