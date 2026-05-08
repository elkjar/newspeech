import { useEffect, useRef, type RefObject } from 'react';
import {
  useSequencerStore,
  STEP_RATES,
  type Track as TrackData,
  type StepRate,
} from '../state/store';
import { useMIDIOutputs } from '../hooks/useMIDIOutputs';

const CELL = 36;

interface RowPanelProps {
  track: TrackData;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement>;
}

export function RowPanel({ track, onClose, triggerRef }: RowPanelProps) {
  const setTrackLength = useSequencerStore((s) => s.setTrackLength);
  const setTrackEuclidean = useSequencerStore((s) => s.setTrackEuclidean);
  const setTrackRate = useSequencerStore((s) => s.setTrackRate);
  const setInstrumentField = useSequencerStore((s) => s.setInstrumentField);
  const fireInstrumentProgram = useSequencerStore((s) => s.fireInstrumentProgram);
  const globalDeviceId = useSequencerStore((s) => s.midiOutDeviceId);
  const instrumentId = track.source.kind === 'instrument' ? track.source.id : null;
  const instrument = useSequencerStore((s) =>
    instrumentId ? s.instruments.find((i) => i.id === instrumentId) : undefined
  );
  const outputs = useMIDIOutputs();
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

  const globalDeviceName = outputs.find((o) => o.id === globalDeviceId)?.name ?? 'global';

  return (
    <div
      ref={ref}
      className="absolute top-full left-0 mt-2 z-20 bg-[#050505] border border-white/15 p-3 flex items-end gap-3"
    >
      <NumField
        label="len"
        value={track.length}
        min={1}
        max={64}
        onChange={(v) => setTrackLength(track.id, v)}
      />
      <NumField
        label="hits"
        value={track.euclidean.hits}
        min={0}
        max={track.length}
        onChange={(v) => setTrackEuclidean(track.id, { hits: v })}
      />
      <NumField
        label="rot"
        value={track.euclidean.rotation}
        min={0}
        max={Math.max(0, track.length - 1)}
        onChange={(v) => setTrackEuclidean(track.id, { rotation: v })}
      />
      <label className="flex flex-col items-start gap-1">
        <span className="text-[9px] uppercase tracking-widest text-white/40">rate</span>
        <select
          value={track.rate}
          onChange={(e) => setTrackRate(track.id, e.target.value as StepRate)}
          style={{ height: CELL }}
          className="select-chevron bg-transparent border border-white/15 pl-2 pr-6 text-[12px] tabular-nums focus:outline-none focus:border-white text-white"
          title="step rate (note duration per row step)"
        >
          {STEP_RATES.map((r) => (
            <option key={r} value={r} className="bg-[#050505]">
              {r}
            </option>
          ))}
        </select>
      </label>
      {instrument && (
        <>
          <div className="self-stretch w-px bg-white/15 mx-1" />
          <TextField
            label="port"
            value={instrument.portName ?? ''}
            placeholder={globalDeviceName}
            onChange={(v) => setInstrumentField(instrument.id, { portName: v || null })}
            width={140}
          />
          <NumField
            label="ch"
            value={instrument.channel + 1}
            min={1}
            max={16}
            onChange={(v) =>
              setInstrumentField(instrument.id, {
                channel: Math.max(0, Math.min(15, v - 1)),
              })
            }
          />
          {instrument.role !== 'drum' && (
            <>
              <NullableNumField
                label="msb"
                value={instrument.bankMSB}
                onChange={(v) => setInstrumentField(instrument.id, { bankMSB: v })}
              />
              <NullableNumField
                label="lsb"
                value={instrument.bankLSB}
                onChange={(v) => setInstrumentField(instrument.id, { bankLSB: v })}
              />
              <NullableNumField
                label="pc"
                value={instrument.program}
                onChange={(v) => setInstrumentField(instrument.id, { program: v })}
              />
            </>
          )}
          {instrument.role === 'drum' && instrument.fixedNote !== null && (
            <NumField
              label="note"
              value={instrument.fixedNote}
              min={0}
              max={127}
              onChange={(v) =>
                setInstrumentField(instrument.id, {
                  fixedNote: Math.max(0, Math.min(127, v)),
                })
              }
            />
          )}
          {instrument.role !== 'drum' && (
            <button
              type="button"
              onClick={() => fireInstrumentProgram(instrument.id)}
              style={{ height: CELL }}
              className="px-2 border border-white/15 hover:border-white text-[10px] uppercase tracking-widest text-white/60 hover:text-white transition-colors"
              title="resend bank-select + program change to the instrument"
            >
              send
            </button>
          )}
        </>
      )}
    </div>
  );
}

function NumField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (n: number) => void;
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
    </label>
  );
}

function NullableNumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (n: number | null) => void;
}) {
  return (
    <label className="flex flex-col items-center gap-1">
      <span className="text-[9px] uppercase tracking-widest text-white/40">{label}</span>
      <input
        type="text"
        inputMode="numeric"
        value={value === null ? '' : String(value)}
        placeholder="—"
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === '') {
            onChange(null);
            return;
          }
          const n = Number(raw);
          if (!Number.isFinite(n)) return;
          onChange(Math.max(0, Math.min(127, Math.floor(n))));
        }}
        style={{ width: CELL, height: CELL }}
        className="bg-transparent border border-white/15 text-center text-[14px] tabular-nums focus:outline-none focus:border-white placeholder:text-white/25"
      />
    </label>
  );
}

function TextField({
  label,
  value,
  placeholder,
  onChange,
  width,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (s: string) => void;
  width: number;
}) {
  return (
    <label className="flex flex-col items-start gap-1">
      <span className="text-[9px] uppercase tracking-widest text-white/40">{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        style={{ width, height: CELL }}
        className="bg-transparent border border-white/15 text-[12px] px-2 focus:outline-none focus:border-white placeholder:text-white/25"
      />
    </label>
  );
}
