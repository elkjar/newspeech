// Instrument editor — Phase A slice 1 (volume + tune). App-only. Opened from the
// instrument-details menu (RowPanel) for a voice track. Edits write to the
// global voiceEditsStore and apply everywhere (playback + preview) via
// samplePlayer.pickNativeSample. Preview mirrors the Tracker hardware: a
// fixed-note (C3) button that sustains while held. Later slices add trim/loop/
// filter/granular + Launchpad auto-key-mode + Save-As.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useVoiceEditsStore,
  DEFAULT_AMP_ENV,
  DEFAULT_FILTER_LFO,
  LFO_DIVISIONS,
  lfoDivisionToHz,
  type LoopMode,
  type FilterType,
  type AmpEnvEdit,
  type FilterLfoEdit,
  type LfoShape,
} from '../instruments/voiceEditsStore';
import { useSequencerStore } from '../state/store';
import { voiceLabel } from '../audio/voices';
import { monitorNote, monitorRelease } from '../audio/monitor';
import { setMonitorVoice, getMonitorPlayhead } from '../audio/nativeEngine';
import { Waveform } from './Waveform';
import { EnvelopeGraph } from './EnvelopeGraph';
import { LfoShapePlot } from './LfoShapePlot';
import { Knob } from './Knob';
import type { Track } from '../state/store';

const PLAYHEAD_POLL_MS = 33; // ~30Hz playhead readback while previewing

const PREVIEW_MIDI = 60; // C3 (matches the Tracker preview note + our sample naming)

interface Props {
  open: boolean;
  track: Track;
  onClose: () => void;
}

export function InstrumentEditorDialog({ open, track, onClose }: Props) {
  const voiceId = track.source.kind === 'voice' ? track.source.id : null;
  const edit = useVoiceEditsStore((s) => (voiceId ? s.voiceEdits[voiceId] : undefined));
  const setVoiceEdit = useVoiceEditsStore((s) => s.setVoiceEdit);
  const resetVoiceEdit = useVoiceEditsStore((s) => s.resetVoiceEdit);
  const previewId = useRef(0);
  const pollRef = useRef<number | null>(null);
  const [playhead, setPlayhead] = useState<number | null>(null);
  // Live transport tempo for the LFO division → Hz hint. Must be read here
  // (with the other hooks) — never after the early return below.
  const bpm = useSequencerStore((s) => s.bpm);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Stop any in-flight preview + playhead poll when the dialog closes or
  // unmounts, so a held note doesn't keep monitoring after exit.
  useEffect(() => {
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
      void setMonitorVoice(0);
    };
  }, []);
  useEffect(() => {
    if (!open && pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
      setPlayhead(null);
      void setMonitorVoice(0);
    }
  }, [open]);

  if (!open || !voiceId) return null;

  const gain = edit?.gain ?? 1;
  const tune = edit?.tune ?? 0;
  const start = edit?.start ?? 0;
  const end = edit?.end ?? 1;
  const loopMode = edit?.loopMode ?? 'off';
  const filterType = edit?.filterType ?? 'off';
  const cutoff = edit?.cutoff ?? 1;
  const resonance = edit?.resonance ?? 0;
  const ampEnv = edit?.ampEnv;
  const envOn = ampEnv?.on ?? false;
  const setEnv = (patch: Partial<AmpEnvEdit>) =>
    setVoiceEdit(voiceId, { ampEnv: { ...(ampEnv ?? DEFAULT_AMP_ENV), ...patch } });
  const filterLfo = edit?.filterLfo;
  const lfoOn = filterLfo?.on ?? false;
  const lfo = filterLfo ?? DEFAULT_FILTER_LFO;
  const setLfo = (patch: Partial<FilterLfoEdit>) =>
    setVoiceEdit(voiceId, { filterLfo: { ...(filterLfo ?? DEFAULT_FILTER_LFO), ...patch } });

  const startPreview = () => {
    const id = ++previewId.current;
    monitorNote(track, PREVIEW_MIDI, 0.85, id);
    void setMonitorVoice(id);
    if (pollRef.current != null) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(() => {
      void getMonitorPlayhead().then((p) => setPlayhead(p >= 0 ? p : null));
    }, PLAYHEAD_POLL_MS);
  };
  const stopPreview = () => {
    if (previewId.current) monitorRelease(track, previewId.current);
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
    setPlayhead(null);
    void setMonitorVoice(0);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[6px]"
      onMouseDown={onClose}
    >
      <div
        className="bg-[#0a0a0a] border border-white/15 text-white/90 w-[520px] p-5"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-[12px] uppercase tracking-widest text-white/90">
            edit instrument
          </h2>
          <span className="text-[11px] uppercase tracking-widest text-white/40 truncate ml-3">
            {voiceLabel(voiceId)}
          </span>
        </div>

        <Waveform
          voiceId={voiceId}
          start={start}
          end={end}
          loopMode={loopMode}
          playhead={playhead}
          onChange={(patch) => setVoiceEdit(voiceId, patch)}
        />

        <KnobField
          label="volume"
          value={gain / 2}
          display={`×${gain.toFixed(2)}`}
          onChange={(v) => setVoiceEdit(voiceId, { gain: v * 2 })}
        />
        <SliderField
          label="tune"
          value={tune}
          min={-24}
          max={24}
          step={1}
          display={`${tune > 0 ? '+' : ''}${tune} st`}
          onChange={(v) => setVoiceEdit(voiceId, { tune: Math.round(v) })}
        />
        <div className="flex items-center gap-3 mb-3">
          <span className="text-[10px] uppercase tracking-widest text-white/50 w-14">
            loop
          </span>
          <div className="flex-1 flex gap-1">
            {(['off', 'fwd', 'bwd', 'pingpong'] as LoopMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setVoiceEdit(voiceId, { loopMode: m })}
                className={`flex-1 py-1 text-[9px] uppercase tracking-widest border transition-colors ${
                  loopMode === m
                    ? 'border-white text-white'
                    : 'border-white/15 text-white/40 hover:text-white/70'
                }`}
              >
                {m === 'pingpong' ? 'ping' : m}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-3 mb-3">
          <span className="text-[10px] uppercase tracking-widest text-white/50 w-14">
            filter
          </span>
          <div className="flex-1 flex gap-1">
            {(['off', 'lp', 'hp', 'bp'] as FilterType[]).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setVoiceEdit(voiceId, { filterType: f })}
                className={`flex-1 py-1 text-[9px] uppercase tracking-widest border transition-colors ${
                  filterType === f
                    ? 'border-white text-white'
                    : 'border-white/15 text-white/40 hover:text-white/70'
                }`}
              >
                {f}
              </button>
            ))}
          </div>
        </div>
        {filterType !== 'off' && (
          <>
            <KnobField
              label="cutoff"
              value={cutoff}
              display={`${(cutoff * 100).toFixed(0)}%`}
              onChange={(v) => setVoiceEdit(voiceId, { cutoff: v })}
            />
            <KnobField
              label="reso"
              value={resonance}
              display={`${(resonance * 100).toFixed(0)}%`}
              onChange={(v) => setVoiceEdit(voiceId, { resonance: v })}
            />
            <div className="flex items-center gap-3 mb-3">
              <span className="text-[10px] uppercase tracking-widest text-white/50 w-14">
                cutoff lfo
              </span>
              <button
                type="button"
                onClick={() => setLfo({ on: !lfoOn })}
                className={`text-[10px] uppercase tracking-widest transition-colors ${
                  lfoOn ? 'text-white' : 'text-white/40 hover:text-white/70'
                }`}
                title="modulate the cutoff with a free-running LFO"
              >
                {lfoOn ? '● on' : '○ off'}
              </button>
            </div>
            {lfoOn && (
              <>
                {/* shape + speed option stacks on the left, visualizer on the
                    right at matching height (items-stretch). */}
                <div className="flex items-stretch gap-2 mb-1">
                  <div className="flex gap-1">
                    <div className="flex flex-col gap-1">
                      {(['revsaw', 'saw', 'tri', 'square', 'random'] as LfoShape[]).map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => setLfo({ shape: s })}
                          className={`w-12 flex-1 px-1 py-1 text-[9px] uppercase tracking-widest border transition-colors ${
                            lfo.shape === s
                              ? 'border-white text-white'
                              : 'border-white/15 text-white/40 hover:text-white/70'
                          }`}
                        >
                          {s === 'revsaw' ? 'rsaw' : s === 'square' ? 'sqr' : s === 'random' ? 'rnd' : s}
                        </button>
                      ))}
                    </div>
                    <div className="flex flex-col gap-1">
                      {LFO_DIVISIONS.map((d) => (
                        <button
                          key={d}
                          type="button"
                          onClick={() => setLfo({ division: d })}
                          className={`w-12 flex-1 px-1 py-1 text-[9px] tabular-nums tracking-widest border transition-colors ${
                            lfo.division === d
                              ? 'border-white text-white'
                              : 'border-white/15 text-white/40 hover:text-white/70'
                          }`}
                        >
                          {d}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <LfoShapePlot
                      shape={lfo.shape}
                      rateHz={lfoDivisionToHz(lfo.division, bpm)}
                      depth={lfo.depth}
                    />
                  </div>
                </div>
                <div className="flex justify-end text-[9px] tabular-nums text-white/40 mb-2 pr-1">
                  {lfo.division} · ≈{lfoDivisionToHz(lfo.division, bpm).toFixed(1)} Hz
                </div>
                <KnobField
                  label="depth"
                  value={lfo.depth}
                  display={`${(lfo.depth * 100).toFixed(0)}%`}
                  onChange={(v) => setLfo({ depth: v })}
                />
              </>
            )}
          </>
        )}

        <div className="flex items-center gap-3 mb-3">
          <span className="text-[10px] uppercase tracking-widest text-white/50 w-14">amp env</span>
          <button
            type="button"
            onClick={() => setEnv({ on: !envOn })}
            className={`text-[10px] uppercase tracking-widest transition-colors ${
              envOn ? 'text-white' : 'text-white/40 hover:text-white/70'
            }`}
            title="per-instrument amplitude envelope — overrides the manifest envelope"
          >
            {envOn ? '● on' : '○ off'}
          </button>
        </div>
        {envOn &&
          (() => {
            const e = ampEnv ?? DEFAULT_AMP_ENV;
            const ms = (s: number) => `${Math.round(s * 1000)}`;
            return (
              <>
                <EnvelopeGraph env={e} onChange={(patch) => setEnv(patch)} />
                <div className="flex justify-between text-[9px] uppercase tracking-widest text-white/40 tabular-nums mb-3 px-1">
                  <span>atk {ms(e.attack)}</span>
                  <span>dcy {ms(e.decay)}</span>
                  <span>sus {(e.sustain * 100).toFixed(0)}%</span>
                  <span>rel {ms(e.release)}</span>
                </div>
              </>
            );
          })()}

        <div className="flex items-center justify-between mt-5">
          <button
            type="button"
            onPointerDown={startPreview}
            onPointerUp={stopPreview}
            onPointerLeave={stopPreview}
            className="px-4 py-2 border border-white/30 hover:border-white text-[10px] uppercase tracking-widest text-white/80 hover:text-white transition-colors select-none"
            title="hold to preview at C3 (releases on release)"
          >
            ▶ preview · C3
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => resetVoiceEdit(voiceId)}
              className="px-3 py-2 text-[10px] uppercase tracking-widest text-white/40 hover:text-white transition-colors"
              title="clear edits — back to the manifest defaults"
            >
              reset
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-white/15 hover:border-white text-[10px] uppercase tracking-widest text-white/60 hover:text-white transition-colors"
            >
              close
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Normalized (0..1) knob with a left label + right value readout, matching the
// row rhythm of SliderField. The caller maps any range onto 0..1 (e.g. volume
// passes gain/2). Wheel + vertical drag both adjust.
function KnobField({
  label,
  value,
  display,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-3 mb-3">
      <span className="text-[10px] uppercase tracking-widest text-white/50 w-14">{label}</span>
      <div className="flex-1">
        <Knob value={value} displayValue={value} onChange={onChange} size={34} title={label} />
      </div>
      <span className="text-[11px] tabular-nums text-white/70 w-16 text-right">{display}</span>
    </div>
  );
}

function SliderField({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-3 mb-3">
      <span className="text-[10px] uppercase tracking-widest text-white/50 w-14">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-white"
      />
      <span className="text-[11px] tabular-nums text-white/70 w-16 text-right">{display}</span>
    </label>
  );
}
