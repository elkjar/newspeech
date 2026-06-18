// Instrument editor — Phase A slice 1 (volume + tune). App-only. Opened from the
// instrument-details menu (RowPanel) for a voice track. Edits write to the
// global voiceEditsStore and apply everywhere (playback + preview) via
// samplePlayer.pickNativeSample. Preview mirrors the Tracker hardware: a
// fixed-note (C3) button that sustains while held. Later slices add trim/loop/
// filter/granular + Launchpad auto-key-mode + Save-As.
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useVoiceEditsStore } from '../instruments/voiceEditsStore';
import { voiceLabel } from '../audio/voices';
import { monitorNote, monitorRelease } from '../audio/monitor';
import type { Track } from '../state/store';

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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open || !voiceId) return null;

  const gain = edit?.gain ?? 1;
  const tune = edit?.tune ?? 0;

  const startPreview = () => {
    const id = ++previewId.current;
    monitorNote(track, PREVIEW_MIDI, 0.85, id);
  };
  const stopPreview = () => {
    if (previewId.current) monitorRelease(track, previewId.current);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-[6px]"
      onMouseDown={onClose}
    >
      <div
        className="bg-[#0a0a0a] border border-white/15 text-white/90 w-[420px] p-5"
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

        <SliderField
          label="volume"
          value={gain}
          min={0}
          max={2}
          step={0.01}
          display={`×${gain.toFixed(2)}`}
          onChange={(v) => setVoiceEdit(voiceId, { gain: v })}
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
