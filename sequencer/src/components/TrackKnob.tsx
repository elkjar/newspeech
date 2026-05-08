import { useEffect, useRef, useState } from 'react';
import { Knob } from './Knob';
import { applyLFO, findRouted, type LFO, type LFODestKnob } from '../audio/lfo';
import { getAudioContext } from '../audio/audioContext';
import { useSequencerStore, type Track as TrackData } from '../state/store';

const LABELS: Record<LFODestKnob, string> = {
  mutation: 'mutation',
  rowChance: 'row chance',
  rowRatchet: 'row ratchet',
  morph: 'morph',
};

function readKnob(track: TrackData, knob: LFODestKnob): number {
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

function writeKnob(trackId: string, knob: LFODestKnob, value: number): void {
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

function useLFOValue(baseValue: number, routed: LFO[]): number {
  const baseRef = useRef(baseValue);
  baseRef.current = baseValue;
  const routedRef = useRef<LFO[]>(routed);
  routedRef.current = routed;

  const [v, setV] = useState(baseValue);

  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const list = routedRef.current;
      const b = baseRef.current;
      let next: number;
      if (list.length === 0) {
        next = b;
      } else {
        const totalDepth = list.reduce((s, l) => s + l.depth, 0);
        if (totalDepth === 0) {
          next = b;
        } else {
          const t = getAudioContext().currentTime;
          let summed = 0;
          for (const l of list) {
            summed += Math.sin(2 * Math.PI * l.rate * t) * l.depth;
          }
          next = applyLFO(b, totalDepth, summed / totalDepth);
        }
      }
      setV(next);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return v;
}

export function TrackKnob({
  track,
  knob,
  size,
}: {
  track: TrackData;
  knob: LFODestKnob;
  size: number;
}) {
  const lfos = useSequencerStore((s) => s.lfos);
  const selectingLFO = useSequencerStore((s) => s.selectingLFO);
  const toggleLFODestination = useSequencerStore((s) => s.toggleLFODestination);

  const value = readKnob(track, knob);
  const routed = findRouted(lfos, track.id, knob);
  const displayValue = useLFOValue(value, routed);
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
