import { useEffect, useRef, type RefObject } from 'react';
import { useSequencerStore, type Track as TrackData } from '../state/store';
import { voiceCategory, voiceGMDrumNote } from '../audio/voices';
import { midiToName } from '../audio/scale';

const CELL = 36;

interface RowPanelProps {
  track: TrackData;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement>;
}

export function RowPanel({ track, onClose, triggerRef }: RowPanelProps) {
  const setTrackLength = useSequencerStore((s) => s.setTrackLength);
  const setTrackEuclidean = useSequencerStore((s) => s.setTrackEuclidean);
  const setTrackOutput = useSequencerStore((s) => s.setTrackOutput);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose, triggerRef]);

  const out = track.output;
  const isMidi = out.mode === 'midi';
  const channel = out.mode === 'midi' ? out.channel : 9;
  const note = out.mode === 'midi' ? out.note : null;
  const voiceIsMidi = voiceCategory(track.voice) === 'midi';

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-2 z-20 bg-[#050505] border border-white/15 p-3 flex items-end gap-3"
    >
      <Field
        label="len"
        value={track.length}
        min={1}
        max={64}
        onChange={(v) => setTrackLength(track.id, v)}
      />
      <Field
        label="hits"
        value={track.euclidean.hits}
        min={0}
        max={track.length}
        onChange={(v) => setTrackEuclidean(track.id, { hits: v })}
      />
      <Field
        label="rot"
        value={track.euclidean.rotation}
        min={0}
        max={Math.max(0, track.length - 1)}
        onChange={(v) => setTrackEuclidean(track.id, { rotation: v })}
      />
      {!voiceIsMidi && (
        <>
          <div className="self-stretch w-px bg-white/15 mx-1" />
          <div className="flex flex-col items-stretch gap-1">
            <span className="text-[9px] uppercase tracking-widest text-white/40">out</span>
            <div className="flex">
              <button
                type="button"
                onClick={() => setTrackOutput(track.id, { mode: 'internal' })}
                style={{ height: CELL }}
                className={[
                  'px-2 border text-[10px] uppercase tracking-widest transition-colors',
                  !isMidi ? 'bg-white text-black border-white' : 'border-white/15 text-white/60 hover:border-white',
                ].join(' ')}
                title="play internally (sample / synth)"
              >
                int
              </button>
              <button
                type="button"
                onClick={() =>
                  setTrackOutput(track.id, {
                    mode: 'midi',
                    channel: 9,
                    note: voiceGMDrumNote(track.voice),
                  })
                }
                style={{ height: CELL }}
                className={[
                  'px-2 border text-[10px] uppercase tracking-widest transition-colors -ml-px',
                  isMidi ? 'bg-white text-black border-white' : 'border-white/15 text-white/60 hover:border-white',
                ].join(' ')}
                title="send midi out"
              >
                midi
              </button>
            </div>
          </div>
        </>
      )}
      {voiceIsMidi && <div className="self-stretch w-px bg-white/15 mx-1" />}
      {isMidi && (
        <>
          <Field
            label="ch"
            value={channel + 1}
            min={1}
            max={16}
            onChange={(v) =>
              setTrackOutput(track.id, {
                mode: 'midi',
                channel: Math.max(0, Math.min(15, v - 1)),
                note,
              })
            }
          />
          <Field
            label="note"
            value={note ?? 0}
            min={0}
            max={127}
            onChange={(v) =>
              setTrackOutput(track.id, {
                mode: 'midi',
                channel,
                note: Math.max(0, Math.min(127, v)),
              })
            }
            sub={note !== null ? midiToName(note) : ''}
          />
        </>
      )}
    </div>
  );
}

function Field({
  label,
  value,
  min,
  max,
  onChange,
  sub,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
  sub?: string;
}) {
  return (
    <label className="flex flex-col items-center gap-1">
      <span className="text-[9px] uppercase tracking-widest text-white/40">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: CELL, height: CELL }}
        className="bg-transparent border border-white/15 text-center text-[14px] tabular-nums focus:outline-none focus:border-white"
      />
      {sub !== undefined && (
        <span className="text-[9px] uppercase tracking-widest text-white/30 tabular-nums h-3">{sub}</span>
      )}
    </label>
  );
}
