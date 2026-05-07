import { useSequencerStore } from '../state/store';
import { midiToName, quantize } from '../audio/scale';

export function StepInspector() {
  const selectedStep = useSequencerStore((s) => s.selectedStep);
  const tracks = useSequencerStore((s) => s.tracks);
  const rootNote = useSequencerStore((s) => s.rootNote);
  const scale = useSequencerStore((s) => s.scale);

  if (!selectedStep) {
    return (
      <div className="border border-white/20 px-5 py-3 text-[11px] uppercase tracking-widest min-h-[44px] min-w-[600px] flex items-center justify-center text-white/40">
        click a step to inspect
      </div>
    );
  }

  const track = tracks.find((t) => t.id === selectedStep.trackId);
  const step = track?.steps[selectedStep.index];

  if (!track || !step) {
    return (
      <div className="border border-white/20 px-5 py-3 text-[11px] uppercase tracking-widest min-h-[44px] min-w-[600px] flex items-center justify-center text-white/40">
        —
      </div>
    );
  }

  const isMelodic = track.type === 'melodic';
  const noteLabel = isMelodic && step.on ? midiToName(quantize(rootNote, scale, step.pitch)) : '—';

  return (
    <div className="border border-white/20 px-5 py-3 text-[11px] uppercase tracking-widest min-h-[44px] min-w-[600px] flex items-center justify-center gap-x-7 gap-y-2 flex-wrap">
      <span className="text-white">{track.name}</span>
      <Field label="step" value={String(selectedStep.index + 1)} />
      <span className={step.on ? 'text-white' : 'text-white/40'}>{step.on ? 'on' : 'off'}</span>
      <Field label="vel" value={step.velocity.toFixed(2)} />
      <Field label="chance" value={`${step.probability}%`} />
      {isMelodic && <Field label="note" value={noteLabel} />}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-white/40">{label}</span>{' '}
      <span className="text-white tabular-nums">{value}</span>
    </span>
  );
}
