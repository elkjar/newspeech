import { useSequencerStore, type Track, type Step } from '../state/store';
import { midiToName, quantize } from '../audio/scale';
import { sourceIsMelodic, sourceLabel } from '../instruments/library';

const PANEL = 'border border-white/15 px-4 flex items-center gap-4 w-[320px] h-24';

function displayedStep(track: Track, i: number): Step | undefined {
  const len = track.length;
  const self = track.steps[i];
  if (len <= 0) return self;
  let originator: Step | undefined = self;
  let cur = i;
  while (cur > 0) {
    const prev = cur - 1;
    const prevStep = track.steps[prev];
    if (!prevStep?.tieToNext) break;
    cur = prev;
    if (prevStep.on) originator = prevStep;
  }
  return originator;
}

export function StepInspector() {
  const selectedStep = useSequencerStore((s) => s.selectedStep);
  const tracks = useSequencerStore((s) => s.tracks);
  const rootNote = useSequencerStore((s) => s.rootNote);
  const scale = useSequencerStore((s) => s.scale);

  const track = selectedStep
    ? tracks.find((t) => t.id === selectedStep.trackId) ?? null
    : null;
  const step =
    track && selectedStep ? displayedStep(track, selectedStep.index) ?? null : null;

  let big = '—';
  let velStr = '—';
  let probStr = '—';
  let ratchetStr = '—';
  let timingStr = '—';
  let gateStr = '—';
  let dim = true;
  let velActive = false;
  let probActive = false;
  let ratchetActive = false;
  let timingActive = false;
  let gateActive = false;

  if (track && step) {
    big = sourceIsMelodic(track.source)
      ? midiToName(quantize(rootNote, scale, step.pitch))
      : sourceLabel(track.source).toUpperCase();
    velStr = step.velocity.toFixed(2);
    probStr = `${step.probability}%`;
    ratchetStr = `${step.ratchet}`;
    timingStr = `${step.microTiming >= 0 ? '+' : ''}${step.microTiming.toFixed(2)}`;
    gateStr = step.gate.toFixed(2);
    dim = !step.on;
    velActive = step.velocity !== 1;
    probActive = step.probability !== 100;
    ratchetActive = step.ratchet !== 1;
    timingActive = step.microTiming !== 0;
    gateActive = step.gate !== 1;
  }

  return (
    <div className={`${PANEL} ${dim ? 'opacity-50' : ''}`}>
      <span className="text-2xl tracking-wider text-white inline-block min-w-[88px]">{big}</span>
      <div className="flex flex-col gap-0.5 text-[10px] uppercase tracking-widest leading-tight min-w-[180px]">
        <div className="flex gap-3">
          <Field label="v" value={velStr} active={velActive} />
          <Field label="c" value={probStr} active={probActive} />
        </div>
        <div className="flex gap-3">
          <Field label="r" value={ratchetStr} active={ratchetActive} />
          <Field label="t" value={timingStr} active={timingActive} />
          <Field label="g" value={gateStr} active={gateActive} />
        </div>
      </div>
    </div>
  );
}

function Field({ label, value, active }: { label: string; value: string; active: boolean }) {
  return (
    <span>
      <span className="text-white/40">{label}:</span>
      <span className={`tabular-nums ${active ? 'text-white' : 'text-white/55'}`}>{value}</span>
    </span>
  );
}
