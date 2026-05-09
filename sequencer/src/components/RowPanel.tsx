import { useEffect, useRef, type RefObject } from 'react';
import {
  useSequencerStore,
  STEP_RATES,
  type Track as TrackData,
  type StepRate,
} from '../state/store';
import { useMIDIOutputs } from '../hooks/useMIDIOutputs';
import type { MIDIOutputInfo } from '../audio/midiOut';
import { getInstrument } from '../instruments/library';

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
  const setTrackMidi = useSequencerStore((s) => s.setTrackMidi);
  const fireTrackProgram = useSequencerStore((s) => s.fireTrackProgram);
  const globalDeviceId = useSequencerStore((s) => s.midiOutDeviceId);
  const instrumentId = track.source.kind === 'instrument' ? track.source.id : null;
  const instrument = instrumentId ? getInstrument(instrumentId) : undefined;
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

  const globalDeviceName = outputs.find((o) => o.id === globalDeviceId)?.name ?? null;

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
          <PortField
            value={track.midi.portName}
            outputs={outputs}
            globalDeviceName={globalDeviceName}
            onChange={(v) => setTrackMidi(track.id, { portName: v })}
          />
          <NumField
            label="ch"
            value={track.midi.channel + 1}
            min={1}
            max={16}
            onChange={(v) =>
              setTrackMidi(track.id, { channel: Math.max(0, Math.min(15, v - 1)) })
            }
          />
          {instrument.role !== 'drum' && (
            <>
              <NullableNumField
                label="msb"
                value={track.midi.bankMSB}
                onChange={(v) => setTrackMidi(track.id, { bankMSB: v })}
              />
              <NullableNumField
                label="lsb"
                value={track.midi.bankLSB}
                onChange={(v) => setTrackMidi(track.id, { bankLSB: v })}
              />
              <NullableNumField
                label="pc"
                value={track.midi.program}
                onChange={(v) => setTrackMidi(track.id, { program: v })}
              />
            </>
          )}
          {instrument.role === 'drum' && (
            <NullableNumField
              label="note"
              value={track.midi.note}
              onChange={(v) => setTrackMidi(track.id, { note: v })}
            />
          )}
          {instrument.role !== 'drum' && (
            <button
              type="button"
              onClick={() => fireTrackProgram(track.id)}
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

function PortField({
  value,
  outputs,
  globalDeviceName,
  onChange,
}: {
  value: string | null;
  outputs: MIDIOutputInfo[];
  globalDeviceName: string | null;
  onChange: (next: string | null) => void;
}) {
  const matched = value
    ? outputs.find((o) => o.name.toLowerCase().includes(value.toLowerCase()))
    : undefined;
  const selectValue = matched ? matched.name : (value ?? '');
  const showOffline = value !== null && !matched;
  const globalLabel = globalDeviceName ? `global · ${globalDeviceName}` : 'global (none set)';
  return (
    <label className="flex flex-col items-start gap-1">
      <span className="text-[9px] uppercase tracking-widest text-white/40">port</span>
      <select
        value={selectValue}
        onChange={(e) => onChange(e.target.value || null)}
        style={{ height: CELL, width: 200 }}
        className="select-chevron bg-transparent border border-white/15 pl-2 pr-6 text-[12px] focus:outline-none focus:border-white text-white"
        title="midi output port (defaults to global when blank)"
      >
        <option value="" className="bg-[#050505]">
          {globalLabel}
        </option>
        {outputs.map((o) => (
          <option key={o.id} value={o.name} className="bg-[#050505]">
            {o.name}
          </option>
        ))}
        {showOffline && (
          <option value={value!} className="bg-[#050505]">
            {value} (offline)
          </option>
        )}
      </select>
    </label>
  );
}
