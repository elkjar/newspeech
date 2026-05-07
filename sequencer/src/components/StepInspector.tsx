import { useSequencerStore } from '../state/store';
import { midiToName, quantize } from '../audio/scale';

const PANEL = 'border border-white/20 px-4 py-2 flex items-center gap-4 w-[220px]';

export function StepInspector() {
  const selectedStep = useSequencerStore((s) => s.selectedStep);
  const tracks = useSequencerStore((s) => s.tracks);
  const rootNote = useSequencerStore((s) => s.rootNote);
  const scale = useSequencerStore((s) => s.scale);

  const track = selectedStep
    ? tracks.find((t) => t.id === selectedStep.trackId) ?? null
    : null;
  const step =
    track && selectedStep ? track.steps[selectedStep.index] ?? null : null;

  let big = '—';
  let velStr = '—';
  let probStr = '—';
  let dim = true;
  if (track && step) {
    big =
      track.type === 'melodic'
        ? midiToName(quantize(rootNote, scale, step.pitch))
        : track.name.toUpperCase();
    velStr = step.velocity.toFixed(2);
    probStr = `${step.probability}%`;
    dim = !step.on;
  }

  return (
    <div className={`${PANEL} ${dim ? 'opacity-50' : ''}`}>
      <span className="text-2xl tracking-wider text-white inline-block min-w-[88px]">{big}</span>
      <div className="flex flex-col gap-0.5 text-[10px] uppercase tracking-widest leading-tight min-w-[60px]">
        <Field label="v" value={velStr} />
        <Field label="c" value={probStr} />
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
