import { useEffect, useRef, useSyncExternalStore, type RefObject } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import {
  useSequencerStore,
  STEP_RATES,
  DRUM_STEP_RATES,
  PITCH_INTERPS,
  type Track as TrackData,
  type StepRate,
  type PitchInterp,
  type TrackOutput,
} from '../state/store';
import {
  getReportedChannelCount,
  subscribeReportedChannelCount,
} from '../audio/nativeEngine';
import { useMIDIOutputs } from '../hooks/useMIDIOutputs';
import type { MIDIOutputInfo } from '../audio/midiOut';
import { getInstrument, sourceIsMelodic } from '../instruments/library';
import {
  CHORD_DEGREES,
  CHORD_EXTENSIONS,
  CHORD_INVERSIONS,
  CHORD_SPREADS,
  DEGREE_LABELS,
  EXTENSION_LABELS,
  SPREAD_LABELS,
  type ChordDegree,
  type ChordExtension,
  type ChordInversion,
  type ChordSpread,
  type ChordVoicing,
} from '../audio/chords';

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
  const setTrackDefaultChordVoicing = useSequencerStore((s) => s.setTrackDefaultChordVoicing);
  const setTrackPitchInterp = useSequencerStore((s) => s.setTrackPitchInterp);
  const setTrackOctave = useSequencerStore((s) => s.setTrackOctave);
  const setTrackArpOn = useSequencerStore((s) => s.setTrackArpOn);
  const setTrackOutput = useSequencerStore((s) => s.setTrackOutput);
  const fireTrackProgram = useSequencerStore((s) => s.fireTrackProgram);
  const nativeChannels = useSyncExternalStore(
    subscribeReportedChannelCount,
    getReportedChannelCount,
  );
  const globalDeviceId = useSequencerStore((s) => s.midiOutDeviceId);
  const instrumentId = track.source.kind === 'instrument' ? track.source.id : null;
  const instrument = instrumentId ? getInstrument(instrumentId) : undefined;
  const outputs = useMIDIOutputs();
  const isMelodic = sourceIsMelodic(track.source);
  const availableRates = track.section === 'melodic' ? STEP_RATES : DRUM_STEP_RATES;
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
          {availableRates.map((r) => (
            <option key={r} value={r} className="bg-[#050505]">
              {r}
            </option>
          ))}
        </select>
      </label>
      {isMelodic && (
        <>
          <div className="self-stretch w-px bg-white/15 mx-1" />
          <ChordVoicingFields
            voicing={track.defaultChordVoicing}
            onChange={(next) => setTrackDefaultChordVoicing(track.id, next)}
          />
          <PitchInterpField
            value={track.pitchInterp}
            onChange={(v) => setTrackPitchInterp(track.id, v)}
          />
          <NumField
            label="oct"
            value={track.octave}
            min={-4}
            max={4}
            onChange={(v) => setTrackOctave(track.id, v)}
          />
          <button
            onClick={() => setTrackArpOn(track.id, !track.arpConfig?.on)}
            title={
              track.arpConfig?.on
                ? 'arpeggiator on — chord triggers play out as a sequence across the step'
                : 'arpeggiator off — chord triggers play simultaneously'
            }
            className={[
              'px-2 py-1 text-[11px] uppercase tracking-widest transition-colors',
              track.arpConfig?.on
                ? 'text-white'
                : 'text-white/40 hover:text-white',
            ].join(' ')}
          >
            {track.arpConfig?.on ? '●' : '○'} arp
          </button>
        </>
      )}
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
      {isTauri() && track.source.kind === 'voice' && (
        <>
          <div className="self-stretch w-px bg-white/15 mx-1" />
          <label className="flex flex-col items-start gap-1">
            <span className="text-[9px] uppercase tracking-widest text-white/40">out</span>
            <select
              value={`${track.output.stereo ? 's' : 'm'}${track.output.firstChannel}`}
              onChange={(e) => {
                const v = e.target.value;
                const stereo = v.startsWith('s');
                const firstChannel = parseInt(v.slice(1), 10);
                if (!Number.isFinite(firstChannel)) return;
                setTrackOutput(track.id, { firstChannel, stereo });
              }}
              disabled={nativeChannels <= 0}
              style={{ height: CELL }}
              className="select-chevron bg-transparent border border-white/15 pl-2 pr-6 text-[12px] tabular-nums focus:outline-none focus:border-white text-white"
              title={
                nativeChannels > 0
                  ? 'physical output. stereo pair routes L/R with pan; mono sums L+R into one channel (pan ignored).'
                  : 'open the audio device in settings → native audio first'
              }
            >
              {outputOptions(nativeChannels, track.output).map((opt) => (
                <option key={opt.value} value={opt.value} className="bg-[#050505]">
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
    </div>
  );
}

function outputOptions(
  channels: number,
  current: TrackOutput,
): Array<{ value: string; label: string }> {
  const opts: Array<{ value: string; label: string }> = [];
  for (let i = 0; i + 1 < channels; i += 2) {
    opts.push({ value: `s${i}`, label: `${i + 1}-${i + 2}` });
  }
  for (let i = 0; i < channels; i++) {
    opts.push({ value: `m${i}`, label: `${i + 1}` });
  }
  // If the saved assignment is out of range for the active device, keep
  // it in the list so the select can display the real value. Fixing it
  // is a user choice, not a silent rewrite.
  const currentValue = `${current.stereo ? 's' : 'm'}${current.firstChannel}`;
  if (!opts.some((o) => o.value === currentValue)) {
    opts.unshift({
      value: currentValue,
      label: current.stereo
        ? `${current.firstChannel + 1}-${current.firstChannel + 2}`
        : `${current.firstChannel + 1}`,
    });
  }
  return opts;
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

// Per-track default chord voicing — applied by dispatch when a step has no
// chordVoicing plock. Single-letter labels (C / E / I / S) keep the row panel
// horizontally compact since this is a 4-control block. NDLR-style: C is the
// scale degree, E is the extension stacked on the degree, I and S are texture
// controls. Disabled when degree=0 (no chord) — single-note steps don't need
// inversion or spread.
const hasChord = (v: ChordVoicing): boolean => v.degree > 0;

function ChordVoicingFields({
  voicing,
  onChange,
}: {
  voicing: ChordVoicing;
  onChange: (next: ChordVoicing) => void;
}) {
  return (
    <>
      <VoicingSelect
        label="C"
        value={String(voicing.degree)}
        options={CHORD_DEGREES.map(String)}
        format={(v) => DEGREE_LABELS[Number(v) as ChordDegree]}
        onChange={(v) => onChange({ ...voicing, degree: Number(v) as ChordDegree })}
        title="chord — scale degree (— = single note)"
      />
      <VoicingSelect
        label="E"
        value={voicing.extension}
        options={CHORD_EXTENSIONS}
        format={(v) => EXTENSION_LABELS[v as ChordExtension]}
        onChange={(v) => onChange({ ...voicing, extension: v as ChordExtension })}
        disabled={!hasChord(voicing)}
        title="extension — triad / 7 / 9 / 11 / sus2 / sus4"
      />
      <VoicingSelect
        label="I"
        value={String(voicing.inversion)}
        options={CHORD_INVERSIONS.map(String)}
        format={(v) => v}
        onChange={(v) => onChange({ ...voicing, inversion: Number(v) as ChordInversion })}
        disabled={!hasChord(voicing)}
        title="inversion"
      />
      <VoicingSelect
        label="S"
        value={voicing.spread}
        options={CHORD_SPREADS}
        format={(v) => SPREAD_LABELS[v as ChordSpread]}
        onChange={(v) => onChange({ ...voicing, spread: v as ChordSpread })}
        disabled={!hasChord(voicing)}
        title="spread — close / open / wide"
      />
    </>
  );
}

// How `step.pitch` is interpreted on this track. Defaults are position-based
// (chord master = semitones, bass + motifs = chord-tone) but user-overridable.
// Labels describe behavior:
//   ignore = semitones  — track is independent, doesn't follow chord master.
//   chord  = chord-tone — step.pitch is an index into chord master's chord
//                         tones (R, 3, 5, 7, 9, 11). Big leaps, harmony-glued.
//   scale  = scale-tone — step.pitch is a scale-degree offset above the
//                         chord master's current root. Diatonic stepwise walks.
//   drone  = root-follow — always plays chord master's root, pitch ignored.
const INTERP_LABELS: Record<PitchInterp, string> = {
  semitones: 'ignore',
  'chord-tone': 'chord',
  'scale-tone': 'scale',
  'root-follow': 'drone',
};

function PitchInterpField({
  value,
  onChange,
}: {
  value: PitchInterp;
  onChange: (v: PitchInterp) => void;
}) {
  return (
    <label
      className="flex flex-col items-start gap-1"
      title="pitch interp — how step.pitch reads on this track"
    >
      <span className="text-[9px] uppercase tracking-widest text-white/40">interp</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as PitchInterp)}
        style={{ height: CELL }}
        className="select-chevron bg-transparent border border-white/15 pl-2 pr-6 text-[12px] focus:outline-none focus:border-white text-white"
      >
        {PITCH_INTERPS.map((p) => (
          <option key={p} value={p} className="bg-[#050505]">
            {INTERP_LABELS[p]}
          </option>
        ))}
      </select>
    </label>
  );
}

function VoicingSelect({
  label,
  value,
  options,
  format,
  onChange,
  disabled,
  title,
}: {
  label: string;
  value: string;
  options: string[];
  format: (v: string) => string;
  onChange: (v: string) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <label className="flex flex-col items-start gap-1" title={title}>
      <span className="text-[9px] uppercase tracking-widest text-white/40">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        style={{ height: CELL }}
        className="select-chevron bg-transparent border border-white/15 pl-2 pr-6 text-[12px] focus:outline-none focus:border-white text-white disabled:opacity-30"
      >
        {options.map((opt) => (
          <option key={opt} value={opt} className="bg-[#050505]">
            {format(opt)}
          </option>
        ))}
      </select>
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
