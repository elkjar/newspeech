import { useEffect, useRef } from 'react';
import { useSequencerStore } from '../state/store';
import { getAudioContext } from '../audio/audioContext';
import { Knob } from './Knob';
import { sourceLabel, type TrackSource } from '../instruments/library';
import { GLOBAL_TRACK_ID, type LFO, type LFODestKnob } from '../audio/lfo';

const CELL_W = 120;
const CELL_H = 96;
const PHASE_R = 18;

const KNOB_LABELS: Record<LFODestKnob, string> = {
  mutation: 'mut',
  morph: 'morph',
  rowRatchet: 'ratchet',
  fxSend: 'fx send',
  density: 'density',
  motion: 'motion',
  drift: 'drift',
  chaos: 'chaos',
  tension: 'tension',
  tapePosition: 'tape pos',
  tapeLength: 'tape len',
  tapeMix: 'tape mix',
  tapeGrainRate: 'grain rate',
  tapeGrainMix: 'grain mix',
  glitchChance: 'glitch ch',
  glitchMix: 'glitch mix',
  reverbSize: 'verb size',
  reverbMix: 'verb mix',
  preSaturationDrive: 'pre drive',
  postSaturationDrive: 'post drive',
};

function destinationLabel(
  lfo: LFO,
  sourceFor: (trackId: string) => TrackSource | undefined
): string {
  if (lfo.destinations.length === 0) return '—';
  const first = lfo.destinations[0];
  const head =
    first.trackId === GLOBAL_TRACK_ID
      ? KNOB_LABELS[first.knob]
      : (() => {
          const src = sourceFor(first.trackId);
          return src
            ? `${sourceLabel(src)} · ${KNOB_LABELS[first.knob]}`
            : KNOB_LABELS[first.knob];
        })();
  return lfo.destinations.length > 1
    ? `${head} +${lfo.destinations.length - 1}`
    : head;
}

function LFOCell({
  lfo,
  selected,
  onSelect,
  onDepth,
  destLabel,
}: {
  lfo: LFO;
  selected: boolean;
  onSelect: () => void;
  onDepth: (v: number) => void;
  destLabel: string;
}) {
  const indicatorRef = useRef<SVGCircleElement>(null);

  useEffect(() => {
    let raf = 0;
    const ctx = getAudioContext();
    const tick = () => {
      const phase = 2 * Math.PI * lfo.rate * ctx.currentTime;
      const dx = Math.cos(phase) * (PHASE_R - 3);
      const dy = Math.sin(phase) * (PHASE_R - 3);
      const el = indicatorRef.current;
      if (el) {
        el.setAttribute('cx', String(PHASE_R + dx));
        el.setAttribute('cy', String(PHASE_R + dy));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [lfo.rate]);

  return (
    <div
      onClick={onSelect}
      style={{ width: CELL_W, height: CELL_H }}
      className={[
        'relative flex flex-col items-center justify-center gap-1 cursor-pointer transition-colors',
        selected ? 'bg-white/10 border border-white/40' : 'border border-white/10 hover:border-white/30',
      ].join(' ')}
    >
      <svg
        width={PHASE_R * 2}
        height={PHASE_R * 2}
        viewBox={`0 0 ${PHASE_R * 2} ${PHASE_R * 2}`}
      >
        <circle
          cx={PHASE_R}
          cy={PHASE_R}
          r={PHASE_R - 1}
          fill="none"
          stroke="white"
          strokeOpacity="0.12"
          strokeWidth="1"
        />
        <circle ref={indicatorRef} cx={PHASE_R} cy={PHASE_R} r="1.6" fill="white" fillOpacity="0.85" />
      </svg>
      <div onClick={(e) => e.stopPropagation()}>
        <Knob
          value={lfo.depth}
          onChange={onDepth}
          size={28}
          title={`L${lfo.id + 1} depth ${Math.round(lfo.depth * 100)}%`}
        />
      </div>
      <span className="text-[9px] uppercase tracking-widest text-white/55 truncate max-w-full px-2">
        L{lfo.id + 1} · {destLabel}
      </span>
    </div>
  );
}

export function LFOPanel() {
  const lfos = useSequencerStore((s) => s.lfos);
  const tracks = useSequencerStore((s) => s.tracks);
  const selectingLFO = useSequencerStore((s) => s.selectingLFO);
  const setSelectingLFO = useSequencerStore((s) => s.setSelectingLFO);
  const setLFODepth = useSequencerStore((s) => s.setLFODepth);

  const sourceFor = (trackId: string) => tracks.find((t) => t.id === trackId)?.source;

  useEffect(() => {
    if (selectingLFO === null) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectingLFO(null);
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [selectingLFO, setSelectingLFO]);

  return (
    <div className="flex items-stretch gap-2">
      {lfos.map((lfo) => (
        <LFOCell
          key={lfo.id}
          lfo={lfo}
          selected={selectingLFO === lfo.id}
          onSelect={() => setSelectingLFO(selectingLFO === lfo.id ? null : lfo.id)}
          onDepth={(v) => setLFODepth(lfo.id, v)}
          destLabel={destinationLabel(lfo, sourceFor)}
        />
      ))}
    </div>
  );
}
