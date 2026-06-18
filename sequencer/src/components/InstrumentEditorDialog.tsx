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
  type LoopMode,
  type FilterType,
} from '../instruments/voiceEditsStore';
import { voiceLabel } from '../audio/voices';
import { monitorNote, monitorRelease } from '../audio/monitor';
import { setMonitorVoice, getMonitorPlayhead } from '../audio/nativeEngine';
import { Waveform } from './Waveform';
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
          </>
        )}

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
