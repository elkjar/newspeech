import { sampleShape } from '../../../ghost/shape';
import { useStreamState } from '../streamState';
import { Waiting } from './BanksWindow';

// The song's arc: the shape curve with the phase cursor on it and the
// target entropy it implies right now.
export function ShapeWindow() {
  const snap = useStreamState((s) => s.snapshot);
  if (!snap) return <Waiting />;
  const W = 100;
  const H = 50;
  const samples = sampleShape(snap.shape, 0, 1, 64);
  const pts = samples.map((v, i) => `${(i / (samples.length - 1)) * W},${H - 3 - v * (H - 6)}`).join(' ');
  const px = Math.min(1, Math.max(0, snap.phase)) * W;
  const ty = H - 3 - Math.min(1, Math.max(0, (snap.targetEntropy - snap.minE) / Math.max(1e-6, snap.maxE - snap.minE))) * (H - 6);

  return (
    <div className="h-full flex flex-col px-3 py-2 font-mono text-[9px]">
      <div className="flex items-center gap-4 text-[8px] tracking-[0.18em] uppercase text-white/45">
        <span className="text-white">{snap.shape}</span>
        <span>P {snap.phase.toFixed(2)}</span>
        <span>
          {snap.elapsedBars}/{snap.phaseLength} bars
        </span>
        <span className="ml-auto">{snap.ghostEnabled ? 'ghost on' : 'ghost off'}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="flex-1 w-full mt-2">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={W} y1={H - 3 - f * (H - 6)} y2={H - 3 - f * (H - 6)} stroke="rgba(255,255,255,0.08)" strokeWidth={0.3} />
        ))}
        <polyline points={pts} fill="none" stroke="rgba(255,255,255,0.75)" strokeWidth={0.6} vectorEffect="non-scaling-stroke" />
        <line x1={px} x2={px} y1={0} y2={H} stroke="#fff" strokeWidth={0.5} vectorEffect="non-scaling-stroke" />
        <circle cx={px} cy={ty} r={1.2} fill="#fff" />
      </svg>
      <div className="flex gap-4 text-white/60 tabular-nums mt-1">
        <span>
          density <span className="text-white">{snap.density.toFixed(2)}</span>
        </span>
        <span>
          target <span className="text-white">{snap.targetEntropy.toFixed(2)}</span>
        </span>
      </div>
    </div>
  );
}
