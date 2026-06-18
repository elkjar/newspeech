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
  DEFAULT_ENV_MOD,
  DEFAULT_LFO_MOD,
  type LoopMode,
  type FilterType,
  type AmpEnvEdit,
  type FilterLfoEdit,
  type VoiceEdit,
} from '../instruments/voiceEditsStore';
import { useSequencerStore } from '../state/store';
import { ModEnvSection, ModLfoSection, ModHeader, type DepthCfg } from './ModSection';

// Depth knob configs per modulation target.
const DEPTH_UNIT: DepthCfg = { min: 0, max: 1, format: (d) => `${(d * 100).toFixed(0)}%` };
const DEPTH_BIPOLAR: DepthCfg = {
  min: -1,
  max: 1,
  format: (d) => `${d > 0 ? '+' : ''}${(d * 100).toFixed(0)}%`,
};
const DEPTH_SEMIS: DepthCfg = {
  min: -24,
  max: 24,
  format: (d) => `${d > 0 ? '+' : ''}${d.toFixed(1)}st`,
};
import { voiceLabel } from '../audio/voices';
import { monitorNote, monitorRelease } from '../audio/monitor';
import { setMonitorVoice, getMonitorPlayhead } from '../audio/nativeEngine';
import { Waveform } from './Waveform';
import { EnvelopeGraph } from './EnvelopeGraph';
import { Knob } from './Knob';
import { exportVoiceToPti } from '../tracker/exportPti';
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
  const previewId = useRef(0);
  const pollRef = useRef<number | null>(null);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [exportState, setExportState] = useState<'idle' | 'working' | 'ok' | 'err'>('idle');
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
  const lfo = filterLfo ?? DEFAULT_FILTER_LFO;
  const setLfo = (patch: Partial<FilterLfoEdit>) =>
    setVoiceEdit(voiceId, { filterLfo: { ...(filterLfo ?? DEFAULT_FILTER_LFO), ...patch } });
  // Generic-mod grid values (defaulted for display) + a shared merge setter.
  const volLfo = edit?.volLfo ?? DEFAULT_LFO_MOD;
  const panEnv = edit?.panEnv ?? DEFAULT_ENV_MOD;
  const panLfo = edit?.panLfo ?? DEFAULT_LFO_MOD;
  const cutoffEnv = edit?.cutoffEnv ?? DEFAULT_ENV_MOD;
  const pitchEnv = edit?.pitchEnv ?? DEFAULT_ENV_MOD;
  const pitchLfo = edit?.pitchLfo ?? DEFAULT_LFO_MOD;
  const setMod = <T,>(key: keyof VoiceEdit, def: T, patch: Partial<T>) =>
    setVoiceEdit(voiceId, {
      [key]: { ...((edit?.[key] as T) ?? def), ...patch },
    } as Partial<VoiceEdit>);
  // The cutoff LFO + cutoff envelope modulate the filter cutoff, so they do
  // nothing while the filter is off — interacting with either switches it on
  // (to LP) so the modulation is actually audible.
  const ensureFilterOn = () => {
    if (filterType === 'off') setVoiceEdit(voiceId, { filterType: 'lp' });
  };

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
  const doExport = async () => {
    if (!voiceId) return;
    setExportState('working');
    try {
      const res = await exportVoiceToPti(voiceId);
      setExportState(res.ok ? 'ok' : 'err');
    } catch {
      setExportState('err');
    }
    window.setTimeout(() => setExportState('idle'), 2000);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[6px]"
      onMouseDown={onClose}
    >
      <div
        className="bg-[#050505] border border-white/15 text-white/90 w-[1180px] max-w-[96vw] max-h-[92vh] overflow-y-auto p-6"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline gap-4 mb-4">
          <h2 className="text-[12px] uppercase tracking-widest text-white/90">
            edit instrument
          </h2>
          <span className="text-[12px] uppercase tracking-widest text-white/40 truncate">
            {voiceLabel(voiceId)}
          </span>
        </div>

        {/* Instrument header — waveform (1st-column width) + basic controls to
            its right; the flex-1 / flex-[3] split aligns with the 4-col grid. */}
        <div className="flex gap-6 items-start mb-1">
        <div className="flex-1 min-w-0">
        <Waveform
          voiceId={voiceId}
          start={start}
          end={end}
          loopMode={loopMode}
          playhead={playhead}
          onChange={(patch) => setVoiceEdit(voiceId, patch)}
        />
        </div>
        <div className="flex-[3] min-w-0">
        <div className="flex items-start gap-8 flex-wrap">
          <TopKnob
            label="volume"
            value={gain / 2}
            display={`×${gain.toFixed(2)}`}
            onChange={(v) => setVoiceEdit(voiceId, { gain: v * 2 })}
          />
          <TopControl label="tune" value={`${tune > 0 ? '+' : ''}${tune} st`}>
            <input
              type="range"
              min={-24}
              max={24}
              step={1}
              value={tune}
              onChange={(e) => setVoiceEdit(voiceId, { tune: Math.round(Number(e.target.value)) })}
              className="w-[120px] accent-white"
            />
          </TopControl>
          <TopControl label="loop">
            <div className="flex gap-1">
              {(['off', 'fwd', 'bwd', 'pingpong'] as LoopMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => setVoiceEdit(voiceId, { loopMode: m })}
                  className={`px-2 py-1 text-[9px] uppercase tracking-widest border transition-colors ${
                    loopMode === m
                      ? 'border-white text-white'
                      : 'border-white/15 text-white/40 hover:text-white/70'
                  }`}
                >
                  {m === 'pingpong' ? 'ping' : m}
                </button>
              ))}
            </div>
          </TopControl>
          <TopControl label="filter">
            <div className="flex gap-1">
              {(['off', 'lp', 'hp', 'bp'] as FilterType[]).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setVoiceEdit(voiceId, { filterType: f })}
                  className={`px-2 py-1 text-[9px] uppercase tracking-widest border transition-colors ${
                    filterType === f
                      ? 'border-white text-white'
                      : 'border-white/15 text-white/40 hover:text-white/70'
                  }`}
                >
                  {f}
                </button>
              ))}
            </div>
          </TopControl>
          <TopKnob
            label="cutoff"
            value={cutoff}
            display={`${(cutoff * 100).toFixed(0)}%`}
            onChange={(v) => setVoiceEdit(voiceId, { cutoff: v })}
          />
          <TopKnob
            label="reso"
            value={resonance}
            display={`${(resonance * 100).toFixed(0)}%`}
            onChange={(v) => setVoiceEdit(voiceId, { resonance: v })}
          />
        </div>
        </div>
        </div>

        {/* Automation grid — VOL / CUTOFF / PAN / PITCH, each LFO + ENV */}
        <div className="flex gap-6 items-start border-t border-white/10 pt-4 mt-4">
          {/* VOL — tremolo LFO + amp (volume) envelope */}
          <div className="flex-1 min-w-0">
            <ModLfoSection
              label="vol lfo"
              value={volLfo}
              depthCfg={DEPTH_UNIT}
              bpm={bpm}
              onChange={(p) => setMod('volLfo', DEFAULT_LFO_MOD, p)}
            />
            <div className="mb-5">
              <ModHeader label="vol env" on={envOn} onToggle={() => setEnv({ on: !envOn })} />
              {(() => {
                const e = ampEnv ?? DEFAULT_AMP_ENV;
                const ms = (s: number) => `${Math.round(s * 1000)}`;
                return (
                  <>
                    <div className={envOn ? '' : 'opacity-50'}>
                      <EnvelopeGraph env={e} onChange={(patch) => setEnv(patch)} />
                    </div>
                    <div className="flex justify-between text-[9px] uppercase tracking-widest text-white/40 tabular-nums px-1">
                      <span>atk {ms(e.attack)}</span>
                      <span>dcy {ms(e.decay)}</span>
                      <span>sus {(e.sustain * 100).toFixed(0)}%</span>
                      <span>rel {ms(e.release)}</span>
                    </div>
                  </>
                );
              })()}
            </div>
          </div>

          {/* CUTOFF */}
          <div className="flex-1 min-w-0">
            <ModLfoSection
              label="cutoff lfo"
              value={lfo}
              depthCfg={DEPTH_UNIT}
              bpm={bpm}
              onChange={(p) => {
                ensureFilterOn();
                setLfo(p);
              }}
            />
            <ModEnvSection
              label="cutoff env"
              value={cutoffEnv}
              depthCfg={DEPTH_BIPOLAR}
              onChange={(p) => {
                ensureFilterOn();
                setMod('cutoffEnv', DEFAULT_ENV_MOD, p);
              }}
            />
          </div>

          {/* PAN */}
          <div className="flex-1 min-w-0">
            <ModLfoSection
              label="pan lfo"
              value={panLfo}
              depthCfg={DEPTH_BIPOLAR}
              bpm={bpm}
              onChange={(p) => setMod('panLfo', DEFAULT_LFO_MOD, p)}
            />
            <ModEnvSection
              label="pan env"
              value={panEnv}
              depthCfg={DEPTH_BIPOLAR}
              onChange={(p) => setMod('panEnv', DEFAULT_ENV_MOD, p)}
            />
          </div>

          {/* PITCH */}
          <div className="flex-1 min-w-0">
            <ModLfoSection
              label="pitch lfo"
              value={pitchLfo}
              depthCfg={DEPTH_SEMIS}
              bpm={bpm}
              onChange={(p) => setMod('pitchLfo', DEFAULT_LFO_MOD, p)}
            />
            <ModEnvSection
              label="pitch env"
              value={pitchEnv}
              depthCfg={DEPTH_SEMIS}
              onChange={(p) => setMod('pitchEnv', DEFAULT_ENV_MOD, p)}
            />
          </div>
        </div>

        <div className="flex items-center justify-between mt-5">
          <div className="flex items-center gap-2">
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
            <button
              type="button"
              onClick={doExport}
              disabled={exportState === 'working'}
              className="px-4 py-2 border border-white/30 hover:border-white text-[10px] uppercase tracking-widest text-white/80 hover:text-white transition-colors select-none"
              title="export this instrument to a Polyend Tracker .pti file"
            >
              {exportState === 'working'
                ? '… .pti'
                : exportState === 'ok'
                  ? '✓ .pti'
                  : exportState === 'err'
                    ? '✗ .pti'
                    : 'export .pti'}
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border border-white/15 hover:border-white text-[10px] uppercase tracking-widest text-white/60 hover:text-white transition-colors"
          >
            close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Instrument-header control unit — control on top, label + value below (the FX
// panel pattern). Children is any control (knob / slider / segmented group);
// the control area is a fixed-height band so labels align across the row.
function TopControl({
  label,
  value,
  children,
}: {
  label: string;
  value?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1">
      <div className="h-12 flex items-center justify-center">{children}</div>
      <span className="text-[10px] uppercase tracking-[0.14em] text-white/60 whitespace-nowrap">
        {label}
      </span>
      {value && <span className="text-[9px] tabular-nums text-white/40">{value}</span>}
    </div>
  );
}

// FX-style labeled knob (size 44) for the instrument header. Caller maps any
// range onto 0..1.
function TopKnob({
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
    <TopControl label={label} value={display}>
      <Knob value={value} displayValue={value} onChange={onChange} size={44} title={label} />
    </TopControl>
  );
}

