import { useStreamState } from '../streamState';

// The current song's 16 bank slots: entropy per slot as bars, the active
// slot lit, the queued one half-lit, the target-entropy line, and Ghost's
// walk drawn across the slots as a path (most recent hops brightest).
export function BanksWindow() {
  const snap = useStreamState((s) => s.snapshot);
  const walk = useStreamState((s) => s.walk);
  if (!snap) return <Waiting />;
  const W = 100;
  const H = 40;
  const n = snap.bankSummary.length || 16;
  const cw = W / n;
  const targetY = H - snap.targetEntropy * (H - 4);
  const pts = walk.slice(-10);

  return (
    <div className="h-full flex flex-col px-3 py-2 font-mono text-[9px]">
      <div className="flex items-center gap-4 text-[8px] tracking-[0.18em] uppercase text-white/45 whitespace-nowrap overflow-hidden shrink-0">
        <span>{snap.bankOrderMode === 'sequence' ? 'sequence' : 'entropy'} walk</span>
        <span>
          E {snap.minE.toFixed(2)}→{snap.maxE.toFixed(2)}
        </span>
        <span>T {snap.targetEntropy.toFixed(2)}</span>
        {snap.transitionCountIn !== null && (
          <span className="ml-auto text-white shrink-0">→ {snap.pendingBank !== null ? snap.pendingBank + 1 : ''} in {snap.transitionCountIn}</span>
        )}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="flex-1 w-full mt-2">
        {snap.bankSummary.map((slot, i) => {
          const filled = slot !== null;
          const e = slot?.entropy ?? 0;
          const h = filled ? Math.max(0.8, e * (H - 4)) : 0.6;
          const active = i === snap.activeBank;
          const pending = i === snap.pendingBank;
          const fill = !filled
            ? 'rgba(255,255,255,0.08)'
            : active
              ? '#fff'
              : pending
                ? 'rgba(255,255,255,0.65)'
                : slot?.kind === 'transition'
                  ? 'rgba(255,255,255,0.3)'
                  : 'rgba(255,255,255,0.5)';
          return <rect key={i} x={i * cw + cw * 0.15} y={H - h} width={cw * 0.7} height={h} fill={fill} />;
        })}
        <line x1={0} x2={W} y1={targetY} y2={targetY} stroke="rgba(255,255,255,0.5)" strokeWidth={0.4} strokeDasharray="1 1" />
        {pts.length > 1 && (
          <polyline
            points={pts
              .map((slot, k) => {
                const y = 6 + (k / Math.max(1, pts.length - 1)) * (H - 14);
                return `${slot * cw + cw / 2},${y}`;
              })
              .join(' ')}
            fill="none"
            stroke="rgba(255,255,255,0.7)"
            strokeWidth={0.5}
            vectorEffect="non-scaling-stroke"
          />
        )}
        {pts.map((slot, k) => {
          const y = 6 + (k / Math.max(1, pts.length - 1)) * (H - 14);
          const a = 0.25 + 0.75 * (k / Math.max(1, pts.length - 1));
          return <circle key={k} cx={slot * cw + cw / 2} cy={y} r={0.9} fill={`rgba(255,255,255,${a.toFixed(2)})`} />;
        })}
      </svg>
      <div className="flex justify-between text-[8px] text-white/30 tabular-nums mt-1">
        {Array.from({ length: n }, (_, i) => (
          <span key={i} style={{ width: `${100 / n}%`, textAlign: 'center', color: i === snap.activeBank ? '#fff' : undefined }}>
            {i + 1}
          </span>
        ))}
      </div>
      {snap.activeBreakdown && (
        <div className="flex gap-3 text-[10px] text-white/60 tabular-nums mt-1">
          <span className="text-white">{snap.activeBreakdown.total.toFixed(2)}</span>
          <span>α{Math.round(snap.activeBreakdown.channels * 100)}</span>
          <span>β{Math.round(snap.activeBreakdown.voiceType * 100)}</span>
          <span>γ{Math.round(snap.activeBreakdown.stepDensity * 100)}</span>
          <span>δ{Math.round(snap.activeBreakdown.mutation * 100)}</span>
          <span>ζ{Math.round(snap.activeBreakdown.polyphony * 100)}</span>
        </div>
      )}
    </div>
  );
}

export function Waiting() {
  return <div className="h-full flex items-center justify-center text-[8px] tracking-[0.16em] uppercase text-white/35">waiting for state</div>;
}
