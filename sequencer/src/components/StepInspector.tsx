import { useSequencerStore } from '../state/store';
import { midiToName, quantize } from '../audio/scale';

const PANEL = 'border border-white/20 px-4 py-2 flex items-center gap-4';

export function StepInspector() {
  const selectedStep = useSequencerStore((s) => s.selectedStep);
  const tracks = useSequencerStore((s) => s.tracks);
  const rootNote = useSequencerStore((s) => s.rootNote);
  const scale = useSequencerStore((s) => s.scale);

  if (!selectedStep) {
    return (
      <div className={`${PANEL} text-[10px] uppercase tracking-widest text-white/40`}>
        click a step
      </div>
    );
  }

  const track = tracks.find((t) => t.id === selectedStep.trackId);
  const step = track?.steps[selectedStep.index];
  if (!track || !step) {
    return <div className={`${PANEL} text-white/40`}>—</div>;
  }

  const isMelodic = track.type === 'melodic';
  const big = isMelodic
    ? midiToName(quantize(rootNote, scale, step.pitch))
    : track.name.toUpperCase();
  const dim = !step.on;

  return (
    <div className={`${PANEL} ${dim ? 'opacity-50' : ''}`}>
      <span className="text-2xl tracking-wider text-white">{big}</span>
      <div className="flex flex-col gap-0.5 text-[10px] uppercase tracking-widest leading-tight">
        <Field label="v" value={step.velocity.toFixed(2)} />
        <Field label="c" value={`${step.probability}%`} />
      </div>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <span>
      <span className="text-white/40">{label}:</span>
      <span className="text-white tabular-nums">{value}</span>
    </span>
  );
}
