import { useEffect, useRef } from 'react';

interface KnobProps {
  value: number;
  onChange: (next: number) => void;
  title?: string;
  size?: number;
  step?: number;
  pxPerUnit?: number;
  onModulationClick?: () => void;
  modulationLabel?: string;
  displayValue?: number;
  bipolar?: boolean;
}

export function Knob({
  value,
  onChange,
  title,
  size = 36,
  step = 0.05,
  pxPerUnit = 100,
  onModulationClick,
  modulationLabel,
  displayValue,
  bipolar = false,
}: KnobProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  valueRef.current = value;
  onChangeRef.current = onChange;
  const routing = !!onModulationClick;

  useEffect(() => {
    if (routing) return;
    const el = ref.current;
    if (!el) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const cur = valueRef.current;
      const delta = e.deltaY > 0 ? -step : step;
      const next = Math.max(0, Math.min(1, cur + delta));
      if (next !== cur) onChangeRef.current(next);
    };
    el.addEventListener('wheel', handleWheel, { passive: false });
    return () => el.removeEventListener('wheel', handleWheel);
  }, [step, routing]);

  const handleMouseDown = (e: React.MouseEvent) => {
    if (routing) {
      e.preventDefault();
      onModulationClick?.();
      return;
    }
    e.preventDefault();
    const startY = e.clientY;
    const startVal = valueRef.current;
    const onMove = (ev: MouseEvent) => {
      const dy = startY - ev.clientY;
      const next = Math.max(0, Math.min(1, startVal + dy / pxPerUnit));
      onChangeRef.current(next);
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const visual = displayValue ?? value;
  const angleDeg = -135 + 270 * visual;
  const angleRad = (angleDeg * Math.PI) / 180;
  const cx = size / 2;
  const cy = size / 2;
  const ringR = size * 0.36;
  const tickInner = size * 0.17;
  const tickOuter = ringR;
  const tx1 = cx + tickInner * Math.sin(angleRad);
  const ty1 = cy - tickInner * Math.cos(angleRad);
  const tx2 = cx + tickOuter * Math.sin(angleRad);
  const ty2 = cy - tickOuter * Math.cos(angleRad);

  // For bipolar knobs the indicator arc fills from center (0° = straight up)
  // outward in the direction the knob is turned. Unipolar arcs fill from the
  // start (-135°, hard left).
  const startDeg = bipolar ? 0 : -135;
  const startRad = (startDeg * Math.PI) / 180;
  const ax1 = cx + ringR * Math.sin(startRad);
  const ay1 = cy - ringR * Math.cos(startRad);
  const ax2 = cx + ringR * Math.sin(angleRad);
  const ay2 = cy - ringR * Math.cos(angleRad);
  const sweep = angleDeg >= startDeg ? 1 : 0;
  const largeArc = Math.abs(angleDeg - startDeg) > 180 ? 1 : 0;
  const arcPath = `M ${ax1} ${ay1} A ${ringR} ${ringR} 0 ${largeArc} ${sweep} ${ax2} ${ay2}`;
  const drawArc = bipolar ? Math.abs(visual - 0.5) > 0.001 : visual > 0;

  return (
    <button
      ref={ref}
      onMouseDown={handleMouseDown}
      style={{ width: size, height: size }}
      className={[
        'group relative bg-transparent flex items-center justify-center',
        routing ? 'cursor-crosshair' : 'cursor-ns-resize',
      ].join(' ')}
      title={title}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="absolute inset-0 pointer-events-none"
      >
        <circle
          cx={cx}
          cy={cy}
          r={ringR}
          fill="none"
          stroke="white"
          strokeOpacity={routing ? '0.4' : '0.12'}
          strokeWidth="1"
          className={routing ? '' : 'group-hover:[stroke-opacity:0.22] transition-[stroke-opacity]'}
        />
        {drawArc && (
          <path
            d={arcPath}
            fill="none"
            stroke="white"
            strokeOpacity="0.7"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        )}
        <line
          x1={tx1}
          y1={ty1}
          x2={tx2}
          y2={ty2}
          stroke="white"
          strokeOpacity="0.9"
          strokeWidth="1.75"
          strokeLinecap="round"
        />
        {modulationLabel && (
          <circle
            cx={size - 4}
            cy={4}
            r="2"
            fill="white"
            fillOpacity="0.9"
          />
        )}
      </svg>
    </button>
  );
}
